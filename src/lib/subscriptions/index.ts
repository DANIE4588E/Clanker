import { fetch } from '@/lib/net';
import type { BrandId } from '../modelNames';
import { ProviderError } from '../providers/http';
import type { Endpoint, SubscriptionType } from '../providers/types';
import { credentialSlot, runExclusiveRefresh, subscriptionAuth, type SubscriptionCredentials } from './credentials';
import { refreshSubscriptionCredentials } from './oauth';
import { parseClaudeUsage, parseCodexUsage, type SubscriptionUsage } from './usage';

export const SUBSCRIPTION_TYPES: SubscriptionType[] = ['codex', 'claude'];

export type SubscriptionMeta = {
  type: SubscriptionType;
  name: string;
  brand: BrandId;
  baseUrl: string;
  subtitle: string;
  signInLabel: string;
  importPlaceholder: string;
  importHint: string;
};

export const SUBSCRIPTION_META: Record<SubscriptionType, SubscriptionMeta> = {
  codex: {
    type: 'codex',
    name: 'Codex',
    brand: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    subtitle: 'ChatGPT Plus, Pro or Team subscription',
    signInLabel: 'Sign in with ChatGPT',
    importPlaceholder: 'Paste ~/.codex/auth.json or token',
    importHint: 'Use this if your workspace disables device sign-in, or to reuse an existing Codex CLI login.',
  },
  claude: {
    type: 'claude',
    name: 'Claude',
    brand: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    subtitle: 'Claude Pro or Max subscription',
    signInLabel: 'Sign in with Claude',
    importPlaceholder: 'Paste ~/.claude/.credentials.json or sk-ant-oat01-…',
    importHint: 'Reuse an existing Claude Code login from ~/.claude/.credentials.json if preferred.',
  },
};

export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.331';
export const CLAUDE_CODE_USER_AGENT = claudeCodeUserAgent(DEFAULT_CLAUDE_CODE_VERSION);
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_MESSAGES_BETA = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';

const CLAUDE_VERSION_CACHE_MS = 6 * 60 * 60 * 1000;
let cachedClaudeVersion: { version: string; at: number } | null = null;

export function claudeCodeUserAgent(version = DEFAULT_CLAUDE_CODE_VERSION): string {
  return `claude-cli/${version} (external, cli)`;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function maxSemver(...versions: (string | undefined)[]): string {
  let best = DEFAULT_CLAUDE_CODE_VERSION;
  for (const raw of versions) {
    const m = raw?.trim().match(/^(\d+\.\d+\.\d+)/);
    if (m && compareSemver(m[1], best) > 0) best = m[1];
  }
  return best;
}

/** Extracts the minimum Claude Code version from Anthropic's 400 client-version gate error, if present. */
export function parseRequiredClaudeCodeVersion(message: string): string | null {
  const m = message.match(/version\s+(\d+\.\d+\.\d+)\s+or\s+newer\s+is\s+required/i);
  return m ? m[1] : null;
}

/** Returns the best known Claude Code CLI version synchronously without network latency. */
export function getCachedClaudeCodeVersion(): string {
  return maxSemver(cachedClaudeVersion?.version);
}

/**
 * Resolves the latest published `@anthropic-ai/claude-code` version (cached for 6h, 2.5s timeout)
 * so Anthropic's minimum Claude Code version checks don't block newly released models.
 */
export async function resolveClaudeCodeVersion(opts?: { force?: boolean; minVersion?: string }): Promise<string> {
  const floor = maxSemver(cachedClaudeVersion?.version, opts?.minVersion);
  if (!opts?.force && cachedClaudeVersion && Date.now() - cachedClaudeVersion.at < CLAUDE_VERSION_CACHE_MS) {
    if (compareSemver(floor, cachedClaudeVersion.version) > 0) {
      cachedClaudeVersion = { version: floor, at: Date.now() };
    }
    return floor;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.ok) {
      const json = (await res.json()) as { version?: unknown };
      if (typeof json?.version === 'string' && /^\d+\.\d+\.\d+/.test(json.version.trim())) {
        const version = maxSemver(json.version, floor);
        cachedClaudeVersion = { version, at: Date.now() };
        return version;
      }
    }
  } catch {
    // Offline or slow registry: fall back to the bundled / required version.
  } finally {
    clearTimeout(timer);
  }
  if (opts?.minVersion) {
    cachedClaudeVersion = { version: floor, at: Date.now() };
  }
  return floor;
}

// Refresh tokens slightly before they expire to avoid mid-turn 401s.
const REFRESH_SKEW_MS = 2 * 60 * 1000;

/**
 * Loads valid OAuth credentials for a subscription account, refreshing automatically
 * when expired (or when `forceRefresh` is true after a 401).
 */
export async function getValidCredentials(
  endpoint: Pick<Endpoint, 'id' | 'type'>,
  opts?: { accountId?: string; forceRefresh?: boolean; override?: SubscriptionCredentials }
): Promise<SubscriptionCredentials> {
  const type = endpoint.type as SubscriptionType;
  const accountId = opts?.accountId;
  const slot = credentialSlot(endpoint.id, accountId);
  const stored = opts?.override ?? (await subscriptionAuth.get(endpoint.id, accountId));
  if (!stored) {
    throw new ProviderError(`Not signed in to ${SUBSCRIPTION_META[type].name}. Sign in from Settings → Providers.`, 401);
  }
  const needsRefresh =
    opts?.forceRefresh ||
    !stored.accessToken ||
    (typeof stored.expiresAt === 'number' && Date.now() >= stored.expiresAt - REFRESH_SKEW_MS);

  if (!needsRefresh) return stored;
  if (!stored.refreshToken) {
    if (stored.accessToken && !opts?.forceRefresh) return stored;
    throw new ProviderError(`${SUBSCRIPTION_META[type].name} session expired. Sign in again in Settings.`, 401);
  }

  return runExclusiveRefresh(slot, async () => {
    // Re-read inside the lock in case another caller just refreshed.
    const latest = opts?.override ? stored : (await subscriptionAuth.get(endpoint.id, accountId)) ?? stored;
    if (
      !opts?.forceRefresh &&
      latest.accessToken &&
      typeof latest.expiresAt === 'number' &&
      Date.now() < latest.expiresAt - REFRESH_SKEW_MS
    ) {
      return latest;
    }
    const refreshed = await refreshSubscriptionCredentials(type, latest);
    if (!opts?.override) await subscriptionAuth.set(endpoint.id, refreshed, accountId);
    return refreshed;
  });
}

async function usageError(label: string, res: { status: number; text(): Promise<string> }) {
  const body = await res.text().catch(() => '');
  let detail = '';
  try {
    const json = JSON.parse(body);
    const err = Array.isArray(json) ? json[0]?.error : json.error;
    detail = (typeof err === 'string' ? err : err?.message) ?? json.message ?? '';
  } catch {
    detail = body.trim().slice(0, 180);
  }
  return new ProviderError(`${label} (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
}

/** Fetches the live remaining-usage windows for a specific subscription account. */
export async function fetchSubscriptionUsage(
  endpoint: Pick<Endpoint, 'id' | 'type'>,
  opts?: { accountId?: string; credsOverride?: SubscriptionCredentials }
): Promise<SubscriptionUsage> {
  const type = endpoint.type as SubscriptionType;
  const accountId = opts?.accountId;

  const run = async (forceRefresh: boolean): Promise<SubscriptionUsage> => {
    const creds = await getValidCredentials(endpoint, { accountId, forceRefresh, override: opts?.credsOverride });
    if (type === 'codex') {
      const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          Accept: 'application/json',
          ...(creds.accountId ? { 'ChatGPT-Account-Id': creds.accountId } : {}),
        },
      });
      if (res.status === 401 && !forceRefresh && creds.refreshToken) return run(true);
      if (!res.ok) throw await usageError('Codex usage check failed', res);
      return parseCodexUsage(await res.json());
    }

    const clientVersion = await resolveClaudeCodeVersion();
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'User-Agent': claudeCodeUserAgent(clientVersion),
        Accept: 'application/json',
      },
    });
    if (res.status === 401 && !forceRefresh && creds.refreshToken) return run(true);
    if (!res.ok) throw await usageError('Claude usage check failed', res);
    const parsed = parseClaudeUsage(await res.json());
    return { ...parsed, email: parsed.email ?? creds.email, plan: parsed.plan ?? creds.plan };
  };

  return run(false);
}

export * from './credentials';
export * from './oauth';
export * from './pkce';
export * from './router';
export * from './usage';
