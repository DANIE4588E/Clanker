import type { Endpoint, SubscriptionAccount } from '../providers/types';
import type { SubscriptionUsage } from './usage';

/** Key used to index per-account usage, cooldowns, and last-used timestamps. */
export function accountUsageKey(endpointId: string, accountId: string): string {
  return `${endpointId}:${accountId}`;
}

/**
 * Returns the endpoint's configured accounts, synthesizing a legacy default account
 * for single-account endpoints created before multi-account support.
 */
export function accountsOf(
  endpoint: Pick<Endpoint, 'id' | 'name' | 'subscriptionAccount' | 'subscriptionPlan' | 'subscriptionAccounts'>
): SubscriptionAccount[] {
  if (endpoint.subscriptionAccounts?.length) return endpoint.subscriptionAccounts;
  return [
    {
      id: endpoint.id,
      label: endpoint.subscriptionAccount ?? endpoint.name,
      email: endpoint.subscriptionAccount,
      plan: endpoint.subscriptionPlan,
      addedAt: 0,
    },
  ];
}

// In-memory runtime state for load balancing (cooldowns after 429 and LRU tie-breaking).
const cooldownUntil = new Map<string, number>();
const lastUsedAt = new Map<string, number>();

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function markAccountRateLimited(endpointId: string, accountId: string, retryAfterMs?: number, now = Date.now()) {
  const duration = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS;
  cooldownUntil.set(accountUsageKey(endpointId, accountId), now + duration);
}

export function clearAccountCooldown(endpointId: string, accountId: string) {
  cooldownUntil.delete(accountUsageKey(endpointId, accountId));
}

export function markAccountUsed(endpointId: string, accountId: string, now = Date.now()) {
  lastUsedAt.set(accountUsageKey(endpointId, accountId), now);
}

export function isAccountCoolingDown(endpointId: string, accountId: string, now = Date.now()): boolean {
  const until = cooldownUntil.get(accountUsageKey(endpointId, accountId));
  if (!until) return false;
  if (now >= until) {
    cooldownUntil.delete(accountUsageKey(endpointId, accountId));
    return false;
  }
  return true;
}

/**
 * Scores an account's remaining capacity (0–100) for auto load balancing.
 * Uses the bottleneck (minimum) window across primary & secondary rolling windows
 * so an account with depleted weekly quota isn't preferred over a fresh one.
 * Unknown usage gets a neutral score of 50.
 */
export function accountRemainingScore(usage: SubscriptionUsage | undefined): number {
  if (!usage?.windows.length) return 50;
  // Consider primary & secondary rolling windows (first two); ignore narrow model-specific sub-windows unless none else.
  const main = usage.windows.slice(0, 2);
  const minPct = Math.min(...main.map((w) => w.remainingPercent));
  const primaryPct = main[0]?.remainingPercent ?? minPct;
  // Bottleneck dominates; tiny primary tie-breaker (at most 0.5).
  return minPct + primaryPct * 0.005;
}

export type AccountOrderOptions = {
  byAccount: Record<string, SubscriptionUsage>;
  model?: string;
  exclude?: Set<string>;
  now?: number;
  cooldownMap?: Map<string, number>;
  lastUsedMap?: Map<string, number>;
};

/**
 * Orders candidate accounts to try for a request:
 * - In `manual` mode: returns ONLY the chosen account (falling back to the first account if unset).
 * - In `auto` mode: sorts available accounts by:
 *   1. Not currently rate-limit cooling down
 *   2. Highest remaining quota score (tie within 2% broken by least-recently-used for even spreading)
 *   3. Least recently used timestamp
 */
export function rankSubscriptionAccounts(
  endpoint: Pick<
    Endpoint,
    'id' | 'name' | 'accountMode' | 'activeAccountId' | 'subscriptionAccount' | 'subscriptionPlan' | 'subscriptionAccounts'
  >,
  opts: AccountOrderOptions
): SubscriptionAccount[] {
  const accounts = accountsOf(endpoint).filter((a) => !opts.exclude?.has(a.id));
  if (!accounts.length) return [];

  if (endpoint.accountMode === 'manual') {
    const chosen = accounts.find((a) => a.id === endpoint.activeAccountId) ?? accounts[0];
    return [chosen];
  }

  const now = opts.now ?? Date.now();
  const cd = opts.cooldownMap ?? cooldownUntil;
  const lru = opts.lastUsedMap ?? lastUsedAt;

  return [...accounts].sort((a, b) => {
    const ka = accountUsageKey(endpoint.id, a.id);
    const kb = accountUsageKey(endpoint.id, b.id);
    const coolA = (cd.get(ka) ?? 0) > now ? 1 : 0;
    const coolB = (cd.get(kb) ?? 0) > now ? 1 : 0;
    if (coolA !== coolB) return coolA - coolB;

    const scoreA = accountRemainingScore(opts.byAccount[ka]);
    const scoreB = accountRemainingScore(opts.byAccount[kb]);
    // Treat scores within 2 percentage points as effectively tied so LRU spreads traffic evenly.
    if (Math.abs(scoreB - scoreA) > 2) return scoreB - scoreA;

    const usedA = lru.get(ka) ?? 0;
    const usedB = lru.get(kb) ?? 0;
    if (usedA !== usedB) return usedA - usedB;

    return scoreB - scoreA;
  });
}

/**
 * Picks the account whose remaining usage best represents the endpoint right now in UI summaries
 * (selected account in manual mode; highest-remaining account in auto mode).
 */
export function primaryDisplayAccount(
  endpoint: Pick<
    Endpoint,
    'id' | 'name' | 'accountMode' | 'activeAccountId' | 'subscriptionAccount' | 'subscriptionPlan' | 'subscriptionAccounts'
  >,
  byAccount: Record<string, SubscriptionUsage>,
  model?: string
): { account: SubscriptionAccount; usage?: SubscriptionUsage } {
  const ranked = rankSubscriptionAccounts(endpoint, { byAccount, model });
  const account = ranked[0] ?? accountsOf(endpoint)[0];
  return {
    account,
    usage: byAccount[accountUsageKey(endpoint.id, account.id)],
  };
}

/** Parses an HTTP Retry-After header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(headers?: { get(name: string): string | null }): number | undefined {
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 60 * 60 * 1000);
  const ts = Date.parse(raw);
  if (Number.isFinite(ts) && ts > Date.now()) return Math.min(ts - Date.now(), 60 * 60 * 1000);
  return undefined;
}
