import { useSubscriptionUsage } from '@/store/subscriptionUsage';
import {
  clearAccountCooldown,
  markAccountRateLimited,
  markAccountUsed,
  rankSubscriptionAccounts,
} from '../subscriptions';
import { ProviderError } from './http';
import type { Endpoint, SubscriptionAccount } from './types';

function isRetryableAccountError(e: unknown): e is ProviderError {
  if (!(e instanceof ProviderError)) return false;
  // 429 = rate-limit / quota exhausted; 401 = expired/revoked account session.
  return e.status === 429 || e.status === 401;
}

/**
 * Executes a subscription request against the chosen account(s):
 * - In `manual` mode, runs only against the selected account.
 * - In `auto` mode, ranks accounts by remaining quota & LRU, and fails over to the next
 *   account on 429 (rate limit) or 401 (expired session) as long as nothing has streamed yet.
 */
export async function withSubscriptionAccount<T>(
  endpoint: Endpoint,
  opts: {
    model?: string;
    signal?: AbortSignal;
    hasStarted?: () => boolean;
  },
  run: (account: SubscriptionAccount) => Promise<T>
): Promise<T> {
  const usageStore = useSubscriptionUsage.getState();
  const candidates = rankSubscriptionAccounts(endpoint, {
    byAccount: usageStore.byAccount,
    model: opts.model,
  });
  if (!candidates.length) {
    throw new ProviderError('No signed-in account for this subscription. Sign in from Settings → Providers.', 401);
  }

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const account = candidates[i];
    if (opts.signal?.aborted) throw new Error('Aborted');
    markAccountUsed(endpoint.id, account.id);
    useSubscriptionUsage.getState().setLastUsedAccount(endpoint.id, account.id);
    try {
      const result = await run(account);
      clearAccountCooldown(endpoint.id, account.id);
      return result;
    } catch (e) {
      lastError = e;
      const canFailover =
        endpoint.accountMode !== 'manual' &&
        i < candidates.length - 1 &&
        !opts.signal?.aborted &&
        !(opts.hasStarted?.() ?? false) &&
        isRetryableAccountError(e);
      if (e instanceof ProviderError && e.status === 429) {
        markAccountRateLimited(endpoint.id, account.id, e.retryAfterMs);
      }
      if (!canFailover) throw e;
    }
  }
  throw lastError;
}
