import { randomBytes, sha256 } from '@/lib/subscriptions/pkce';

/**
 * Request signing for remote bridges. The bridge token is an HMAC-SHA256 key and never travels:
 * each request carries a signature over its method, path, time, a fresh nonce, the bridge identity
 * and its body's hash. The bridge signs its capabilities reply back over the same nonce, which is how
 * the app tells the real bridge from another server at a saved address. tools/remote-bridge's
 * README ("Authentication") has the full scheme, and protocol.mjs there the bridge's half.
 */

/** sha256 of an empty body. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** Streamed uploads skip hashing up to 20 MB in JS; the signature still covers everything else. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const encoder = new TextEncoder();
const bytes = (value: string | Uint8Array) => (typeof value === 'string' ? encoder.encode(value) : value);

export function toHex(data: Uint8Array) {
  let out = '';
  for (const byte of data) out += byte.toString(16).padStart(2, '0');
  return out;
}

export const sha256Hex = (data: string | Uint8Array) => toHex(sha256(data));

/** RFC 2104 HMAC over the pure-JS SHA-256, which works without native crypto. */
export function hmacSha256(key: string | Uint8Array, message: string | Uint8Array) {
  let k = bytes(key);
  if (k.length > 64) k = sha256(k);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  inner.set(k);
  outer.set(k);
  for (let i = 0; i < 64; i++) {
    inner[i] ^= 0x36;
    outer[i] ^= 0x5c;
  }
  const data = bytes(message);
  const first = new Uint8Array(64 + data.length);
  first.set(inner);
  first.set(data, 64);
  const second = new Uint8Array(64 + 32);
  second.set(outer);
  second.set(sha256(first), 64);
  return sha256(second);
}

/** Compares two signatures without stopping at the first difference. */
function sameText(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** The body hash a request is signed with: the exact bytes of a JSON body, none for a streamed file. */
export function bodyHash(body: unknown) {
  if (body === undefined || body === null) return EMPTY_SHA256;
  if (typeof body === 'string') return sha256Hex(body);
  return UNSIGNED_PAYLOAD;
}

export type SignedRequest = { nonce: string; headers: Record<string, string> };

/** Headers for one request. `path` starts at /v1, as the bridge receives it, with its query. */
export function signRequest(input: { token: string; method: string; path: string; bridgeId: string; bodyHash: string; timestamp: number }): SignedRequest {
  const nonce = toHex(randomBytes(16));
  const timestamp = String(Math.round(input.timestamp));
  const message = ['clanker-v1', input.method.toUpperCase(), input.path, timestamp, nonce, input.bridgeId, input.bodyHash].join('\n');
  return {
    nonce,
    headers: {
      'X-Clanker-Bridge': input.bridgeId,
      'X-Clanker-Timestamp': timestamp,
      'X-Clanker-Nonce': nonce,
      'X-Clanker-Content-SHA256': input.bodyHash,
      'X-Clanker-Signature': `v1=${toHex(hmacSha256(input.token, message))}`,
    },
  };
}

/** Whether the bridge's reply to a signed request proves it holds the same token. */
export function verifyResponseSignature(token: string, nonce: string, bridgeId: string, body: string, signature: string) {
  const expected = `v1=${toHex(hmacSha256(token, ['clanker-resp-v1', nonce, bridgeId, sha256Hex(body)].join('\n')))}`;
  return sameText(signature, expected);
}

type Headers = { get(name: string): string | null };

/** The bridge's clock, when it refused a correctly signed request only for its time. */
export function bridgeTime(response: { status: number; headers: Headers }) {
  if (response.status !== 401) return undefined;
  const value = Number(response.headers.get('x-clanker-time'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A bridge from before signing answers 401 without this header. */
export const supportsSigning = (response: { headers: Headers }) => !!response.headers.get('x-clanker-auth');

/** Per backend, how far this phone's clock is from the bridge's. In memory only. */
const offsets = new Map<string, number>();
export const clockOffset = (key: string) => offsets.get(key) ?? 0;
export function setClockOffset(key: string, offset: number) {
  if (Math.abs(offset) < 1000) offsets.delete(key);
  else offsets.set(key, offset);
}
