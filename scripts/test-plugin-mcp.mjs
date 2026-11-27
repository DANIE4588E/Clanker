import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

function load(file, stubs) {
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: file })(
    (name) => {
      if (name in stubs) return stubs[name];
      throw new Error(`unexpected import ${name} from ${file}`);
    },
    module,
    module.exports,
    { env: {} }
  );
  return module.exports;
}

const SERVER = 'https://mcp.example.com/mcp';
const AUTH = 'https://auth.example.com';

/**
 * A fake MCP server with OAuth: discovery documents, registration, token endpoint, and JSON-RPC
 * over Streamable HTTP. `behaviour` tweaks it per test.
 */
function fakeServer(behaviour = {}) {
  const log = [];
  let sessionCount = 0;
  let accessToken = 'at-1';
  const tools = behaviour.tools ?? [
    { name: 'search', description: 'Search pages.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
    { name: 'create-page', title: 'Create page', inputSchema: { type: 'object', properties: { title: { type: ['string', 'null'] } } } },
  ];
  const json = (status, body, headers = {}) => ({
    ok: status < 400,
    status,
    headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  const sse = (messages, headers = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (k) => ({ 'content-type': 'text/event-stream', ...headers })[k.toLowerCase()] ?? null },
    text: async () => messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''),
  });
  const fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    log.push({ url, method: init.method ?? 'GET', headers, body: init.body });
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
      return json(200, { resource: SERVER, authorization_servers: [AUTH], scopes_supported: ['read', 'write'], ...behaviour.resourceMetadata });
    if (behaviour.elsewhere && url === behaviour.elsewhere.url) return json(200, behaviour.elsewhere.json);
    if (url === `${AUTH}/.well-known/oauth-authorization-server`)
      return json(200, { issuer: AUTH, authorization_endpoint: `${AUTH}/authorize`, token_endpoint: `${AUTH}/token`, registration_endpoint: `${AUTH}/register`, ...behaviour.serverMetadata });
    if (url.startsWith('https://mcp.example.com/.well-known/') || url.startsWith(`${AUTH}/.well-known/`)) return json(404, {});
    if (url === `${AUTH}/register`) return json(201, { client_id: 'client-1', token_endpoint_auth_method: 'none' });
    if (url === `${AUTH}/token`) {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'refresh_token') accessToken = 'at-2';
      return json(200, { access_token: accessToken, refresh_token: 'rt-1', expires_in: 3600 });
    }
    if (url === SERVER) {
      const auth = headers.Authorization;
      const metadataUrl = behaviour.elsewhere?.url ?? 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
      if (behaviour.open !== true && auth !== `Bearer ${accessToken}`) return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` });
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') {
        sessionCount++;
        return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'Example' } } }, { 'mcp-session-id': `s${sessionCount}` });
      }
      if (!msg.id) return json(202, undefined);
      if (behaviour.forget && headers['Mcp-Session-Id'] === 's1') return json(404, { error: 'unknown session' });
      if (behaviour.expire && auth === 'Bearer at-1') return json(401, { error: 'expired' });
      if (msg.method === 'tools/list') return sse([{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { jsonrpc: '2.0', id: msg.id, result: { tools } }]);
      if (msg.method === 'tools/call') {
        return json(200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              { type: 'text', text: `called ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` },
              { type: 'resource_link', uri: 'https://example.com/page/1', name: 'Page 1' },
              { type: 'resource', resource: { uri: 'file:///report.csv', mimeType: 'text/csv', blob: btoa('a,b\n1,2\n') } },
            ],
          },
        });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, log, sessions: () => sessionCount };
}

function setup(server, { browserResult } = {}) {
  const state = {
    accounts: {}, installed: {}, clients: {}, mcp: {}, connecting: null,
    setAccount(p, a) { if (a) state.accounts[p] = a; else delete state.accounts[p]; },
    patchAccount(p, patch) { if (state.accounts[p]) state.accounts[p] = { ...state.accounts[p], ...patch }; },
    setMcp(p, c) { if (c) state.mcp = { ...state.mcp, [p]: c }; else { const { [p]: _, ...rest } = state.mcp; state.mcp = rest; } },
    patchMcp(p, patch) { if (state.mcp[p]) state.mcp = { ...state.mcp, [p]: { ...state.mcp[p], ...patch } }; },
  };
  const usePlugins = { getState: () => state };
  const keychain = new Map();
  const opened = [];
  /** `lock.next` runs as the next refresh takes the lock, standing in for one that finished just before. */
  const lock = { next: null };
  const providers = load('src/lib/plugins/providers.ts', {});
  // Point Notion's provider at the fake server.
  providers.PROVIDERS.notion.auth = { kind: 'mcp', url: SERVER, prefix: 'notion' };
  const stubs = {
    'expo-constants': { __esModule: true, default: { expoConfig: { scheme: 'clanker', version: '9' } } },
    'expo-web-browser': {
      openAuthSessionAsync: async (url, redirect) => {
        opened.push({ url, redirect });
        if (browserResult) return browserResult(url, redirect);
        const state = new URL(url).searchParams.get('state');
        return { type: 'success', url: `${redirect}?code=the-code&state=${state}` };
      },
    },
    '@/lib/net': { fetch: server.fetch },
    '@/store/plugins': { usePlugins, pluginSecretsReady: async () => {} },
    '../subscriptions/credentials': {
      subscriptionAuth: { get: async (s) => keychain.get(s) ?? null, set: async (s, c) => void keychain.set(s, c), remove: async (s) => void keychain.delete(s) },
      runExclusiveRefresh: (_s, fn) => {
        const before = lock.next;
        lock.next = null;
        before?.();
        return fn();
      },
    },
    '../subscriptions/pkce': load('src/lib/subscriptions/pkce.ts', { 'expo-crypto': { getRandomValues: (a) => webcrypto.getRandomValues(a) } }),
    './providers': providers,
  };
  const catalog = load('src/lib/plugins/catalog.ts', { '@/store/plugins': { usePlugins }, './providers': providers });
  stubs['./catalog'] = catalog;
  stubs['./auth'] = load('src/lib/plugins/auth.ts', stubs);
  const mcp = load('src/lib/plugins/mcp.ts', stubs);
  const pluginUtil = load('src/lib/tools/pluginUtil.ts', {
    '../workspace': { formatSize: (n) => `${n} B` },
    './observe': { requireObserved() {} },
    './web': { htmlToMarkdown: (h) => ({ text: h }) },
  });
  const tools = load('src/lib/tools/mcp.ts', {
    '@/store/plugins': { usePlugins },
    '../attachments': { importAsset: async () => ({ type: 'image', file: 'x.png', mimeType: 'image/png' }) },
    '../plugins/catalog': catalog,
    '../plugins/mcp': mcp,
    './pluginUtil': pluginUtil,
  });
  return { state, keychain, opened, mcp, tools, catalog, lock };
}

/** A workspace that keeps written files in memory. */
function memoryWorkspace() {
  const files = new Map();
  return {
    files,
    normalizePath: (p) => p,
    freePath: (name, dir) => `${dir}/${name}`,
    ensureParent() {},
    dirAt: () => ({ exists: false }),
    fileAt: (p) => ({
      uri: `file:///${p}`,
      get size() {
        return files.get(p)?.length ?? 0;
      },
      write: async (bytes) => void files.set(p, bytes),
    }),
  };
}

test('connects: registers itself, signs in with PKCE and the resource, and lists tools', async () => {
  const server = fakeServer();
  const ctx = setup(server);
  const account = await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  assert.equal(account.name, 'Example');

  const register = server.log.find((r) => r.url === `${AUTH}/register`);
  const reg = JSON.parse(register.body);
  assert.deepEqual(reg.redirect_uris, ['clanker://oauth/notion']);
  assert.equal(reg.token_endpoint_auth_method, 'none');

  const [{ url, redirect }] = ctx.opened;
  const q = new URL(url).searchParams;
  assert.equal(redirect, 'clanker://oauth/notion');
  assert.equal(q.get('client_id'), 'client-1');
  assert.equal(q.get('resource'), SERVER);
  assert.equal(q.get('scope'), 'read write');
  assert.equal(q.get('code_challenge_method'), 'S256');

  const token = new URLSearchParams(server.log.find((r) => r.url === `${AUTH}/token`).body);
  assert.equal(token.get('code'), 'the-code');
  assert.equal(token.get('resource'), SERVER);
  assert.ok(token.get('code_verifier'));
  assert.equal(ctx.keychain.get('plugin_notion').refreshToken, 'rt-1');

  // Tools came over an event stream (with a notification before the reply), named for the model.
  const tools = ctx.state.mcp.notion.tools;
  assert.deepEqual(tools.map((t) => [t.key, t.title, t.readOnly]), [
    ['notion_search', 'Search', true],
    ['notion_create-page', 'Create page', false],
  ]);
  // The session ID from initialize goes with later requests.
  const list = server.log.find((r) => r.body?.includes('tools/list'));
  assert.equal(list.headers['Mcp-Session-Id'], 's1');
  assert.equal(list.headers['MCP-Protocol-Version'], '2025-06-18');
});

test('closing the browser connects nothing', async () => {
  const ctx = setup(fakeServer(), { browserResult: () => ({ type: 'cancel' }) });
  assert.equal(await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion')), null);
  assert.equal(ctx.state.accounts.notion, undefined);
});

test('reconnecting reuses the registered client', async () => {
  const server = fakeServer();
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  assert.equal(server.log.filter((r) => r.url === `${AUTH}/register`).length, 1);
});

test('starts a new session when the server forgets one', async () => {
  const server = fakeServer({ forget: true });
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  assert.equal(server.sessions(), 2);
  assert.equal(ctx.state.mcp.notion.tools.length, 2);
});

test('refreshes the token after a 401 and retries', async () => {
  const server = fakeServer({ expire: true });
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  const refresh = server.log.filter((r) => r.url === `${AUTH}/token`).map((r) => new URLSearchParams(r.body));
  assert.equal(refresh[1].get('grant_type'), 'refresh_token');
  assert.equal(refresh[1].get('resource'), SERVER);
  assert.equal(ctx.keychain.get('plugin_notion').accessToken, 'at-2');
  assert.equal(ctx.state.mcp.notion.tools.length, 2);
});

test('a redirect without the state is refused', async () => {
  const server = fakeServer();
  const ctx = setup(server, { browserResult: (_u, redirect) => ({ type: 'success', url: `${redirect}?code=the-code` }) });
  await assert.rejects(ctx.mcp.connectMcp(ctx.catalog.pluginById('notion')), /state mismatch/);
  assert.equal(server.log.some((r) => r.url === `${AUTH}/token`), false);
});

test('a refresh that waited for another one uses its tokens', async () => {
  const server = fakeServer({ expire: true });
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  const before = server.log.filter((r) => r.url === `${AUTH}/token`).length;
  // Expired on disk, but another request refreshed it while this one waited for the lock.
  ctx.keychain.set('plugin_notion', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 });
  ctx.lock.next = () => ctx.keychain.set('plugin_notion', { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3600_000 });
  await ctx.mcp.refreshMcpTools('notion');
  assert.equal(server.log.filter((r) => r.url === `${AUTH}/token`).length, before);
  assert.equal(server.log.at(-1).headers.Authorization, 'Bearer at-2');
});

const refused = /don’t check out/;

test('discovery refuses resource metadata for another server', async () => {
  const server = fakeServer({ resourceMetadata: { resource: 'https://other.example.com/mcp' } });
  const ctx = setup(server);
  await assert.rejects(ctx.mcp.connectMcp(ctx.catalog.pluginById('notion')), refused);
  assert.equal(server.log.some((r) => r.url.startsWith(AUTH)), false, 'never asks its authorization server');
});

test('discovery skips metadata elsewhere that names another resource', async () => {
  const server = fakeServer({ elsewhere: { url: 'https://evil.example.org/prm', json: { resource: 'https://evil.example.org/', authorization_servers: ['https://evil.example.org'] } } });
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  assert.equal(server.log.some((r) => r.url.startsWith('https://evil.example.org/.well-known')), false);
  assert.equal(ctx.state.mcp.notion.oauth.tokenEndpoint, `${AUTH}/token`);
});

test('discovery accepts metadata elsewhere that names this server', async () => {
  const server = fakeServer({ elsewhere: { url: 'https://meta.example.org/prm', json: { resource: SERVER, authorization_servers: [AUTH] } } });
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  assert.equal(ctx.state.mcp.notion.oauth.resource, SERVER);
});

test('discovery refuses an authorization server whose issuer differs', async () => {
  for (const serverMetadata of [{ issuer: 'https://evil.example.org' }, { issuer: undefined }]) {
    const server = fakeServer({ serverMetadata });
    const ctx = setup(server);
    await assert.rejects(ctx.mcp.connectMcp(ctx.catalog.pluginById('notion')), refused);
    assert.equal(server.log.some((r) => r.url === `${AUTH}/register`), false);
  }
});

test('discovery refuses endpoints that aren’t https', async () => {
  for (const serverMetadata of [
    { token_endpoint: 'http://auth.example.com/token' },
    { authorization_endpoint: 'http://auth.example.com/authorize' },
    { registration_endpoint: 'http://auth.example.com/register' },
    { revocation_endpoint: 'http://auth.example.com/revoke' },
  ]) {
    const ctx = setup(fakeServer({ serverMetadata }));
    await assert.rejects(ctx.mcp.connectMcp(ctx.catalog.pluginById('notion')), refused, JSON.stringify(serverMetadata));
  }
  const ctx = setup(fakeServer({ resourceMetadata: { authorization_servers: ['http://auth.example.com'] } }));
  await assert.rejects(ctx.mcp.connectMcp(ctx.catalog.pluginById('notion')), refused);
});

test('sameUrl compares URLs as parsed', () => {
  const { mcp } = setup(fakeServer());
  assert.equal(mcp.sameUrl('https://mcp.example.com', 'https://MCP.example.com/'), true);
  assert.equal(mcp.sameUrl('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/'), false);
  assert.equal(mcp.sameUrl('https://mcp.example.com/mcp', 'http://mcp.example.com/mcp'), false);
  assert.equal(mcp.sameUrl(undefined, 'https://mcp.example.com'), false);
});

test('servers that need no account connect without a browser', async () => {
  const server = fakeServer({ open: true });
  const ctx = setup(server);
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  assert.equal(ctx.opened.length, 0);
  assert.equal(ctx.state.mcp.notion.oauth, undefined);
  assert.equal(server.log.some((r) => r.headers?.Authorization), false);
});

test('tools are offered as agent tools and their results become text, links and files', async () => {
  const ctx = setup(fakeServer());
  await ctx.mcp.connectMcp(ctx.catalog.pluginById('notion'));
  ctx.state.installed.notion = { installedAt: 1, write: true };
  const agentTools = ctx.tools.mcpTools();
  assert.deepEqual(agentTools.map((t) => t.name), ['notion_search', 'notion_create-page']);
  // A nullable type collapses to its real one.
  assert.deepEqual(agentTools[1].parameters.properties.title, { type: 'string' });
  assert.deepEqual(agentTools[0].parameters.required, ['q']);

  const ws = memoryWorkspace();
  const out = await agentTools[0].run({ q: 'plans' }, { signal: new AbortController().signal, conversationId: 'c', workspace: ws });
  assert.match(out.output, /called search with \{"q":"plans"\}/);
  assert.match(out.output, /Link: Page 1 — https:\/\/example\.com\/page\/1/);
  assert.deepEqual(out.files, ['mcp/report.csv']);
  assert.equal(new TextDecoder().decode(ws.files.get('mcp/report.csv')), 'a,b\n1,2\n');

  // Turning changes off leaves only the tools the server marks read-only.
  assert.equal(ctx.catalog.pluginToolOn('notion_search'), true);
  assert.equal(ctx.catalog.pluginToolOn('notion_create-page'), true);
  ctx.state.installed.notion.write = false;
  assert.equal(ctx.catalog.pluginToolOn('notion_create-page'), false);
  assert.equal(ctx.catalog.pluginToolOn('notion_search'), true);
});

test('tool names are safe and unique for every model provider', () => {
  const { mcp } = setup(fakeServer());
  const taken = new Set();
  assert.equal(mcp.toolKey('notion', 'notion-search', taken), 'notion_notion-search');
  assert.equal(mcp.toolKey('x', 'get.page/v2', taken), 'x_get_page_v2');
  assert.equal(mcp.toolKey('x', 'get_page/v2', taken), 'x_get_page_v2_2');
  assert.equal(mcp.toolKey('x', 'a'.repeat(80), taken).length, 64);
});

test('schemas are reduced to what every provider accepts', () => {
  const { tools } = setup(fakeServer());
  const schema = tools.simplifySchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      filter: { $ref: '#/$defs/Filter' },
      limit: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
      sort: { anyOf: [{ type: 'string', enum: ['asc', 'desc'] }, { type: 'null' }], description: 'Order.' },
      ids: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      mode: { const: 'fast' },
    },
    required: ['filter', 'missing'],
    $defs: { Filter: { type: 'object', properties: { status: { type: 'string' } } } },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      filter: { type: 'object', properties: { status: { type: 'string' } } },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      sort: { type: 'string', description: 'Order.', enum: ['asc', 'desc'] },
      ids: { type: 'array', items: { type: 'string', description: '(one of: string, number)' } },
      mode: { type: 'string', enum: ['fast'] },
    },
    required: ['filter'],
  });
});

test('event streams with several messages are read', () => {
  const { mcp } = setup(fakeServer());
  const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"note"}\n\nid: 2\ndata: {"jsonrpc":"2.0",\ndata: "id":7,"result":{"ok":true}}\n\n';
  const messages = mcp.parseMessages('text/event-stream; charset=utf-8', body);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 7, result: { ok: true } });
});
