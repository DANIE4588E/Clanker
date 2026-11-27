import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const terminal = (state) => ['completed', 'cancelled', 'failed'].includes(state);
export const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
export function assertId(id) {
  if (!idPattern.test(id ?? '') || ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'].includes(id)) throw Object.assign(new Error('Invalid identity.'), { status: 400 });
  return id;
}
/** A plain-object map lookup that never resolves inherited keys such as `constructor`. */
export const own = (map, key) => (typeof key === 'string' && map && Object.hasOwn(map, key) ? map[key] : undefined);
/** A map for ids that come from requests: no prototype, so no inherited keys. */
export const idMap = (value) => Object.assign(Object.create(null), value ?? {});

// Request signing (see README, "Authentication"). The token is an HMAC key and never travels.
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const EMPTY_SHA256 = sha256Hex('');
const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
export const requestMessage = ({ method, path, timestamp, nonce, bridgeId, bodyHash }) =>
  ['clanker-v1', method, path, String(timestamp), nonce, bridgeId ?? '', bodyHash].join('\n');
export const requestSignature = (token, fields) => `v1=${hmacHex(token, requestMessage(fields))}`;
export const responseSignature = (token, { nonce, bridgeId, body }) =>
  `v1=${hmacHex(token, ['clanker-resp-v1', nonce, bridgeId, sha256Hex(body)].join('\n'))}`;
const sameSecret = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Nonces seen inside the signature window. Bounded: the oldest entries go first when full. */
export class ReplayCache {
  constructor(limit = 50000) { this.limit = limit; this.seen = new Map(); }
  /** False when this nonce was already used and is still inside its window. */
  add(nonce, expiresAt, now) {
    const previous = this.seen.get(nonce);
    if (previous !== undefined && previous > now) return false;
    this.seen.delete(nonce);
    if (this.seen.size >= this.limit) {
      for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
      for (const key of this.seen.keys()) { if (this.seen.size < this.limit) break; this.seen.delete(key); }
    }
    this.seen.set(nonce, expiresAt);
    return true;
  }
}

const authError = (message, extra = {}) => Object.assign(new Error(message), { status: 401, ...extra });
const header = (req, name) => { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value; };

/**
 * Checks a request's signature, or the deprecated bearer token. Returns `{ legacy: true }` or
 * `{ nonce, bodyHash }`; throws a 401 error otherwise. A valid signature with a stale clock gets
 * `X-Clanker-Time`, so the phone can correct its offset and retry once.
 */
export function createAuthenticator({ token, now = Date.now, windowMs = SIGNATURE_WINDOW_MS, replay = new ReplayCache() }) {
  const bearer = `Bearer ${token}`;
  return (req) => {
    const authorization = header(req, 'authorization');
    if (authorization !== undefined) {
      if (!sameSecret(authorization, bearer)) throw authError('Invalid bridge token.');
      return { legacy: true };
    }
    const signature = header(req, 'x-clanker-signature');
    if (!signature) throw authError('This request is not signed. Update Clanker, or check the bridge token.', { code: 'unsigned' });
    const timestamp = header(req, 'x-clanker-timestamp') ?? '', nonce = header(req, 'x-clanker-nonce') ?? '';
    const bodyHash = header(req, 'x-clanker-content-sha256') ?? EMPTY_SHA256;
    if (!/^\d{1,16}$/.test(timestamp) || !/^[0-9a-f]{32,128}$/.test(nonce) || (bodyHash !== UNSIGNED_PAYLOAD && !/^[0-9a-f]{64}$/.test(bodyHash))) {
      throw authError('Malformed request signature.', { code: 'bad_signature' });
    }
    const expected = requestSignature(token, { method: req.method, path: req.url, timestamp, nonce, bridgeId: header(req, 'x-clanker-bridge') ?? '', bodyHash });
    if (!sameSecret(signature, expected)) throw authError('Invalid request signature. Check the bridge token.', { code: 'bad_signature' });
    const current = now();
    if (Math.abs(current - Number(timestamp)) > windowMs) {
      throw authError('The request time is too far from the bridge clock.', { code: 'clock_skew', headers: { 'X-Clanker-Time': String(current) } });
    }
    if (!replay.add(nonce, Number(timestamp) + windowMs, current)) throw authError('This request was already used.', { code: 'replayed' });
    return { nonce, bodyHash };
  };
}

export function addText(run, text, type = 'text') {
  if (!text) return;
  const last = run.content.at(-1);
  if (last?.type === type) last.text += text;
  else run.content.push({ type, text });
}
export function toolEvent(run, event, done = false) {
  const id = event.id ?? event.tool_call_id;
  const name = event.tool ?? event.name ?? 'Remote tool';
  let tool = id ? run.content.find((p) => p.type === 'tool' && p.id === id) : undefined;
  if (!tool && done) tool = run.content.findLast((p) => p.type === 'tool' && p.name === name && p.status === 'running');
  if (!tool) {
    tool = { type: 'tool', id: id ?? `tool_${run.content.length}`, name, input: typeof event.input === 'object' ? event.input : { preview: event.preview ?? '' }, status: 'running' };
    run.content.push(tool);
  }
  if (done) Object.assign(tool, { status: event.error ? 'error' : 'done', output: typeof event.preview === 'string' ? event.preview : JSON.stringify(event.output ?? ''), durationMs: event.duration ? event.duration * 1000 : undefined });
}
export async function* sse(response) {
  if (!response.ok) throw new Error(`Upstream ${response.status}: ${(await response.text()).slice(0, 300)}`);
  let buffer = '', name = 'message', data = [], id;
  const dispatch = () => {
    const value = data.join('\n');
    const event = name, eventId = id;
    name = 'message'; data = []; id = undefined;
    if (!value || value === '[DONE]') return null;
    // A frame that isn't JSON (a future keepalive or notice format) is skipped, not fatal.
    try { return { event, id: eventId, data: JSON.parse(value) }; } catch { return null; }
  };
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
      if (!line) { const value = dispatch(); if (value) yield value; }
      else if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
  const value = dispatch(); if (value) yield value;
}
