import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
// The bridge's own half of the scheme, so these tests check that both sides agree.
import { createAuthenticator, responseSignature, sha256Hex, requestSignature } from '../tools/remote-bridge/src/protocol.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const TOKEN = 'fixture-token-abcdefghijklmnopqrstuvwxyz';

function transpile(file, deps) {
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(deps, module, module.exports);
  return module.exports;
}
/** A fresh copy of src/lib/remote, so address and clock caches don't leak between tests. */
function remote() {
  const pkce = transpile('src/lib/subscriptions/pkce.ts', (name) => ({ 'expo-crypto': { getRandomValues: (a) => webcrypto.getRandomValues(a) } })[name]);
  const deps = {
    '@/lib/net': { fetch }, '@/lib/subscriptions/pkce': pkce,
    'expo-file-system': { File: class {} },
    '@/lib/attachments': {}, '@/lib/storage': { apiKeys: { get: async () => TOKEN } }, './cache': {},
  };
  const modules = new Map();
  const load = (name) => {
    if (!modules.has(name)) modules.set(name, transpile(`src/lib/remote/${name}.ts`, (specifier) => specifier.startsWith('./') && !deps[specifier] ? load(specifier.slice(2)) : deps[specifier]));
    return modules.get(name);
  };
  return { RemoteAdapter: load('client').RemoteAdapter, signing: load('signing') };
}

/**
 * A bridge that verifies signatures with the bridge's own code. `token` is what it holds,
 * `clockSkew` shifts its clock, `legacy` makes it a bridge from before signing,
 * `unsignedReply` strips its reply signature.
 */
async function host(t, { bridgeId = 'same-bridge', delay = 0, shared, dropSubmission = false, token = TOKEN, clockSkew = 0, legacy = false, unsignedReply = false } = {}) {
  const authenticate = createAuthenticator({ token, now: () => Date.now() + clockSkew });
  const stats = { requests: 0, rejected: 0, authorization: 0, bodies: [] };
  const server = http.createServer(async (req, res) => {
    stats.requests++;
    if (req.headers.authorization) stats.authorization++;
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (legacy) { if (req.headers.authorization !== `Bearer ${token}`) return send({ error: 'Invalid bridge token.' }, 401); }
    let auth = {};
    if (!legacy) {
      res.setHeader('X-Clanker-Auth', 'v1');
      try { auth = authenticate(req); } catch (error) { stats.rejected++; return send({ error: error.message, code: error.code }, 401, error.headers); }
    }
    if (req.url === '/v1/capabilities') {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const body = JSON.stringify({ protocol: 1, bridgeId, kind: 'hermes', models: ['model'], maxFileBytes: 20971520 });
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json', ...(auth.nonce && !unsignedReply ? { 'X-Clanker-Response-Signature': responseSignature(token, { nonce: auth.nonce, bridgeId, body }) } : {}) });
      res.end(body); return;
    }
    if (req.method === 'POST') {
      let body = ''; for await (const part of req) body += part;
      if (auth.bodyHash) assert.equal(sha256Hex(body), auth.bodyHash, 'JSON body hash is signed');
      stats.bodies.push(body);
      const request = JSON.parse(body);
      if (shared) {
        shared.calls.push(request);
        shared.receipts.set(request.submissionId, shared.receipts.get(request.submissionId) ?? { id: 'same-run' });
        if (dropSubmission) { req.socket.destroy(); server.closeAllConnections(); server.close(); return; }
        return send(shared.receipts.get(request.submissionId));
      }
      return send({ ok: true });
    }
    send({ id: 'same-run', sessionId: 'same-session', cursor: 1, content: [], controls: [], files: [], state: 'running' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, stats, url: `http://127.0.0.1:${server.address().port}` };
}
const backend = (baseUrl, altBaseUrls, bridgeId = 'same-bridge') => ({ id: 'remote', bridgeId, kind: 'hermes', name: 'Host', model: 'model', models: ['model'], baseUrl, altBaseUrls });

test('saved connection moves from LAN to its alternative while observing the same run', async (t) => {
  const { RemoteAdapter } = remote();
  const lan = await host(t); const other = await host(t, { delay: 50 });
  const adapter = new RemoteAdapter(backend(lan.url, [other.url]), TOKEN);
  assert.equal((await adapter.info()).bridgeId, 'same-bridge');
  await new Promise((resolve) => { lan.server.closeAllConnections(); lan.server.close(resolve); });
  assert.equal((await adapter.snapshot('same-run')).sessionId, 'same-session');
  assert.equal(lan.stats.authorization + other.stats.authorization, 0, 'the token never travels');
});

test('a faster unrelated server cannot receive session or run mutations', async (t) => {
  const { RemoteAdapter } = remote();
  const wrong = await host(t, { bridgeId: 'another-bridge' }); const right = await host(t, { delay: 40 });
  const adapter = new RemoteAdapter(backend(wrong.url, [right.url]), TOKEN);
  assert.equal((await adapter.info()).bridgeId, 'same-bridge');
  assert.equal((await adapter.snapshot('same-run')).id, 'same-run');
  await assert.rejects(new RemoteAdapter(backend(wrong.url, []), TOKEN).info(), /different bridge/);
});

test('a lost submission response reuses its receipt across addresses', async (t) => {
  const { RemoteAdapter } = remote(); const shared = { calls: [], receipts: new Map() };
  const lan = await host(t, { shared, dropSubmission: true }); const other = await host(t, { shared, delay: 40 });
  const adapter = new RemoteAdapter(backend(lan.url, [other.url]), TOKEN);
  await adapter.info();
  const reply = await adapter.start('same-session', 'submission', 'hello', []);
  assert.equal(reply.id, 'same-run'); assert.equal(shared.receipts.size, 1);
  assert.deepEqual(shared.calls.map((call) => call.submissionId), ['submission', 'submission']);
});

test('an impostor with the public bridge identity but not the token loses to the real bridge', async (t) => {
  const { RemoteAdapter } = remote();
  // A stale address now answered by someone else, who copied the bridge id from a QR code.
  const impostor = await host(t, { token: 'impostor-token-abcdefghijklmnopqrstuvwx' });
  const real = await host(t, { delay: 40 });
  const adapter = new RemoteAdapter(backend(impostor.url, [real.url]), TOKEN);
  assert.equal((await adapter.info()).bridgeId, 'same-bridge');
  await adapter.ensureSession('chat', 'model', '');
  assert.equal(impostor.stats.bodies.length, 0); assert.equal(real.stats.bodies.length, 1);
  assert.equal(impostor.stats.authorization, 0);
  // Even when it answers 200 to anything: its reply signature can't be made without the token.
  const forger = await host(t, { token: 'impostor-token-abcdefghijklmnopqrstuvwx', unsignedReply: false });
  forger.server.removeAllListeners('request');
  forger.server.on('request', (req, res) => {
    const body = JSON.stringify({ protocol: 1, bridgeId: 'same-bridge', kind: 'hermes', models: ['model'], maxFileBytes: 1 });
    res.writeHead(200, { 'X-Clanker-Auth': 'v1', 'X-Clanker-Response-Signature': responseSignature('impostor-token-abcdefghijklmnopqrstuvwx', { nonce: req.headers['x-clanker-nonce'], bridgeId: 'same-bridge', body }) });
    res.end(body);
  });
  await assert.rejects(new RemoteAdapter(backend(forger.url, []), TOKEN).info(), /identity check/);
});

test('bridges that predate signing, or replies without a signature, ask for a bridge update', async (t) => {
  const { RemoteAdapter } = remote();
  const old = await host(t, { legacy: true });
  await assert.rejects(new RemoteAdapter(backend(old.url, []), TOKEN).info(), /doesn't support signed requests\. Update the bridge/);
  assert.equal(old.stats.authorization, 0);
  const stripped = await host(t, { unsignedReply: true });
  await assert.rejects(new RemoteAdapter(backend(stripped.url, []), TOKEN).info(), /didn't sign its reply\. Update the bridge/);
  const wrongToken = await host(t, { token: 'another-token-abcdefghijklmnopqrstuvwxyz' });
  await assert.rejects(new RemoteAdapter(backend(wrongToken.url, []), TOKEN).info(), /HTTP 401 Invalid request signature/);
});

test('a skewed phone clock is corrected once per backend, then requests go through first time', async (t) => {
  const { RemoteAdapter } = remote();
  const ahead = await host(t, { clockSkew: 20 * 60 * 1000 });
  const adapter = new RemoteAdapter(backend(ahead.url, []), TOKEN);
  assert.equal((await adapter.info()).bridgeId, 'same-bridge');
  assert.equal(ahead.stats.rejected, 1);
  await adapter.snapshot('same-run');
  await adapter.ensureSession('chat', 'model', '');
  assert.equal(ahead.stats.rejected, 1);
  // A different bridge's clock is its own.
  const elsewhere = await host(t, { clockSkew: -20 * 60 * 1000 });
  await new RemoteAdapter({ ...backend(elsewhere.url, []), id: 'other' }, TOKEN).info();
  assert.equal(elsewhere.stats.rejected, 1);
});

test('first pairing signs with no bridge identity and learns it from the signed reply', async (t) => {
  const { RemoteAdapter } = remote();
  const fresh = await host(t, { bridgeId: 'learned-bridge' });
  assert.equal((await new RemoteAdapter(backend(fresh.url, [], ''), TOKEN).info()).bridgeId, 'learned-bridge');
});

test('HMAC matches the reference implementation, including keys longer than a block', () => {
  const { signing } = remote();
  const hex = (key, message) => signing.toHex(signing.hmacSha256(key, message));
  // RFC 4231 test cases 2 and 6.
  assert.equal(hex('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(hex(new Uint8Array(131).fill(0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  const signed = signing.signRequest({ token: TOKEN, method: 'post', path: '/v1/sessions', bridgeId: 'b', bodyHash: signing.EMPTY_SHA256, timestamp: 1234 });
  assert.equal(signed.headers['X-Clanker-Signature'], requestSignature(TOKEN, { method: 'POST', path: '/v1/sessions', timestamp: 1234, nonce: signed.nonce, bridgeId: 'b', bodyHash: sha256Hex('') }));
  assert.match(signed.nonce, /^[0-9a-f]{32}$/);
  assert.equal(signing.bodyHash('{"a":"é"}'), sha256Hex('{"a":"é"}'));
  assert.equal(signing.bodyHash({ uri: 'file' }), 'UNSIGNED-PAYLOAD');
});

test('the app and the real bridge agree end to end, with no bearer token', async (t) => {
  const { RemoteAdapter } = remote();
  const { createBridge } = await import('../tools/remote-bridge/src/server.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'clanker-e2e-'));
  const adapter = {
    modelOptions: { model: { efforts: [] } }, models: async () => ['model'], ensureSession: async (session) => session.id,
    start: async (run) => `up-${run.id}`, stop: async () => {}, respond: async () => {},
    observe: async (run, update) => { await update((r) => { r.content.push({ type: 'text', text: 'héllo' }); r.state = 'completed'; }); },
  };
  const bridge = await createBridge({ kind: 'hermes', token: TOKEN, stateDir: path.join(dir, 'state'), workspaceRoot: path.join(dir, 'work') }, adapter);
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const client = new RemoteAdapter(backend(`http://127.0.0.1:${bridge.server.address().port}`, [], bridge.state.bridgeId), TOKEN);
  assert.equal((await client.info()).bridgeId, bridge.state.bridgeId);
  const { sessionId } = await client.ensureSession('chat_1', 'model', 'Ünïcode instructions');
  const { id } = await client.start(sessionId, 'submission_1', 'hi ✓', []);
  let snapshot;
  for (let i = 0; i < 50 && snapshot?.state !== 'completed'; i++) { snapshot = await client.snapshot(id); await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.equal(snapshot.state, 'completed'); assert.equal(snapshot.content[0].text, 'héllo');
  assert.deepEqual(await client.files(sessionId), []);
});
