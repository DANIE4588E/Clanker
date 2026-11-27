import type { Endpoint } from './providers/types';
import { deleteChunked, getChunked, setChunked } from './subscriptions/credentials';

/**
 * Secrets that live in a persisted zustand store's state while the app runs (so code reads them
 * synchronously, as before) but are kept in the keychain rather than the store's JSON file.
 *
 * - On launch, the secrets are read from the keychain and put back into the state.
 * - Whenever the state changes, new or changed secrets are written to the keychain and removed ones
 *   deleted from it.
 * - The store's `partialize` leaves a secret out of the JSON only once `isSaved` confirms that exact
 *   value is in the keychain. So secrets saved in plaintext by older versions move over on the first
 *   launch, and if writing to the keychain fails they stay where they were and are tried again later,
 *   rather than being lost.
 */

/** Keychain keys may only contain letters, digits, ".", "-" and "_". */
export const secretKey = (...parts: string[]) => parts.map((p) => p.replace(/[^A-Za-z0-9._-]/g, '_')).join('_');

export type SecretSpec<S> = {
  /** Every keychain key that may hold a secret for this state, whether or not its value is in memory. */
  slots: (state: S) => string[];
  /** The secrets in memory, by keychain key. */
  values: (state: S) => Record<string, string>;
  /** A patch putting secrets read from the keychain back where the state has none, or null for no change. */
  restore: (state: S, loaded: Map<string, string>) => Partial<S> | null;
};

// Method syntax, so a store whose state has more fields than S fits.
type PersistedStore<S> = {
  getState(): S;
  setState(partial: Partial<S>): void;
  subscribe(listener: (state: S) => void): () => void;
  persist: { hasHydrated(): boolean; onFinishHydration(fn: (state: S) => void): () => void };
};

/** How long anything waits for the keychain on launch before going ahead without it. */
const READY_TIMEOUT_MS = 5000;

export class SecretMirror<S> {
  /** What the keychain holds, as last read or written. */
  private saved = new Map<string, string>();
  private attached = false;
  private loaded = false;
  private resolveReady!: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => (this.resolveReady = resolve));
  private syncing: Promise<void> | null = null;
  private again = false;

  constructor(private readonly spec: SecretSpec<S>) {}

  /** Whether exactly this value is in the keychain, so the persisted state can leave it out. */
  isSaved(slot: string, value: string) {
    return this.saved.get(slot) === value;
  }

  /** The value the keychain holds for a slot, once loaded. */
  value(slot: string) {
    return this.saved.get(slot);
  }

  /** Whether the secrets have been read from the keychain (or there was nothing to wait for). */
  isReady() {
    return this.loaded || !this.attached;
  }

  /** Resolves once the secrets have been read from the keychain into the state. */
  ready(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return Promise.race([this.readyPromise, new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS))]);
  }

  /** Starts mirroring the store's secrets, once it has rehydrated. */
  attach(store: PersistedStore<S>) {
    if (this.attached) return;
    this.attached = true;
    const start = () => void this.start(store);
    if (store.persist.hasHydrated()) start();
    else store.persist.onFinishHydration(start);
  }

  private async start(store: PersistedStore<S>) {
    try {
      const loaded = new Map<string, string>();
      await Promise.all(
        [...new Set(this.spec.slots(store.getState()))].map(async (slot) => {
          const value = await getChunked(slot).catch(() => null);
          if (value != null) loaded.set(slot, value);
        })
      );
      for (const [slot, value] of loaded) this.saved.set(slot, value);
      const patch = this.spec.restore(store.getState(), loaded);
      if (patch) store.setState(patch);
    } catch {
      // The state keeps whatever it has; requests go ahead without the missing secrets.
    } finally {
      this.loaded = true;
      this.resolveReady();
    }
    store.subscribe(() => void this.sync(store));
    await this.sync(store);
  }

  /** Writes changed secrets to the keychain, one pass at a time. */
  private sync(store: PersistedStore<S>): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.again = false;
          await this.syncOnce(store);
        } while (this.again);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(store: PersistedStore<S>) {
    const values = this.spec.values(store.getState());
    let moved = false;
    for (const [slot, value] of Object.entries(values)) {
      if (this.saved.get(slot) === value) continue;
      try {
        await setChunked(slot, value);
        this.saved.set(slot, value);
        moved = true;
      } catch {
        // Stays in the store's file for now; tried again on the next change or launch.
      }
    }
    for (const slot of [...this.saved.keys()]) {
      if (slot in values) continue;
      await deleteChunked(slot);
      this.saved.delete(slot);
    }
    // Saves the store again, now leaving out what the keychain holds.
    if (moved) store.setState({});
  }
}

// ---- Endpoint headers ---------------------------------------------------------------------------

/**
 * An endpoint's extra HTTP headers (often Authorization or Cloudflare Access secrets) are kept in
 * the keychain as one JSON record per endpoint; settings.json keeps none of them.
 */
export const endpointHeadersSlot = (endpointId: string) => secretKey('endpoint_headers', endpointId);

type HeadersRecord = Record<string, string>;

function parseHeadersRecord(text: string): HeadersRecord | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as HeadersRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** The headers as the keychain stores them, or undefined when there are none. */
export function headersSecret(headers: HeadersRecord | undefined) {
  return headers && Object.keys(headers).length ? JSON.stringify(headers) : undefined;
}

type EndpointLike = { id: string; headers?: HeadersRecord };

export const endpointHeaderSecrets = new SecretMirror<{ endpoints: Endpoint[] }>({
  slots: (s) => s.endpoints.map((e) => endpointHeadersSlot(e.id)),
  values: (s) =>
    Object.fromEntries(
      s.endpoints.flatMap((e) => {
        const value = headersSecret(e.headers);
        return value ? [[endpointHeadersSlot(e.id), value]] : [];
      })
    ),
  restore: (s, loaded) => {
    let changed = false;
    const endpoints = s.endpoints.map((e) => {
      const saved = e.headers === undefined ? loaded.get(endpointHeadersSlot(e.id)) : undefined;
      const headers = saved ? parseHeadersRecord(saved) : undefined;
      if (!headers) return e;
      changed = true;
      return { ...e, headers };
    });
    return changed ? { endpoints } : null;
  },
});

/** The endpoint as settings.json saves it: without headers once the keychain has them. */
export function persistedEndpoint<E extends EndpointLike>(endpoint: E): E {
  const { headers, ...rest } = endpoint;
  const value = headersSecret(headers);
  if (!value || endpointHeaderSecrets.isSaved(endpointHeadersSlot(endpoint.id), value)) return rest as E;
  return endpoint;
}

/**
 * The endpoint with its saved headers, for a request. Endpoints read from the store before the
 * keychain was (just after launch) have none yet; an endpoint that has headers, even an empty set
 * from the editor, is used as it is.
 */
export async function withSavedHeaders<E extends EndpointLike>(endpoint: E): Promise<E> {
  if (endpoint.headers !== undefined) return endpoint;
  await endpointHeaderSecrets.ready();
  const saved = endpointHeaderSecrets.value(endpointHeadersSlot(endpoint.id));
  const headers = saved ? parseHeadersRecord(saved) : undefined;
  return headers ? { ...endpoint, headers } : endpoint;
}
