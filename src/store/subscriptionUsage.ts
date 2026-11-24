import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isSubscriptionType, type Endpoint, type SubscriptionAccount } from '@/lib/providers/types';
import { jsonFileStorage } from '@/lib/storage';
import {
  accountsOf,
  accountUsageKey,
  fetchSubscriptionUsage,
  type SubscriptionCredentials,
  type SubscriptionUsage,
} from '@/lib/subscriptions';

// Avoid hammering undocumented quota endpoints when navigating quickly between screens.
const FRESH_MS = 60_000;

const inflight = new Map<string, Promise<SubscriptionUsage | null>>();

type EndpointLike = Pick<
  Endpoint,
  'id' | 'name' | 'type' | 'subscriptionAccount' | 'subscriptionPlan' | 'subscriptionAccounts'
>;

interface SubscriptionUsageState {
  /** Keyed by `accountUsageKey(endpointId, accountId)`. */
  byAccount: Record<string, SubscriptionUsage>;
  /** Keyed by `accountUsageKey(endpointId, accountId)`. */
  loading: Record<string, boolean>;
  /** Last account id that served a request for each endpoint id. */
  lastUsedAccount: Record<string, string>;
  setAccountUsage: (endpointId: string, accountId: string, usage: SubscriptionUsage) => void;
  setAccountError: (endpointId: string, accountId: string, error: string) => void;
  setLastUsedAccount: (endpointId: string, accountId: string) => void;
  removeAccountUsage: (endpointId: string, accountId: string) => void;
  removeEndpointUsage: (endpointId: string) => void;
  refreshAccount: (
    endpoint: Pick<Endpoint, 'id' | 'type'>,
    account: Pick<SubscriptionAccount, 'id'>,
    opts?: { force?: boolean; creds?: SubscriptionCredentials }
  ) => Promise<SubscriptionUsage | null>;
  refresh: (
    endpoint: EndpointLike,
    opts?: { force?: boolean; accountId?: string }
  ) => Promise<void>;
}

export const useSubscriptionUsage = create<SubscriptionUsageState>()(
  persist(
    (set, get) => ({
      byAccount: {},
      loading: {},
      lastUsedAccount: {},
      setAccountUsage: (endpointId, accountId, usage) => {
        const key = accountUsageKey(endpointId, accountId);
        set((s) => ({ byAccount: { ...s.byAccount, [key]: usage } }));
      },
      setAccountError: (endpointId, accountId, error) => {
        const key = accountUsageKey(endpointId, accountId);
        set((s) => {
          const prev = s.byAccount[key];
          return {
            byAccount: {
              ...s.byAccount,
              [key]: {
                ...(prev ?? { windows: [], fetchedAt: Date.now() }),
                error,
              },
            },
          };
        });
      },
      setLastUsedAccount: (endpointId, accountId) =>
        set((s) => ({ lastUsedAccount: { ...s.lastUsedAccount, [endpointId]: accountId } })),
      removeAccountUsage: (endpointId, accountId) => {
        const key = accountUsageKey(endpointId, accountId);
        set((s) => {
          const { [key]: _, ...byAccount } = s.byAccount;
          const { [key]: __, ...loading } = s.loading;
          return { byAccount, loading };
        });
      },
      removeEndpointUsage: (endpointId) => {
        const prefix = `${endpointId}:`;
        set((s) => {
          const byAccount = Object.fromEntries(Object.entries(s.byAccount).filter(([k]) => !k.startsWith(prefix)));
          const loading = Object.fromEntries(Object.entries(s.loading).filter(([k]) => !k.startsWith(prefix)));
          const { [endpointId]: _, ...lastUsedAccount } = s.lastUsedAccount;
          return { byAccount, loading, lastUsedAccount };
        });
      },
      refreshAccount: async (endpoint, account, opts) => {
        if (!isSubscriptionType(endpoint.type)) return null;
        const key = accountUsageKey(endpoint.id, account.id);
        const current = get().byAccount[key];
        if (!opts?.force && !opts?.creds && current && !current.error && Date.now() - current.fetchedAt < FRESH_MS) {
          return current;
        }
        const existing = inflight.get(key);
        if (existing) return existing;

        set((s) => ({ loading: { ...s.loading, [key]: true } }));
        const task = fetchSubscriptionUsage(endpoint, {
          accountId: account.id,
          credsOverride: opts?.creds,
        })
          .then((usage) => {
            get().setAccountUsage(endpoint.id, account.id, usage);
            return usage;
          })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            get().setAccountError(endpoint.id, account.id, msg);
            return null;
          })
          .finally(() => {
            if (inflight.get(key) === task) inflight.delete(key);
            set((s) => {
              const { [key]: _, ...loading } = s.loading;
              return { loading };
            });
          });
        inflight.set(key, task);
        return task;
      },
      refresh: async (endpoint, opts) => {
        if (!isSubscriptionType(endpoint.type)) return;
        const accounts = accountsOf(endpoint);
        const targets = opts?.accountId ? accounts.filter((a) => a.id === opts.accountId) : accounts;
        await Promise.all(targets.map((a) => get().refreshAccount(endpoint, a, { force: opts?.force })));
      },
    }),
    {
      name: 'subscription-usage',
      storage: jsonFileStorage,
      version: 2,
      partialize: (state) => ({ byAccount: state.byAccount, lastUsedAccount: state.lastUsedAccount }),
      migrate: (persisted, version) => {
        const state = persisted as {
          byEndpoint?: Record<string, SubscriptionUsage>;
          byAccount?: Record<string, SubscriptionUsage>;
          lastUsedAccount?: Record<string, string>;
        };
        if (version < 2 && state?.byEndpoint && !state.byAccount) {
          const byAccount: Record<string, SubscriptionUsage> = {};
          for (const [endpointId, usage] of Object.entries(state.byEndpoint)) {
            byAccount[accountUsageKey(endpointId, endpointId)] = usage;
          }
          return { byAccount, lastUsedAccount: {} };
        }
        return {
          byAccount: state?.byAccount ?? {},
          lastUsedAccount: state?.lastUsedAccount ?? {},
        };
      },
    }
  )
);
