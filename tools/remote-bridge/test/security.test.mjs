import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge, weakToken } from '../src/server.mjs';
import { EMPTY_SHA256, ReplayCache, UNSIGNED_PAYLOAD, requestSignature, responseSignature, sha256Hex } from '../src/protocol.mjs';
import { restrictToOwner } from '../src/persistence.mjs';

const token = 'fixture-token-abcdefghijklmnopqrstuvwxyz';
const DAY = 24 * 60 * 60 * 1000;
const listen = async (server) => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const until = async (fn) => { for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('Fixture timed out.'); };

/** An upstream that finishes each turn at once, except "hold" turns, which wait for the bridge to close. */
function stubAdapter() {
  const adapter = {
    starts: 0, modelOptions: { m: { efforts: [] } }, workspaces: new Map(),
    models: async () => ['m'], ensureSession: async (session) => session.id,
    start: async (run, session) => { adapter.starts++; adapter.workspaces.set(run.id, session.workspace); return `up-${run.id}`; },
    observe: async (run, update, signal) => {
      // "make" turns edit report.txt, as an agent's tool would.
      if (run.input.startsWith('make')) await writeFile(path.join(adapter.workspaces.get(run.id), 'report.txt'), 'second');
      if (run.input.startsWith('hold')) { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return; }
      await update((r) => { r.content.push({ type: 'text', text: `echo ${r.input.split('\n')[0]}` }); });
      await update((r) => { r.state = 'completed'; });
    },
    stop: async (run) => { run.state = 'cancelled'; }, respond: async () => {},
  };
  return adapter;
}

/** Signs the way the phone does. */
function sign({ method = 'GET', route, body, bridgeId = '', key = token, timestamp = Date.now(), nonce = randomBytes(16).toString('hex'), bodyHash }) {
  const hash = bodyHash ?? (body === undefined ? EMPTY_SHA256 : sha256Hex(body));
  return {
    nonce,
    headers: {
      'X-Clanker-Bridge': bridgeId, 'X-Clanker-Timestamp': String(timestamp), 'X-Clanker-Nonce': nonce, 'X-Clanker-Content-SHA256': hash,
      'X-Clanker-Signature': requestSignature(key, { method, path: `/v1/${route}`, timestamp, nonce, bridgeId, bodyHash: hash }),
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'clanker-security-'));
  const adapter = stubAdapter();
  const config = { kind: 'hermes', token, stateDir: path.join(root, 'state'), workspaceRoot: path.join(root, 'workspaces') };
  let bridge = await createBridge(config, adapter); let url = await listen(bridge.server);
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const f = {
    root, adapter, config, get bridge() { return bridge; }, get url() { return url; },
    async restart() { await bridge.close(); bridge = await createBridge(config, adapter); url = await listen(bridge.server); },
    /** A signed request; `signAs` overrides what gets signed, to forge or tamper. */
    request: async (route, { method = 'GET', body, headers = {}, signAs = {} } = {}) => {
      const text = body === undefined || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const signed = sign({ method, route, body: text, bridgeId: bridge.state.bridgeId, ...signAs });
      const response = await fetch(`${url}/v1/${route}`, { method, body: text, headers: { ...(text === undefined || Buffer.isBuffer(text) ? {} : { 'Content-Type': 'application/json' }), ...signed.headers, ...headers } });
      response.nonce = signed.nonce; return response;
    },
  };
  f.json = async (route, options) => { const response = await f.request(route, options); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  f.done = (id) => until(async () => { const run = await f.json(`runs/${id}`); return ['completed', 'cancelled', 'failed'].includes(run.state) && run; });
  return f;
}

test('signed requests work without the token on the wire, and capabilities prove the bridge holds it', async (t) => {
  const f = await fixture(t);
  const response = await f.request('capabilities');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(response.headers.get('x-clanker-response-signature'), responseSignature(token, { nonce: response.nonce, bridgeId: f.bridge.state.bridgeId, body }));
  assert.equal(response.headers.get('x-clanker-auth'), 'v1');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  // An unknown bridge identity is allowed for first pairing; the phone learns it from the reply.
  const unpaired = await fetch(`${f.url}/v1/capabilities`, { headers: sign({ route: 'capabilities' }).headers });
  assert.equal(unpaired.status, 200);
});

test('wrong keys, tampered paths and bodies, and unsigned JSON bodies are refused', async (t) => {
  const f = await fixture(t);
  const wrong = await f.request('capabilities', { signAs: { key: 'another-token-abcdefghijklmnopqrstuvwxyz' } });
  assert.equal(wrong.status, 401); assert.equal((await wrong.json()).code, 'bad_signature');
  assert.equal(wrong.headers.get('x-clanker-auth'), 'v1'); assert.equal(wrong.headers.get('x-clanker-time'), null);
  assert.equal((await f.request('capabilities', { signAs: { route: 'runs/abc' } })).status, 401);
  assert.equal((await f.request('capabilities', { signAs: { bridgeId: 'other' }, headers: { 'X-Clanker-Bridge': f.bridge.state.bridgeId } })).status, 401);
  const tampered = await f.request('sessions', { method: 'POST', body: { chatId: 'chat1', model: 'm', instructions: '' }, signAs: { body: '{"chatId":"other","model":"m","instructions":""}' } });
  assert.equal(tampered.status, 401); assert.match((await tampered.json()).error, /does not match its signature/);
  assert.equal((await f.request('sessions', { method: 'POST', body: { chatId: 'chat1', model: 'm', instructions: '' }, signAs: { bodyHash: UNSIGNED_PAYLOAD } })).status, 401);
  assert.equal(Object.keys(f.bridge.state.sessions).length, 0);
  assert.equal((await fetch(`${f.url}/v1/capabilities`)).status, 401);
  assert.equal((await f.request('capabilities', { headers: { 'X-Clanker-Nonce': 'not-hex' } })).status, 401);
});

test('a skewed clock gets the bridge time back and succeeds on retry; a replayed request does not', async (t) => {
  const f = await fixture(t);
  const late = Date.now() - 10 * 60 * 1000;
  const skewed = await f.request('capabilities', { signAs: { timestamp: late } });
  assert.equal(skewed.status, 401); assert.equal((await skewed.json()).code, 'clock_skew');
  const offset = Number(skewed.headers.get('x-clanker-time')) - Date.now();
  assert.ok(Math.abs(offset) < 5000);
  assert.equal((await f.request('capabilities', { signAs: { timestamp: late + 10 * 60 * 1000 + offset } })).status, 200);
  // Only a correctly signed request learns the bridge time.
  assert.equal((await f.request('capabilities', { signAs: { timestamp: late, key: 'another-token-abcdefghijklmnopqrstuvwxyz' } })).headers.get('x-clanker-time'), null);
  const signed = sign({ route: 'capabilities', bridgeId: f.bridge.state.bridgeId });
  assert.equal((await fetch(`${f.url}/v1/capabilities`, { headers: signed.headers })).status, 200);
  const replayed = await fetch(`${f.url}/v1/capabilities`, { headers: signed.headers });
  assert.equal(replayed.status, 401); assert.equal((await replayed.json()).code, 'replayed');
});

test('the deprecated bearer token keeps working for older apps', async (t) => {
  const f = await fixture(t);
  const ok = await fetch(`${f.url}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('x-clanker-response-signature'), null);
  assert.equal((await fetch(`${f.url}/v1/capabilities`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const session = await fetch(`${f.url}/v1/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'legacy', model: 'm', instructions: '' }) });
  assert.equal(session.status, 200);
});

test('ids naming Object.prototype members are just unknown ids', async (t) => {
  const f = await fixture(t);
  for (const id of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf']) {
    assert.equal((await f.request(`runs/${id}`)).status, 404);
    const events = await f.request(`runs/${id}/events`);
    assert.equal(events.status, 404); await events.text();
    assert.ok([400, 404].includes((await f.request(`sessions/${id}/files`)).status));
  }
  // A real chat may be named like one, and stays separate from the prototype.
  await f.json('sessions', { method: 'POST', body: { chatId: 'hasOwnProperty', model: 'm', instructions: '' } });
  assert.equal(Object.getPrototypeOf(f.bridge.state.sessions), null);
  assert.equal((await f.request('sessions/hasOwnProperty/runs', { method: 'POST', body: { submissionId: 's1', text: 'hi', files: ['isPrototypeOf'] } })).status, 400);
  const { id } = await f.json('sessions/hasOwnProperty/runs', { method: 'POST', body: { submissionId: 's1', text: 'hi', files: [] } });
  assert.equal((await f.done(id)).state, 'completed');
});

test('uploads are checked against a signed hash, and downloads are attachments', async (t) => {
  const f = await fixture(t);
  await f.json('sessions', { method: 'POST', body: { chatId: 'chat1', model: 'm', instructions: '' } });
  const bytes = Buffer.from('<html><script>alert(1)</script></html>');
  const bad = await f.request('sessions/chat1/files/up1?name=page.html', { method: 'PUT', body: bytes, signAs: { bodyHash: sha256Hex('other') } });
  assert.equal(bad.status, 401);
  const uploaded = await f.json('sessions/chat1/files/up1?name=page.html', { method: 'PUT', body: bytes });
  const unsigned = await f.json('sessions/chat1/files/up2?name=b%C3%A9.html', { method: 'PUT', body: bytes, signAs: { bodyHash: UNSIGNED_PAYLOAD } });
  assert.equal(uploaded.version, sha256Hex(bytes)); assert.equal(unsigned.version, uploaded.version);
  const download = await f.request(`sessions/chat1/files/${unsigned.id}?version=${unsigned.version}`);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="up2_b_.html"; filename*=UTF-8''up2_b_.html`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test('event streams are capped per run', async (t) => {
  const f = await fixture(t);
  await f.json('sessions', { method: 'POST', body: { chatId: 'chat1', model: 'm', instructions: '' } });
  const { id } = await f.json('sessions/chat1/runs', { method: 'POST', body: { submissionId: 'held', text: 'hold on', files: [] } });
  const controllers = [];
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController(); controllers.push(controller);
    const signed = sign({ route: `runs/${id}/events`, bridgeId: f.bridge.state.bridgeId });
    assert.equal((await fetch(`${f.url}/v1/runs/${id}/events`, { headers: signed.headers, signal: controller.signal })).status, 200);
  }
  const refused = await f.request(`runs/${id}/events`);
  assert.equal(refused.status, 429); await refused.text();
  for (const controller of controllers) controller.abort();
  await until(async () => { const response = await f.request(`runs/${id}/events`, { headers: {} }); const ok = response.status === 200; await response.body?.cancel(); return ok; });
});

test('finished runs shed live-only data, old ones prune to receipts, and files stay downloadable', async (t) => {
  const f = await fixture(t);
  await f.json('sessions', { method: 'POST', body: { chatId: 'chat1', model: 'm', instructions: '' } });
  const workspace = path.join(f.config.workspaceRoot, 'chat1');
  await writeFile(path.join(workspace, 'report.txt'), 'first');
  const payload = { submissionId: 'one', text: 'make a report', files: [] };
  const { id } = await f.json('sessions/chat1/runs', { method: 'POST', body: payload });
  const done = await f.done(id);
  const run = f.bridge.state.runs[id];
  assert.equal(run.input, undefined); assert.equal(run.beforeFiles, undefined); assert.ok(run.finishedAt);
  assert.equal(done.files.length, 1);
  const artifact = done.files[0];
  // Later edits and a listing leave the old version unreferenced by the workspace, but the reply still has it.
  await writeFile(path.join(workspace, 'report.txt'), 'third');
  await f.json('sessions/chat1/files');
  await f.bridge.maintain(Date.now() + 31 * DAY);
  assert.equal(f.bridge.state.runs[id], undefined); assert.ok(f.bridge.state.receipts[id]);
  assert.equal((await f.request(`runs/${id}`)).status, 410);
  assert.equal((await f.json('sessions/chat1/runs', { method: 'POST', body: payload })).id, id);
  assert.equal(f.adapter.starts, 1);
  assert.equal((await f.request('sessions/chat1/runs', { method: 'POST', body: { ...payload, text: 'other' } })).status, 409);
  const download = await f.request(`sessions/chat1/files/${artifact.id}?version=${artifact.version}`);
  assert.equal(await download.text(), 'second');
  // Receipts and history survive a restart.
  await f.restart();
  assert.equal((await f.json('sessions/chat1/runs', { method: 'POST', body: payload })).id, id);
  assert.equal(await (await f.request(`sessions/chat1/files/${artifact.id}?version=${artifact.version}`)).text(), 'second');
});

test('a failed file listing leaves a completed turn completed', async (t) => {
  const f = await fixture(t);
  await f.json('sessions', { method: 'POST', body: { chatId: 'chat1', model: 'm', instructions: '' } });
  const list = f.bridge.files.list.bind(f.bridge.files);
  let calls = 0;
  f.bridge.files.list = async (...args) => { if (++calls > 1) throw new Error('Workspace has more than 1000 transferable files.'); return list(...args); };
  const { id } = await f.json('sessions/chat1/runs', { method: 'POST', body: { submissionId: 'one', text: 'hi', files: [] } });
  const done = await f.done(id);
  assert.equal(done.state, 'completed'); assert.deepEqual(done.files, []); assert.match(done.error, /could not be listed/);
});

test('listing skips dependency folders, re-reads only changed files, and collects unreferenced versions', async (t) => {
  const f = await fixture(t);
  const files = f.bridge.files;
  const dir = await files.directory('chat1');
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'dependency');
  await writeFile(path.join(dir, 'a.txt'), 'a'); await writeFile(path.join(dir, 'b.txt'), 'b');
  let reads = 0; const hash = files.hash.bind(files); files.hash = async (file) => { reads++; return hash(file); };
  assert.deepEqual((await files.list('chat1')).map((file) => file.path).sort(), ['a.txt', 'b.txt']);
  assert.equal(reads, 2);
  await files.list('chat1'); assert.equal(reads, 2);
  await writeFile(path.join(dir, 'a.txt'), 'changed');
  const listed = await files.list('chat1'); assert.equal(reads, 3);
  const objects = () => readdir(files.objects).then((names) => names.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort());
  assert.equal((await objects()).length, 3);
  assert.equal(await files.collect(new Set(listed.map((file) => file.version)), { graceMs: 0, now: Date.now() + 1 }), 1);
  assert.deepEqual(await objects(), listed.map((file) => file.version).sort());
});

test('replay cache stays bounded and forgets expired nonces first', () => {
  const cache = new ReplayCache(3);
  assert.ok(cache.add('a', 100, 0)); assert.ok(!cache.add('a', 100, 50)); assert.ok(cache.add('a', 200, 150));
  cache.add('b', 10, 0); cache.add('c', 300, 0);
  assert.ok(cache.add('d', 300, 20));
  assert.ok(!cache.seen.has('b')); assert.equal(cache.seen.size, 3);
});

test('weak tokens are recognised and owner-only permissions are best effort', async () => {
  assert.ok(weakToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.ok(weakToken('password1234password1234'));
  assert.ok(!weakToken(randomBytes(32).toString('hex')));
  assert.equal(await restrictToOwner('x', { platform: 'linux' }), false);
  let call;
  assert.equal(await restrictToOwner('C:\\x\\pairing.html', { platform: 'win32', run: async (...args) => { call = args; } }), !!process.env.USERNAME);
  if (process.env.USERNAME) assert.deepEqual(call.slice(0, 2), ['icacls', ['C:\\x\\pairing.html', '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]]);
  assert.equal(await restrictToOwner('x', { platform: 'win32', run: async () => { throw new Error('denied'); } }), false);
});
