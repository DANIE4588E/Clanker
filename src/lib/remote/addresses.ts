import { bridgeTime, clockOffset, EMPTY_SHA256, setClockOffset, signRequest, supportsSigning, verifyResponseSignature } from './signing';
import type { BridgeInfo, RemoteBackend } from './types';

type Connection = { url: string; info: BridgeInfo };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const known = new Map<string, { token: string; at: number; connection: Connection }>();

export function bridgeAddresses(backend: Pick<RemoteBackend, 'baseUrl' | 'altBaseUrls'>) {
  return [...new Set([backend.baseUrl, ...(backend.altBaseUrls ?? [])].map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean))].map((value) => {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Use HTTP(S) bridge addresses without credentials or query parameters.');
    }
    return value;
  });
}

const key = (backend: RemoteBackend) => JSON.stringify([backend.id, backend.bridgeId, ...bridgeAddresses(backend)]);
export const forgetBridgeAddress = (backend: RemoteBackend) => known.delete(key(backend));
const UPDATE_BRIDGE = 'Update the bridge on the host (or its Hermes/Harness plugin), then try again.';

async function errorText(response: Response) {
  const body = await response.text().catch(() => '');
  try { return String(JSON.parse(body).error ?? body); } catch { return body; }
}

/** Asks one address for its capabilities, signed, and checks that the reply is signed by the same token. */
async function probe(backend: RemoteBackend, token: string, url: string, fetch: Fetch, signal: AbortSignal): Promise<Connection> {
  const ask = (offset: number) => {
    const signed = signRequest({ token, method: 'GET', path: '/v1/capabilities', bridgeId: backend.bridgeId ?? '', bodyHash: EMPTY_SHA256, timestamp: Date.now() + offset });
    return fetch(`${url}/v1/capabilities`, { headers: signed.headers, signal }).then((response) => ({ response, nonce: signed.nonce }));
  };
  let { response, nonce } = await ask(clockOffset(backend.id));
  // The bridge accepted the signature but not this phone's clock: retry once on the bridge's time.
  const serverTime = bridgeTime(response);
  let corrected: number | undefined;
  if (serverTime !== undefined) {
    corrected = serverTime - Date.now();
    ({ response, nonce } = await ask(corrected));
  }
  if (response.status === 401 && !supportsSigning(response)) throw new Error(`${url}: this bridge doesn't support signed requests. ${UPDATE_BRIDGE}`);
  if (!response.ok) {
    const message = await errorText(response);
    throw new Error(`${url}: HTTP ${response.status}${message ? ` ${message.slice(0, 200)}` : ''}`);
  }
  const body = await response.text();
  let info: BridgeInfo;
  try { info = JSON.parse(body) as BridgeInfo; } catch { throw new Error(`${url}: unsupported bridge protocol`); }
  if (info.protocol !== 1 || !info.bridgeId || !['hermes', 'harness'].includes(info.kind) || !Array.isArray(info.models)) throw new Error(`${url}: unsupported bridge protocol`);
  if (backend.bridgeId && info.bridgeId !== backend.bridgeId) throw new Error(`${url}: belongs to a different bridge`);
  const signature = response.headers.get('x-clanker-response-signature');
  if (!signature) throw new Error(`${url}: the bridge didn't sign its reply. ${UPDATE_BRIDGE} A proxy in between must keep X-Clanker headers.`);
  if (!verifyResponseSignature(token, nonce, info.bridgeId, body, signature)) {
    throw new Error(`${url}: failed the bridge identity check. Check the bridge token; another server may be answering at this address.`);
  }
  if (corrected !== undefined) setClockOffset(backend.id, corrected);
  return { url, info };
}

/** Only a capability reply signed by the saved bridge's token, with its identity, can win. */
export async function resolveBridgeAddress(backend: RemoteBackend, token: string, fetch: Fetch, force = false): Promise<Connection> {
  const cacheKey = key(backend);
  const cached = known.get(cacheKey);
  if (!force && cached?.token === token && Date.now() - cached.at < 30000) return cached.connection;
  const addresses = bridgeAddresses(backend);
  if (!addresses.length) throw new Error('Add a bridge address in Settings → Providers.');
  const controllers = addresses.map(() => new AbortController());
  try {
    const connection = await Promise.any(addresses.map(async (url, index): Promise<Connection> => {
      const controller = controllers[index];
      const timeout = setTimeout(() => controller.abort(), 6000);
      try { return await probe(backend, token, url, fetch, controller.signal); } finally { clearTimeout(timeout); }
    }));
    known.set(cacheKey, { token, at: Date.now(), connection });
    return connection;
  } catch (error) {
    known.delete(cacheKey);
    const failures = error instanceof AggregateError ? error.errors.map((item: unknown) => item instanceof Error ? item.message : String(item)).join('; ') : String(error);
    throw new Error(`Cannot reach this bridge at its configured addresses. ${failures}`);
  } finally { controllers.forEach((controller) => controller.abort()); }
}
