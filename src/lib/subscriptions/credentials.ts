import * as SecureStore from 'expo-secure-store';

export type SubscriptionCredentials = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when `accessToken` expires. */
  expiresAt?: number;
  /** OpenAI ChatGPT workspace/account id extracted from the JWT. */
  accountId?: string;
  /** Signed-in email address, for display only. */
  email?: string;
  /** Subscription tier/plan label (e.g. plus, pro, max). */
  plan?: string;
};

// Keep each SecureStore item safely under Android's 2048-byte limit. The chunked helpers are also
// used for other secrets (lib/secrets).
const CHUNK_SIZE = 1600;
const CHUNK_PREFIX = 'chunks:';

export async function setChunked(key: string, value: string | undefined) {
  await deleteChunked(key);
  if (!value) return;
  if (value.length <= CHUNK_SIZE) {
    await SecureStore.setItemAsync(key, value);
    return;
  }
  const count = Math.ceil(value.length / CHUNK_SIZE);
  for (let i = 0; i < count; i++) {
    await SecureStore.setItemAsync(`${key}_${i}`, value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  }
  await SecureStore.setItemAsync(key, `${CHUNK_PREFIX}${count}`);
}

export async function getChunked(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(key);
  if (!head) return null;
  if (!head.startsWith(CHUNK_PREFIX)) return head;
  const count = parseInt(head.slice(CHUNK_PREFIX.length), 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  const parts = await Promise.all(Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(`${key}_${i}`)));
  if (parts.some((p) => p == null)) return null;
  return parts.join('');
}

export async function deleteChunked(key: string) {
  const head = await SecureStore.getItemAsync(key).catch(() => null);
  if (head?.startsWith(CHUNK_PREFIX)) {
    const count = parseInt(head.slice(CHUNK_PREFIX.length), 10);
    if (Number.isFinite(count) && count > 0) {
      await Promise.all(
        Array.from({ length: count }, (_, i) => SecureStore.deleteItemAsync(`${key}_${i}`).catch(() => {}))
      );
    }
  }
  await SecureStore.deleteItemAsync(key).catch(() => {});
}

/**
 * Storage slot for an endpoint's account.
 * When `accountId` is omitted or matches `endpointId`, uses the legacy single-account key
 * so existing single-account logins keep working seamlessly.
 */
export function credentialSlot(endpointId: string, accountId?: string): string {
  if (!accountId || accountId === endpointId) return endpointId;
  return `${endpointId}_${accountId}`;
}

const atKey = (slot: string) => `sub_at_${slot}`;
const rtKey = (slot: string) => `sub_rt_${slot}`;
const metaKey = (slot: string) => `sub_meta_${slot}`;

/** Stores subscription OAuth tokens securely in the device keychain, per account. */
export const subscriptionAuth = {
  async get(endpointId: string, accountId?: string): Promise<SubscriptionCredentials | null> {
    const slot = credentialSlot(endpointId, accountId);
    const [accessToken, refreshToken, metaRaw] = await Promise.all([
      getChunked(atKey(slot)),
      getChunked(rtKey(slot)),
      SecureStore.getItemAsync(metaKey(slot)),
    ]);
    if (!accessToken && !refreshToken) return null;
    let meta: Partial<SubscriptionCredentials> = {};
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw);
      } catch {}
    }
    return {
      accessToken: accessToken ?? '',
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof meta.expiresAt === 'number' ? { expiresAt: meta.expiresAt } : {}),
      ...(meta.accountId ? { accountId: meta.accountId } : {}),
      ...(meta.email ? { email: meta.email } : {}),
      ...(meta.plan ? { plan: meta.plan } : {}),
    };
  },

  async set(endpointId: string, creds: SubscriptionCredentials, accountId?: string): Promise<void> {
    const slot = credentialSlot(endpointId, accountId);
    const meta = {
      ...(typeof creds.expiresAt === 'number' ? { expiresAt: creds.expiresAt } : {}),
      ...(creds.accountId ? { accountId: creds.accountId } : {}),
      ...(creds.email ? { email: creds.email } : {}),
      ...(creds.plan ? { plan: creds.plan } : {}),
    };
    await Promise.all([
      setChunked(atKey(slot), creds.accessToken),
      setChunked(rtKey(slot), creds.refreshToken),
      SecureStore.setItemAsync(metaKey(slot), JSON.stringify(meta)),
    ]);
  },

  async remove(endpointId: string, accountId?: string): Promise<void> {
    const slot = credentialSlot(endpointId, accountId);
    await Promise.all([
      deleteChunked(atKey(slot)),
      deleteChunked(rtKey(slot)),
      SecureStore.deleteItemAsync(metaKey(slot)).catch(() => {}),
    ]);
  },

  async removeAll(endpointId: string, accountIds: string[] = []): Promise<void> {
    const slots = new Set([endpointId, ...accountIds.map((id) => credentialSlot(endpointId, id))]);
    await Promise.all(
      [...slots].map((slot) =>
        Promise.all([
          deleteChunked(atKey(slot)),
          deleteChunked(rtKey(slot)),
          SecureStore.deleteItemAsync(metaKey(slot)).catch(() => {}),
        ])
      )
    );
  },
};

// Deduplicate concurrent token refreshes per account slot so rotating refresh tokens don't race.
const inflightRefresh = new Map<string, Promise<SubscriptionCredentials>>();

export function runExclusiveRefresh(
  slot: string,
  fn: () => Promise<SubscriptionCredentials>
): Promise<SubscriptionCredentials> {
  const existing = inflightRefresh.get(slot);
  if (existing) return existing;
  const promise = fn().finally(() => {
    if (inflightRefresh.get(slot) === promise) inflightRefresh.delete(slot);
  });
  inflightRefresh.set(slot, promise);
  return promise;
}
