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

/** Transpiles a TypeScript module and runs it with `stubs` in place of its imports. */
function load(file, stubs) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
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

/** A plugins store with just what auth.ts uses. */
function fakeStore(initial = {}) {
  const state = {
    accounts: {},
    installed: {},
    clients: {},
    mcp: {},
    connecting: null,
    ...initial,
    setAccount(provider, account) {
      if (account) state.accounts[provider] = account;
      else delete state.accounts[provider];
    },
    patchAccount(provider, patch) {
      if (state.accounts[provider]) state.accounts[provider] = { ...state.accounts[provider], ...patch };
    },
    uninstall(ids) {
      for (const id of ids) delete state.installed[id];
    },
    setMcp(provider, connection) {
      if (connection) state.mcp[provider] = connection;
      else delete state.mcp[provider];
    },
  };
  return { getState: () => state };
}

/**
 * auth.ts with a fake browser, network, keychain and store. `schemes` are the URL schemes the
 * "build" registers; `responses` answers fetches by URL prefix.
 */
function setup({ schemes = ['clanker'], clients = {}, browser, responses = {}, lock = (_slot, fn) => fn() } = {}) {
  const usePlugins = fakeStore({ clients });
  const keychain = new Map();
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, ...init });
    const key = Object.keys(responses).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const { status = 200, json } = typeof responses[key] === 'function' ? responses[key](url, init) : responses[key];
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
  };
  const pkce = load('src/lib/subscriptions/pkce.ts', { 'expo-crypto': { getRandomValues: (a) => webcrypto.getRandomValues(a) } });
  const providers = load('src/lib/plugins/providers.ts', {});
  const catalog = load('src/lib/plugins/catalog.ts', { '@/store/plugins': { usePlugins }, './providers': providers });
  const opened = [];
  const auth = load('src/lib/plugins/auth.ts', {
    'expo-constants': { __esModule: true, default: { expoConfig: { scheme: schemes.length === 1 ? schemes[0] : schemes } } },
    'expo-web-browser': {
      openAuthSessionAsync: async (url, redirect) => {
        opened.push({ url, redirect });
        return browser ? browser(url, redirect) : { type: 'cancel' };
      },
      openBrowserAsync: async () => ({ type: 'opened' }),
    },
    '@/lib/net': { fetch },
    '@/store/plugins': { usePlugins, pluginSecretsReady: async () => {} },
    '../subscriptions/credentials': {
      subscriptionAuth: {
        get: async (slot) => keychain.get(slot) ?? null,
        set: async (slot, creds) => void keychain.set(slot, creds),
        remove: async (slot) => void keychain.delete(slot),
      },
      runExclusiveRefresh: lock,
    },
    '../subscriptions/pkce': pkce,
    './catalog': catalog,
    './providers': providers,
  });
  return { auth, catalog, usePlugins, keychain, requests, opened };
}

const GOOGLE_ID = '123-abc.apps.googleusercontent.com';
const GOOGLE_SCHEME = 'com.googleusercontent.apps.123-abc';

test('redirects come back to the app: clanker://oauth/<provider>, or Google’s reversed client ID', () => {
  const { auth } = setup({ schemes: ['clanker', GOOGLE_SCHEME] });
  assert.equal(auth.redirectUriFor('microsoft', 'any'), 'clanker://oauth/microsoft');
  assert.equal(auth.redirectUriFor('dropbox', 'any'), 'clanker://oauth/dropbox');
  assert.equal(auth.redirectUriFor('spotify', 'any'), 'clanker://oauth/spotify');
  assert.equal(auth.redirectUriFor('google', GOOGLE_ID), `${GOOGLE_SCHEME}:/oauth2redirect`);
  assert.equal(auth.redirectUriFor('google', '123-abc'), `${GOOGLE_SCHEME}:/oauth2redirect`);
});

test('a Google client counts as set up only when this build registers its scheme', () => {
  assert.equal(setup({ schemes: ['clanker', GOOGLE_SCHEME], clients: { google: { id: GOOGLE_ID } } }).auth.needsClientSetup('google'), false);
  assert.equal(setup({ schemes: ['clanker'], clients: { google: { id: GOOGLE_ID } } }).auth.needsClientSetup('google'), true);
  assert.equal(setup({ schemes: ['clanker'] }).auth.needsClientSetup('google'), true);
  // Other providers' redirects don't depend on the client.
  assert.equal(setup({ clients: { microsoft: { id: 'ms-id' } } }).auth.needsClientSetup('microsoft'), false);
  assert.equal(setup().auth.needsClientSetup('microsoft'), true);
  // Token providers never need a client.
  assert.equal(setup().auth.needsClientSetup('notion'), false);
});

test('signs in through the system browser and saves the account', async () => {
  const ctx = setup({
    schemes: ['clanker', GOOGLE_SCHEME],
    clients: { google: { id: GOOGLE_ID } },
    browser: (url, redirect) => {
      const state = new URL(url).searchParams.get('state');
      return { type: 'success', url: `${redirect}?state=${state}&code=the-code&scope=x` };
    },
    responses: {
      'https://oauth2.googleapis.com/token': {
        json: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          scope: 'openid https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email',
        },
      },
      'https://openidconnect.googleapis.com/v1/userinfo': { json: { name: 'Ana', email: 'ana@example.com' } },
    },
  });
  const gmail = ctx.catalog.pluginById('gmail');
  const account = await ctx.auth.signInWithBrowser(gmail);

  const [{ url, redirect }] = ctx.opened;
  const params = new URL(url).searchParams;
  assert.equal(redirect, `${GOOGLE_SCHEME}:/oauth2redirect`);
  assert.equal(params.get('redirect_uri'), redirect);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.match(params.get('scope'), /gmail\.modify/);
  assert.equal(params.get('include_granted_scopes'), 'true');

  const token = ctx.requests.find((r) => r.url.startsWith('https://oauth2.googleapis.com/token'));
  const body = new URLSearchParams(token.body);
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('redirect_uri'), redirect);
  assert.ok(body.get('code_verifier'));
  assert.equal(body.get('client_secret'), null, 'public clients send no secret');

  assert.equal(account.email, 'ana@example.com');
  assert.equal(ctx.keychain.get('plugin_google').refreshToken, 'rt');
  assert.equal(ctx.catalog.pluginGranted(gmail), true);
});

test('closing the browser signs nobody in', async () => {
  const ctx = setup({ clients: { microsoft: { id: 'ms' } }, browser: () => ({ type: 'cancel' }) });
  assert.equal(await ctx.auth.signInWithBrowser(ctx.catalog.pluginById('outlook')), null);
  assert.equal(ctx.requests.length, 0);
});

test('refuses a redirect with the wrong state or an error', async () => {
  const wrongState = setup({ clients: { spotify: { id: 'sp' } }, browser: (_u, r) => ({ type: 'success', url: `${r}?state=forged&code=c` }) });
  await assert.rejects(wrongState.auth.signInWithBrowser(wrongState.catalog.pluginById('spotify')), /state mismatch/);
  const denied = setup({ clients: { spotify: { id: 'sp' } }, browser: (_u, r) => ({ type: 'success', url: `${r}?error=access_denied` }) });
  await assert.rejects(denied.auth.signInWithBrowser(denied.catalog.pluginById('spotify')), /cancelled/);
});

test('refuses a redirect that leaves out the state', async () => {
  const ctx = setup({ clients: { spotify: { id: 'sp' } }, browser: (_u, r) => ({ type: 'success', url: `${r}?code=c` }) });
  await assert.rejects(ctx.auth.signInWithBrowser(ctx.catalog.pluginById('spotify')), /state mismatch/);
  assert.equal(ctx.requests.length, 0, 'the code is never exchanged');
  assert.throws(() => ctx.auth.readRedirect('clanker://oauth/x?code=c&state=', 'expected'), /state mismatch/);
  assert.throws(() => ctx.auth.readRedirect('clanker://oauth/x?code=c&state=s', ''), /state mismatch/);
  assert.equal(ctx.auth.readRedirect('clanker://oauth/x?code=c&state=s', 's'), 'c');
});

/** Spotify connected with `creds`, answering API calls with 401 unless they carry `good`. */
function connected(creds, { good, lock } = {}) {
  const ctx = setup({
    clients: { spotify: { id: 'sp' } },
    lock,
    responses: {
      'https://api.spotify.com/': (_url, init) => ({ status: !good || init.headers.Authorization === `Bearer ${good}` ? 200 : 401, json: {} }),
      'https://accounts.spotify.com/api/token': { json: { access_token: 'refreshed', refresh_token: 'rt-3', expires_in: 3600 } },
    },
  });
  ctx.usePlugins.getState().accounts.spotify = { scopes: [], connectedAt: 1 };
  ctx.keychain.set('plugin_spotify', creds);
  return ctx;
}

const refreshes = (ctx) => ctx.requests.filter((r) => r.url === 'https://accounts.spotify.com/api/token');

test('a refresh that waited for another one uses its tokens instead of the spent refresh token', async () => {
  // Another request refreshes (rotating the refresh token) while this one waits for the lock.
  const ctx = connected(
    { accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 },
    {
      lock: (_slot, fn) => {
        ctx.keychain.set('plugin_spotify', { accessToken: 'new', refreshToken: 'rt-2', expiresAt: Date.now() + 3600_000 });
        return fn();
      },
    }
  );
  await ctx.auth.pluginFetch('spotify', 'https://api.spotify.com/v1/me');
  assert.equal(refreshes(ctx).length, 0);
  assert.equal(ctx.requests.at(-1).headers.Authorization, 'Bearer new');
});

test('after a 401, a token refreshed meanwhile is retried before refreshing again', async () => {
  const ctx = connected(
    { accessToken: 'a', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 },
    {
      good: 'b',
      lock: (_slot, fn) => {
        ctx.keychain.set('plugin_spotify', { accessToken: 'b', refreshToken: 'rt-2', expiresAt: Date.now() + 3600_000 });
        return fn();
      },
    }
  );
  await ctx.auth.pluginFetch('spotify', 'https://api.spotify.com/v1/me');
  assert.equal(refreshes(ctx).length, 0);
  assert.equal(ctx.requests.at(-1).headers.Authorization, 'Bearer b');
});

test('an expired token still refreshes, once, with the latest refresh token', async () => {
  const ctx = connected({ accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 });
  await ctx.auth.pluginFetch('spotify', 'https://api.spotify.com/v1/me');
  assert.equal(refreshes(ctx).length, 1);
  assert.equal(new URLSearchParams(refreshes(ctx)[0].body).get('refresh_token'), 'rt-1');
  assert.equal(ctx.keychain.get('plugin_spotify').refreshToken, 'rt-3');
});

test('disconnecting sends the token only to an https revocation endpoint', async () => {
  for (const [endpoint, sent] of [
    ['http://auth.example.com/revoke', false],
    ['https://auth.example.com/revoke', true],
  ]) {
    const ctx = setup({ responses: { 'https://auth.example.com/revoke': { json: {} }, 'http://auth.example.com/revoke': { json: {} } } });
    ctx.keychain.set('plugin_notion', { accessToken: 'at', refreshToken: 'rt' });
    ctx.usePlugins.getState().mcp.notion = { url: 'https://mcp.notion.com/mcp', oauth: { clientId: 'c', clientSecret: 's', revocationEndpoint: endpoint }, tools: [] };
    await ctx.auth.disconnectProvider('notion');
    assert.equal(ctx.requests.some((r) => r.url === endpoint), sent, endpoint);
    assert.equal(ctx.keychain.has('plugin_notion'), false);
  }
});

test('adding a second Microsoft plugin asks for both plugins’ scopes', () => {
  const ctx = setup({ clients: { microsoft: { id: 'ms' } } });
  ctx.usePlugins.getState().installed.outlook = { installedAt: 1, write: true };
  const session = ctx.auth.buildOAuthSession(ctx.catalog.pluginById('onedrive'));
  const scope = new URL(session.authorizeUrl).searchParams.get('scope');
  for (const s of ['offline_access', 'Mail.ReadWrite', 'Mail.Send', 'Files.ReadWrite.All']) assert.ok(scope.split(' ').includes(s), s);
});

test('device code checks: pending, slow down, then signed in', async () => {
  let call = 0;
  const ctx = setup({
    clients: { github: { id: 'gh' } },
    responses: {
      'https://github.com/login/oauth/access_token': () => {
        call++;
        if (call === 1) return { json: { error: 'authorization_pending' } };
        if (call === 2) return { json: { error: 'slow_down', interval: 10 } };
        return { json: { access_token: 'gho_x', scope: 'repo,read:user' } };
      },
      'https://api.github.com/user': { json: { login: 'ana', name: 'Ana' } },
    },
  });
  const session = { provider: 'github', deviceCode: 'dc', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5 };
  assert.deepEqual(await ctx.auth.checkDeviceAuth(session), { wait: 5 });
  assert.deepEqual(await ctx.auth.checkDeviceAuth(session), { wait: 10 });
  const done = await ctx.auth.checkDeviceAuth(session);
  assert.equal(done.account.name, 'Ana');
  assert.deepEqual(done.account.scopes, ['repo', 'read:user']);
});

test('sign-in redirects don’t navigate; other links do', () => {
  const { redirectSystemPath } = load('src/app/+native-intent.tsx', {});
  assert.equal(redirectSystemPath({ path: 'clanker://oauth/microsoft?code=1&state=2', initial: false }), null);
  assert.equal(redirectSystemPath({ path: `${GOOGLE_SCHEME}:/oauth2redirect?code=1`, initial: false }), null);
  assert.equal(redirectSystemPath({ path: 'clanker://oauth/dropbox?code=1', initial: true }), '/');
  assert.equal(redirectSystemPath({ path: 'clanker://pair?host=x', initial: false }), 'clanker://pair?host=x');
  assert.equal(redirectSystemPath({ path: '/settings', initial: true }), '/settings');
});

// ---- Client secrets in the keychain -------------------------------------------------------------

/** The real plugins store over a fake disk (JSON text by name) and keychain. */
function launchPluginsStore(disk, items, { failing = false } = {}) {
  const secureStore = {
    getItemAsync: async (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => {
      if (failing) throw new Error('keystore unavailable');
      items.set(k, v);
    },
    deleteItemAsync: async (k) => void items.delete(k),
  };
  const credentials = load('src/lib/subscriptions/credentials.ts', { 'expo-secure-store': secureStore });
  const secrets = load('src/lib/secrets.ts', { './subscriptions/credentials': credentials });
  const jsonFileStorage = {
    getItem: (name) => (disk.has(name) ? JSON.parse(disk.get(name)) : null),
    setItem: (name, value) => void disk.set(name, JSON.stringify(value)),
    removeItem: (name) => void disk.delete(name),
  };
  const { usePlugins, pluginSecretsReady } = load('src/store/plugins.ts', {
    zustand: require('zustand'),
    'zustand/middleware': require('zustand/middleware'),
    '@/lib/secrets': secrets,
    '@/lib/storage': { jsonFileStorage },
  });
  return { usePlugins, pluginSecretsReady, saved: () => JSON.parse(disk.get('plugins')).state };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
};

const MCP_OAUTH = { clientId: 'c-1', clientSecret: 'mcp-secret', authMethod: 'client_secret_post', redirectUri: 'clanker://oauth/notion', authorizationEndpoint: 'https://a/authorize', tokenEndpoint: 'https://a/token', resource: 'https://mcp.notion.com/mcp' };

test('client secrets move from plugins.json to the keychain on first launch, and come back on the next', async () => {
  const disk = new Map([
    ['plugins', JSON.stringify({ version: 2, state: { accounts: {}, installed: {}, clients: { google: { id: 'g-id', secret: 'google-secret' } }, mcp: { notion: { url: 'https://mcp.notion.com/mcp', oauth: MCP_OAUTH, tools: [], toolsAt: 0 } } } })],
  ]);
  const items = new Map();

  let app = launchPluginsStore(disk, items);
  await app.pluginSecretsReady();
  await settle();
  assert.equal(app.usePlugins.getState().clients.google.secret, 'google-secret');
  assert.equal(app.usePlugins.getState().mcp.notion.oauth.clientSecret, 'mcp-secret');
  assert.ok(!disk.get('plugins').includes('google-secret') && !disk.get('plugins').includes('mcp-secret'), 'no secret left in plugins.json');
  assert.equal(app.saved().clients.google.id, 'g-id');
  assert.equal(app.saved().mcp.notion.oauth.clientId, 'c-1');
  assert.equal(items.get('plugin_client_secret_google'), 'google-secret');
  assert.equal(items.get('plugin_mcp_secret_notion'), 'mcp-secret');

  // Next launch: the secrets are back in memory once read from the keychain.
  app = launchPluginsStore(disk, items);
  await app.pluginSecretsReady();
  assert.equal(app.usePlugins.getState().clients.google.secret, 'google-secret');
  assert.equal(app.usePlugins.getState().mcp.notion.oauth.clientSecret, 'mcp-secret');

  // Disconnecting and removing the client forget them.
  app.usePlugins.getState().setMcp('notion', null);
  app.usePlugins.getState().setClient('google', null);
  await settle();
  assert.equal(items.size, 0);
});

test('client secrets stay in plugins.json while the keychain refuses them', async () => {
  const disk = new Map([['plugins', JSON.stringify({ version: 2, state: { accounts: {}, installed: {}, clients: { google: { id: 'g-id', secret: 'google-secret' } }, mcp: {} } })]]);
  const items = new Map();
  const app = launchPluginsStore(disk, items, { failing: true });
  await app.pluginSecretsReady();
  await settle();
  app.usePlugins.getState().setConnecting(null);
  assert.equal(app.saved().clients.google.secret, 'google-secret', 'kept rather than lost');

  const later = launchPluginsStore(disk, items);
  await later.pluginSecretsReady();
  await settle();
  assert.equal(later.saved().clients.google.secret, undefined);
  assert.equal(items.get('plugin_client_secret_google'), 'google-secret');
});
