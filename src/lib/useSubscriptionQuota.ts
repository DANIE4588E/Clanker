import { useCallback, useEffect, useMemo } from 'react';
import { isSubscriptionType, type Endpoint, type SubscriptionAccount } from '@/lib/providers';
import { accountsOf, accountUsageKey, primaryDisplayAccount } from '@/lib/subscriptions/router';
import type { SubscriptionUsage } from '@/lib/subscriptions/usage';
import { useSettings } from '@/store/settings';
import { useSubscriptionUsage } from '@/store/subscriptionUsage';

export type SubscriptionQuota = {
  endpoint: Endpoint;
  /** The account the next request goes to: the chosen one, or the best ranked in auto mode. */
  account: SubscriptionAccount;
  /** More than one account is signed in, so which one is shown is worth naming. */
  multiAccount: boolean;
  usage?: SubscriptionUsage;
  loading: boolean;
  /** Fetches fresh numbers; without `force` it is skipped while the last fetch is still recent. */
  refresh: (force?: boolean) => void;
};

/**
 * Remaining quota for the selected model when it runs on a subscription, or null (remote chats,
 * API-key endpoints). Fetches it when the subscription comes into use.
 */
export function useSubscriptionQuota(enabled: boolean): SubscriptionQuota | null {
  const model = useSettings((s) => s.active?.model);
  const endpoint = useSettings((s) => s.endpoints.find((e) => e.id === s.active?.endpointId));
  const sub = enabled && endpoint && isSubscriptionType(endpoint.type) ? endpoint : undefined;
  const byAccount = useSubscriptionUsage((s) => s.byAccount);
  const loadingByAccount = useSubscriptionUsage((s) => s.loading);

  useEffect(() => {
    if (sub) void useSubscriptionUsage.getState().refresh(sub);
  }, [sub]);

  const refresh = useCallback(
    (force?: boolean) => {
      if (sub) void useSubscriptionUsage.getState().refresh(sub, { force });
    },
    [sub]
  );

  return useMemo(() => {
    if (!sub) return null;
    const accounts = accountsOf(sub);
    const { account, usage } = primaryDisplayAccount(sub, byAccount, model);
    return {
      endpoint: sub,
      account,
      multiAccount: accounts.length > 1,
      usage,
      loading: accounts.some((a) => !!loadingByAccount[accountUsageKey(sub.id, a.id)]),
      refresh,
    };
  }, [sub, byAccount, loadingByAccount, model, refresh]);
}
