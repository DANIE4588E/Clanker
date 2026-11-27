import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

// Placeholder OAuth client for the Antigravity tests; the real one lives in the gitignored .env.local.
process.env.EXPO_PUBLIC_ANTIGRAVITY_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.EXPO_PUBLIC_ANTIGRAVITY_CLIENT_SECRET = 'test-secret';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

function loadSrc(relPath, extraDeps = {}) {
  const cache = new Map();
  function load(file) {
    const abs = path.resolve(root, 'src', file.endsWith('.ts') ? file : `${file}.ts`);
    if (cache.has(abs)) return cache.get(abs);
    const code = ts.transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod.exports);
    const deps = {
      'expo/fetch': { fetch },
      'react-native': { Platform: { OS: 'android' } },
      'expo-crypto': { getRandomValues: (array) => crypto.webcrypto.getRandomValues(array) },
      ...extraDeps,
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: abs })(
      (spec) => {
        if (spec in deps) return deps[spec];
        if (spec === '@/lib/net') return load('lib/net');
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const resolved = path.relative(path.join(root, 'src'), path.resolve(path.dirname(abs), spec));
          return load(resolved);
        }
        return deps[spec];
      },
      mod,
      mod.exports
    );
    cache.set(abs, mod.exports);
    return mod.exports;
  }
  return load(relPath);
}

test('selected catalogue models are appended without changing existing model settings', () => {
  const { appendFetchedModels, newModels } = loadSrc('lib/providers/modelImport');
  const current = {
    models: ['manual', 'configured', 'auto'],
    efforts: { configured: ['custom'] },
    contexts: { configured: 96_000 },
  };
  const catalog = [
    { id: 'configured', efforts: ['low', 'high'], contextLength: 128_000 },
    { id: 'auto', efforts: ['high'], contextLength: 64_000 },
    { id: 'add', efforts: ['low'], contextLength: 32_000 },
    { id: 'add', efforts: ['high'], contextLength: 128_000 },
    { id: 'skip', efforts: ['high'], contextLength: 16_000 },
  ];

  const available = newModels(current.models, catalog);
  assert.deepEqual(available.map(({ id }) => id), ['add', 'skip']);
  const next = appendFetchedModels(current, [catalog[0], catalog[1], available[0], catalog[3]]);
  assert.deepEqual(next, {
    models: ['manual', 'configured', 'auto', 'add'],
    efforts: { configured: ['custom'], add: ['low'] },
    contexts: { configured: 96_000, add: 32_000 },
  });
  assert.equal(appendFetchedModels(current, []), current);
  assert.equal(appendFetchedModels(next, [available[0]]), next);
});

test('model options preserve legacy defaults and apply media and reasoning overrides per model', () => {
  const { filterModelInputs, modelEffortValue, modelMediaInputs, optionsForModel, selectModelEntries } =
    loadSrc('lib/providers/modelOptions');
  const configured = { mediaInputs: ['video'], effortValues: { low: 'minimal' }, maxOutputTokens: 32 };
  const endpoint = { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', modelOptions: { configured } };
  const inputs = modelMediaInputs(endpoint, optionsForModel(endpoint, 'configured'));
  assert.deepEqual(inputs, { image: false, video: true });
  assert.deepEqual(modelMediaInputs(endpoint), { image: true, video: false });
  assert.deepEqual(modelMediaInputs({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }), { image: true, video: true });
  assert.deepEqual(modelMediaInputs({ ...endpoint, baseUrl: 'https://api.openai.com/v1' }, configured), { image: false, video: false });
  assert.equal(modelEffortValue(configured, 'low'), 'minimal');
  assert.equal(modelEffortValue(configured, 'high'), 'high');
  assert.equal(modelEffortValue({ ...configured, reasoningDisabled: true }, 'low'), undefined);
  assert.deepEqual(selectModelEntries(['configured'], { configured, removed: {} }), { configured });

  const image = { mimeType: 'image/png', base64: 'aW1hZ2U=' };
  const video = { mimeType: 'video/mp4', base64: 'dmlkZW8=', name: 'clip.mp4' };
  const messages = [
    { role: 'user', text: 'Describe this clip', images: [image], files: [video] },
    { role: 'tool', text: '', images: [], results: [{ callId: '1', name: 'view', output: 'look', images: [image] }] },
  ];
  const filtered = filterModelInputs(messages, inputs);
  assert.deepEqual(filtered[0], { ...messages[0], images: [] });
  assert.deepEqual(filtered[1].results[0].images, []);
  assert.deepEqual(filterModelInputs(messages, modelMediaInputs(endpoint))[0].files, []);
  assert.deepEqual(messages[0].images, [image]);
});

test('chat history reads raw video attachments only when video input is enabled', async () => {
  const { buildWire } = loadSrc('lib/context', { '@/store/chats': {}, './tools/describe': {} });
  const unit = {
    kind: 'user', key: 'turn-1', text: 'Describe this clip',
    message: { content: [{ type: 'file', file: 'clip-file', name: 'clip.MP4', mimeType: 'application/octet-stream' }] },
  };
  const reads = [];
  const options = {
    endpointType: 'openai', withTools: false, tagged: false,
    readBase64: async (file) => { reads.push(file); return 'dmlkZW8='; },
  };
  const disabled = await buildWire([unit], [], { ...options, mediaInputs: { image: true, video: false } });
  assert.equal(disabled[0].files, undefined);
  assert.deepEqual(reads, []);
  const enabled = await buildWire([unit], [], { ...options, mediaInputs: { image: true, video: true } });
  assert.deepEqual(enabled[0].files, [{ name: 'clip.MP4', mimeType: 'video/mp4', base64: 'dmlkZW8=' }]);
  assert.deepEqual(reads, ['clip-file']);
});

test('providers serialize model output caps and video using their wire formats', async () => {
  const requests = [];
  const deps = {
    '../storage': { uid: () => 'test' },
    '@/lib/net': { fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response('');
    } },
  };
  const model = 'test';
  const options = {
    model,
    messages: [{ role: 'user', text: 'Hi', images: [], files: [{ mimeType: 'video/mp4', base64: 'dmlkZW8=' }] }],
    signal: new AbortController().signal,
    onToken: () => {},
  };
  const endpoint = { id: 'test', models: [model], modelOptions: { [model]: { maxOutputTokens: 64 } } };
  const { openai } = loadSrc('lib/providers/openai', deps);
  await openai.stream({ ...options, endpoint: { ...endpoint, type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' } });
  assert.equal(requests.at(-1).max_tokens, 64);
  assert.deepEqual(requests.at(-1).messages[0].content[0], { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } });
  await openai.stream({ ...options, messages: [], endpoint: { ...endpoint, type: 'openai', baseUrl: 'https://api.openai.com/v1' } });
  assert.equal(requests.at(-1).max_completion_tokens, 64);

  const { gemini } = loadSrc('lib/providers/gemini', deps);
  await gemini.stream({ ...options, effort: 'low', endpoint: { ...endpoint, type: 'gemini', baseUrl: 'https://gemini.test' } });
  assert.equal(requests.at(-1).generationConfig.maxOutputTokens, 64);
  assert.equal(requests.at(-1).generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.deepEqual(requests.at(-1).contents[0].parts[0], { inline_data: { mime_type: 'video/mp4', data: 'dmlkZW8=' } });

  const { ollama } = loadSrc('lib/providers/ollama', deps);
  await ollama.stream({ ...options, endpoint: { ...endpoint, type: 'ollama', baseUrl: 'http://localhost:11434' } });
  assert.equal(requests.at(-1).options.num_predict, 64);

  const { buildAnthropicBody } = loadSrc('lib/providers/anthropic', deps);
  const anthropic = { ...endpoint, type: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  const claude = 'claude-sonnet-4-5';
  const limited = buildAnthropicBody({ endpoint: { ...anthropic, modelOptions: { [claude]: { maxOutputTokens: 2048 } } },
    model: claude, messages: [], effort: 'high' });
  assert.equal(limited.max_tokens, 2048);
  assert.equal(limited.thinking.budget_tokens, 2047);
  assert.equal(buildAnthropicBody({ endpoint: anthropic, model: claude, messages: [] }).max_tokens, 8192);
});

test('pure-JS SHA-256 and PKCE S256 match Node crypto', () => {
  const pkce = loadSrc('lib/subscriptions/pkce');
  for (const sample of ['', 'abc', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'x'.repeat(200)]) {
    const expected = crypto.createHash('sha256').update(sample).digest();
    const actual = Buffer.from(pkce.sha256(sample));
    assert.deepEqual(actual, expected);
  }
  const pair = pkce.generatePkce();
  const expectedChallenge = crypto.createHash('sha256').update(pair.verifier).digest('base64url');
  assert.equal(pair.challenge, expectedChallenge);
  assert.ok(pair.state.length >= 24);
});

test('decodeJwtPayload extracts OpenAI account claims and expiry', () => {
  const pkce = loadSrc('lib/subscriptions/pkce');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      exp: 1800000000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_12345' },
      'https://api.openai.com/profile': { email: 'user@example.com' },
    })
  ).toString('base64url');
  const decoded = pkce.decodeJwtPayload(`${header}.${payload}.sig`);
  assert.equal(decoded['https://api.openai.com/auth'].chatgpt_account_id, 'acct_12345');
  assert.equal(decoded['https://api.openai.com/profile'].email, 'user@example.com');
  assert.equal(pkce.decodeJwtPayload('not-a-jwt'), null);
});

test('parsePastedAuthCode handles code#state, callback URLs, and plain codes', () => {
  const oauth = loadSrc('lib/subscriptions/oauth');
  assert.deepEqual(oauth.parsePastedAuthCode('abc123#state456'), { code: 'abc123', state: 'state456' });
  assert.deepEqual(
    oauth.parsePastedAuthCode('https://console.anthropic.com/oauth/code/callback?code=xyz&state=st1'),
    { code: 'xyz', state: 'st1' }
  );
  assert.deepEqual(oauth.parsePastedAuthCode('  plain_code  '), { code: 'plain_code' });
});

test('Claude sign-in exchanges a pasted code only when its state is this sign-in’s', async () => {
  const posted = [];
  const fetch = async (url, init) => {
    posted.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) };
  };
  const oauth = loadSrc('lib/subscriptions/oauth', { 'expo/fetch': { fetch } });
  const session = oauth.buildClaudeAuthSession();
  const { state } = session.pkce;

  await assert.rejects(oauth.exchangeClaudeAuthCode('the-code#someone-elses-state', session), /different sign-in/);
  await assert.rejects(
    oauth.exchangeClaudeAuthCode('https://console.anthropic.com/oauth/code/callback?code=the-code&state=forged', session),
    /different sign-in/
  );
  assert.equal(posted.length, 0, 'a code from another sign-in is never exchanged');

  // The page's `code#state`, as normally pasted.
  assert.equal((await oauth.exchangeClaudeAuthCode(`the-code#${state}`, session)).accessToken, 'at');
  // Only the code: still works, with this sign-in's state.
  await oauth.exchangeClaudeAuthCode('the-code', session);
  assert.deepEqual(posted.map((b) => [b.code, b.state]), [
    ['the-code', state],
    ['the-code', state],
  ]);
});

test('CLI credential importers parse Codex and Claude files', () => {
  const oauth = loadSrc('lib/subscriptions/oauth');
  const jwtPayload = Buffer.from(
    JSON.stringify({
      exp: 1900000000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_codex' },
      'https://api.openai.com/profile': { email: 'dev@openai.test' },
    })
  ).toString('base64url');
  const fakeJwt = `hdr.${jwtPayload}.sig`;

  const codex = oauth.parseCodexImport(
    JSON.stringify({ tokens: { access_token: fakeJwt, refresh_token: 'rt_codex' } })
  );
  assert.equal(codex.accessToken, fakeJwt);
  assert.equal(codex.refreshToken, 'rt_codex');
  assert.equal(codex.accountId, 'acct_codex');
  assert.equal(codex.email, 'dev@openai.test');
  assert.equal(codex.expiresAt, 1900000000 * 1000);

  const claude = oauth.parseClaudeImport(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-abc',
        refreshToken: 'sk-ant-ort01-def',
        expiresAt: 1850000000000,
        subscriptionType: 'max',
      },
    })
  );
  assert.equal(claude.accessToken, 'sk-ant-oat01-abc');
  assert.equal(claude.refreshToken, 'sk-ant-ort01-def');
  assert.equal(claude.plan, 'max');
});

test('usage parsers compute remaining percentages for Codex and Claude', () => {
  const usage = loadSrc('lib/subscriptions/usage');
  const now = 1_700_000_000_000;

  const codex = usage.parseCodexUsage(
    {
      plan_type: 'plus',
      email: 'a@b.com',
      rate_limit: {
        primary_window: { used_percent: 18, limit_window_seconds: 18000, reset_at: 1700007200 },
        secondary_window: { used_percent: 36, limit_window_seconds: 604800, reset_at: 1700400000 },
      },
      credits: { has_credits: true, unlimited: false, balance: 25 },
    },
    now
  );
  assert.equal(codex.plan, 'Plus');
  assert.equal(codex.windows.length, 2);
  assert.equal(codex.windows[0].label, '5-hour');
  assert.equal(codex.windows[0].remainingPercent, 82);
  assert.equal(codex.windows[1].label, '7-day');
  assert.equal(codex.windows[1].remainingPercent, 64);
  assert.equal(usage.compactUsageSummary(codex), '5h 82% left · 7d 64% left');

  const claude = usage.parseClaudeUsage(
    {
      five_hour: { utilization: 37.0, resets_at: '2026-03-10T04:59:59.000000+00:00' },
      seven_day: { utilization: 26.0, resets_at: '2026-03-15T14:59:59.771647+00:00' },
      seven_day_sonnet: { utilization: 1.0, resets_at: '2026-03-16T20:59:59.771655+00:00' },
      seven_day_opus: null,
    },
    now
  );
  assert.equal(claude.windows.length, 3);
  assert.equal(claude.windows[0].remainingPercent, 63);
  assert.equal(claude.windows[1].remainingPercent, 74);
  assert.equal(claude.windows[2].remainingPercent, 99);
  assert.equal(usage.compactUsageSummary(claude), '5h 63% left · 7d 74% left');
});

test('response header parsers update Codex and Claude usage immediately', () => {
  const usage = loadSrc('lib/subscriptions/usage');
  const now = 1_700_000_000_000;

  const codexHeaders = new Headers({
    'x-codex-primary-used-percent': '25',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-secondary-used-percent': '40',
  });
  const codexUpdated = usage.parseCodexUsageHeaders(codexHeaders, undefined, now);
  assert.equal(codexUpdated.windows[0].remainingPercent, 75);
  assert.equal(codexUpdated.windows[1].remainingPercent, 60);

  const claudeHeaders = new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.3',
    'anthropic-ratelimit-unified-7d-utilization': '0.15',
  });
  const claudeUpdated = usage.parseClaudeUsageHeaders(claudeHeaders, undefined, now);
  assert.equal(claudeUpdated.windows[0].remainingPercent, 70);
  assert.equal(claudeUpdated.windows[1].remainingPercent, 85);
});

test('toCodexInput maps messages, images, tool calls and tool results to Responses API items', () => {
  const codexMod = loadSrc('lib/providers/codex', {
    '@/store/subscriptionUsage': { useSubscriptionUsage: { getState: () => ({ byEndpoint: {}, setUsage() {} }) } },
    '../storage': { uid: () => 'u1' },
    '../subscriptions': {},
  });
  const items = codexMod.toCodexInput([
    { role: 'user', text: 'Check this', images: [{ mimeType: 'image/png', base64: 'AAA' }] },
    { role: 'assistant', text: 'Running tool', images: [], toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'tool', text: '', images: [], results: [{ callId: 'call_1', name: 'read_file', output: 'hello' }] },
  ]);
  assert.equal(items.length, 4);
  assert.equal(items[0].type, 'message');
  assert.equal(items[0].content[0].type, 'input_image');
  assert.equal(items[0].content[1].type, 'input_text');
  assert.equal(items[1].type, 'message');
  assert.equal(items[1].role, 'assistant');
  assert.equal(items[2].type, 'function_call');
  assert.equal(items[2].call_id, 'call_1');
  assert.equal(items[3].type, 'function_call_output');
  assert.equal(items[3].output, 'hello');
});

test('auto load balancing prefers highest bottleneck usage, skips cooled-down accounts, and LRU-ties', () => {
  const router = loadSrc('lib/subscriptions/router');
  const now = 1_700_000_000_000;
  const endpoint = {
    id: 'ep1',
    name: 'Claude',
    accountMode: 'auto',
    subscriptionAccounts: [
      { id: 'a1', label: 'alice@test.com', addedAt: 1 },
      { id: 'a2', label: 'bob@test.com', addedAt: 2 },
      { id: 'a3', label: 'carol@test.com', addedAt: 3 },
    ],
  };

  // a1 has 90% 5h but only 10% 7d (bottleneck=10); a2 has 60% 5h and 80% 7d (bottleneck=60); a3 has 61% both.
  const byAccount = {
    'ep1:a1': { windows: [{ id: '5h', label: '5-hour', remainingPercent: 90, usedPercent: 10 }, { id: '7d', label: '7-day', remainingPercent: 10, usedPercent: 90 }], fetchedAt: now },
    'ep1:a2': { windows: [{ id: '5h', label: '5-hour', remainingPercent: 60, usedPercent: 40 }, { id: '7d', label: '7-day', remainingPercent: 80, usedPercent: 20 }], fetchedAt: now },
    'ep1:a3': { windows: [{ id: '5h', label: '5-hour', remainingPercent: 61, usedPercent: 39 }, { id: '7d', label: '7-day', remainingPercent: 61, usedPercent: 39 }], fetchedAt: now },
  };

  // a2 and a3 are within 2% bottleneck -> LRU tie-breaker picks least recently used (a2 was used later, so a3 wins).
  const lru = new Map([
    ['ep1:a2', now - 1000],
    ['ep1:a3', now - 5000],
  ]);
  const ranked1 = router.rankSubscriptionAccounts(endpoint, { byAccount, now, lastUsedMap: lru, cooldownMap: new Map() });
  assert.deepEqual(ranked1.map((a) => a.id), ['a3', 'a2', 'a1']);

  // Put a3 on cooldown -> a2 moves to front, a3 moves to back.
  const cooldown = new Map([['ep1:a3', now + 60_000]]);
  const ranked2 = router.rankSubscriptionAccounts(endpoint, { byAccount, now, lastUsedMap: lru, cooldownMap: cooldown });
  assert.deepEqual(ranked2.map((a) => a.id), ['a2', 'a1', 'a3']);

  // Manual mode strictly selects only activeAccountId.
  const manualRanked = router.rankSubscriptionAccounts(
    { ...endpoint, accountMode: 'manual', activeAccountId: 'a1' },
    { byAccount, now }
  );
  assert.deepEqual(manualRanked.map((a) => a.id), ['a1']);
});

test('withSubscriptionAccount fails over on 429 in auto mode but not in manual mode', async () => {
  const http = loadSrc('lib/providers/http');
  let lastUsed = {};
  const subRoute = loadSrc('lib/providers/subscriptionRoute', {
    '@/store/subscriptionUsage': {
      useSubscriptionUsage: {
        getState: () => ({
          byAccount: {},
          setLastUsedAccount: (epId, accId) => {
            lastUsed[epId] = accId;
          },
        }),
      },
    },
    '../subscriptions': loadSrc('lib/subscriptions/router'),
    './http': http,
  });

  const ep = {
    id: 'ep_failover',
    name: 'Codex',
    accountMode: 'auto',
    subscriptionAccounts: [
      { id: 'acc_1', label: 'one@test.com', addedAt: 1 },
      { id: 'acc_2', label: 'two@test.com', addedAt: 2 },
    ],
  };

  const tried = [];
  const res = await subRoute.withSubscriptionAccount(ep, {}, async (acc) => {
    tried.push(acc.id);
    if (acc.id === 'acc_1') throw new http.ProviderError('429 Too Many Requests', 429, 60_000);
    return `ok:${acc.id}`;
  });
  assert.equal(res, 'ok:acc_2');
  assert.deepEqual(tried, ['acc_1', 'acc_2']);
  assert.equal(lastUsed.ep_failover, 'acc_2');

  // Manual mode should NOT fail over to acc_2.
  const manualTried = [];
  await assert.rejects(
    subRoute.withSubscriptionAccount({ ...ep, accountMode: 'manual', activeAccountId: 'acc_1' }, {}, async (acc) => {
      manualTried.push(acc.id);
      throw new http.ProviderError('429 Too Many Requests', 429);
    }),
    /429/
  );
  assert.deepEqual(manualTried, ['acc_1']);
});

test('Claude Code version parsing, npm resolution, and 400 version-gate retry', async () => {
  let npmVersion = '2.1.400';
  let npmFail = false;
  const mockFetch = async (url) => {
    if (String(url).includes('@anthropic-ai/claude-code/latest')) {
      if (npmFail) throw new Error('network down');
      return { ok: true, json: async () => ({ version: npmVersion }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const subs = loadSrc('lib/subscriptions/index', {
    'expo/fetch': { fetch: mockFetch },
    './credentials': {
      credentialSlot: (a, b) => `${a}:${b ?? ''}`,
      runExclusiveRefresh: (_s, fn) => fn(),
      subscriptionAuth: { get: async () => null, set: async () => {} },
    },
  });

  assert.equal(
    subs.parseRequiredClaudeCodeVersion(
      "400 Error: Claude Code 2.1.76 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again."
    ),
    '2.1.280'
  );
  assert.equal(subs.parseRequiredClaudeCodeVersion('400 Error: Invalid request'), null);
  assert.equal(subs.claudeCodeUserAgent('2.1.331'), 'claude-cli/2.1.331 (external, cli)');

  // Resolves latest from npm and caches it.
  const resolved = await subs.resolveClaudeCodeVersion();
  assert.equal(resolved, '2.1.400');
  assert.equal(subs.getCachedClaudeCodeVersion(), '2.1.400');

  // If npm is unreachable during a forced bump, honors minVersion floor.
  npmFail = true;
  const bumped = await subs.resolveClaudeCodeVersion({ force: true, minVersion: '2.2.0' });
  assert.equal(bumped, '2.2.0');
  assert.equal(subs.getCachedClaudeCodeVersion(), '2.2.0');

  // End-to-end claudeSub.stream retry on 400 minimum-version error.
  const http = loadSrc('lib/providers/http');
  const seenUserAgents = [];
  let attempt = 0;
  const claudeSubMod = loadSrc('lib/providers/claudeSub', {
    '@/store/subscriptionUsage': {
      useSubscriptionUsage: { getState: () => ({ byAccount: {}, setAccountUsage() {} }) },
    },
    '../subscriptions': {
      ...subs,
      accountUsageKey: (epId, accId) => `${epId}:${accId}`,
      getValidCredentials: async () => ({ accessToken: 'sk-ant-oat01-test' }),
      parseClaudeUsageHeaders: () => null,
    },
    './subscriptionRoute': {
      withSubscriptionAccount: async (_ep, _opts, fn) => fn({ id: 'acc_1', label: 'test', addedAt: 1 }),
    },
    './http': {
      ...http,
      request: async (_url, init) => {
        attempt += 1;
        seenUserAgents.push(init.headers['User-Agent']);
        if (attempt === 1) {
          throw new http.ProviderError(
            '400 Error: Claude Code 2.2.0 does not support this model; version 2.3.10 or newer is required.',
            400
          );
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi!"}}\n\n' +
                  'data: {"type":"message_stop"}\n\n'
              )
            );
            controller.close();
          },
        });
        return { headers: new Headers(), body: stream };
      },
    },
  });

  let reply = '';
  await claudeSubMod.claudeSub.stream({
    endpoint: { id: 'ep_claude', name: 'Claude', type: 'claude', baseUrl: 'https://api.anthropic.com' },
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', text: 'Hi', images: [] }],
    onToken: (t) => {
      reply += t;
    },
  });
  assert.equal(reply, 'Hi!');
  assert.deepEqual(seenUserAgents, ['claude-cli/2.2.0 (external, cli)', 'claude-cli/2.3.10 (external, cli)']);
});

// ---- Antigravity (Google AI Pro / Ultra via Cloud Code Assist) ----------------------------------

test('buildAntigravityAuthSession builds a first-party PKCE URL without openid scope', () => {
  const oauth = loadSrc('lib/subscriptions/oauth');
  const session = oauth.buildAntigravityAuthSession();
  const url = new URL(session.authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), oauth.ANTIGRAVITY_OAUTH.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:41783/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), session.pkce.state);
  assert.equal(url.searchParams.get('code_challenge'), session.pkce.challenge);
  // openid would route Google into the nativeapp flow that never completes.
  assert.ok(!url.searchParams.get('scope').includes('openid'));
  assert.ok(url.searchParams.get('scope').includes('cloud-platform'));
  const expected = crypto.createHash('sha256').update(session.pkce.verifier).digest('base64url');
  assert.equal(session.pkce.challenge, expected);
});

test('parseAntigravityCallback extracts the code and rejects errors or state mismatch', () => {
  const oauth = loadSrc('lib/subscriptions/oauth');
  const ok = oauth.parseAntigravityCallback('http://127.0.0.1:41783/callback?code=4%2Fabc&state=st1', 'st1');
  assert.deepEqual(ok, { code: '4/abc' });
  assert.throws(() => oauth.parseAntigravityCallback('http://127.0.0.1:41783/callback?code=x&state=bad', 'st1'), /state mismatch/i);
  assert.throws(
    () => oauth.parseAntigravityCallback('http://127.0.0.1:41783/callback?error=access_denied&error_description=User+closed', 'st1'),
    /access_denied/
  );
  assert.throws(() => oauth.parseAntigravityCallback('http://127.0.0.1:41783/callback', 'st1'), /No authorization code/i);
  // A redirect that leaves out the state is refused like a wrong one.
  assert.throws(() => oauth.parseAntigravityCallback('http://127.0.0.1:41783/callback?code=x', 'st1'), /state mismatch/i);
  assert.throws(() => oauth.parseAntigravityCallback('http://127.0.0.1:41783/callback?code=x&state=', 'st1'), /state mismatch/i);
});

test('parseAntigravityImport handles JSON blobs, ya29 tokens, and raw refresh tokens', () => {
  const oauth = loadSrc('lib/subscriptions/oauth');
  const json = oauth.parseAntigravityImport(
    JSON.stringify({ access_token: 'ya29.a0abc', refresh_token: '1//xyz', expires_in: 3599, cloudaicompanionProject: 'proj-9' })
  );
  assert.equal(json.accessToken, 'ya29.a0abc');
  assert.equal(json.refreshToken, '1//xyz');
  assert.equal(json.accountId, 'proj-9');
  assert.ok(json.expiresAt > Date.now());

  const epoch = oauth.parseAntigravityImport(JSON.stringify({ credentials: { access_token: 'ya29.x', expires_at: 1900000000 } }));
  assert.equal(epoch.expiresAt, 1900000000 * 1000);

  assert.deepEqual(oauth.parseAntigravityImport('  ya29.a0def '), { accessToken: 'ya29.a0def' });
  const bare = oauth.parseAntigravityImport('1//ghi');
  assert.equal(bare.accessToken, '');
  assert.equal(bare.refreshToken, '1//ghi');
  assert.throws(() => oauth.parseAntigravityImport(''), /Paste Antigravity credentials/);
});

test('cloudcode parsers: bootstrap responses, model catalog, quota buckets, 429 countdown', () => {
  const cc = loadSrc('lib/subscriptions/cloudcode');

  const loaded = cc.parseLoadCodeAssist({
    currentTier: { id: 'pro-tier', name: 'Google AI Pro' },
    cloudaicompanionProject: 'genai-skill-123',
  });
  assert.deepEqual(loaded, { projectId: 'genai-skill-123', tierId: 'pro-tier', planLabel: 'Google AI Pro' });

  // Live shape: currentTier is the runtime entitlement ('Antigravity'), paidTier is the real plan.
  const paying = cc.parseLoadCodeAssist({
    currentTier: { id: 'free-tier', name: 'Antigravity' },
    paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    cloudaicompanionProject: 'aicode-consumers',
  });
  assert.deepEqual(paying, { projectId: 'aicode-consumers', tierId: 'free-tier', planLabel: 'Google AI Pro' });

  const fresh = cc.parseLoadCodeAssist({ allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier' }] });
  assert.equal(fresh.needsOnboard, true);
  assert.equal(fresh.defaultTierId, 'free-tier');

  const blocked = cc.parseLoadCodeAssist({ ineligibleTiers: [{ reasonMessage: 'Region unavailable', tierId: 'pro-tier' }] });
  assert.equal(blocked.needsOnboard, true);
  assert.equal(blocked.defaultTierId, undefined);
  assert.equal(blocked.ineligibleReason, 'Region unavailable');

  assert.equal(cc.parseOnboardOperation({ done: true, response: { cloudaicompanionProject: { id: 'proj-42' } } }), 'proj-42');
  assert.equal(cc.parseOnboardOperation({ response: { cloudaicompanionProject: 'proj-43' } }), 'proj-43');
  assert.equal(cc.parseOnboardOperation({ name: 'operations/x' }), undefined);

  const models = cc.parseAntigravityModels({
    models: {
      'gemini-3-pro': { id: 'gemini-3-pro', displayName: ' Gemini 3 Pro ', maxRequestTokenCount: 1048576 },
      'claude-sonnet-4-6': { name: 'projects/x/claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      'internal-router': { id: 'internal-router' },
      // Live 2.11.0 fields: maxTokens carries the context window; internal ids stay out of the picker.
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
      chat_20706: { displayName: 'Chat 20706', maxTokens: 16384 },
      tab_flash_lite_preview: { displayName: 'Tab', maxTokens: 16384 },
      'gemini-3.8-flash-tiered': { maxTokens: 1048576 },
      'models/proactive-observer-v10': { displayName: 'Observer' },
    },
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'gemini-3-pro'] }] }],
  });
  assert.deepEqual(models.map((m) => m.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'gemini-3-pro']);
  assert.equal(models[2].displayName, 'Gemini 3 Pro');
  assert.equal(models[2].contextLength, 1048576);
  assert.equal(models[0].contextLength, 1048576);

  // With a Recommended list, labelled utility models outside it stay out of the picker.
  const curated = cc.parseAntigravityModels({
    models: {
      'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', maxTokens: 1048576 },
      'gemini-4-neon-xhigh': { displayName: 'Gemini 4 Neon (XHigh)', maxTokens: 1048576 },
      'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
      'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite' },
      'gemini-4-hydrogen-tiered-xhigh': { displayName: 'Tiered' },
    },
    agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gone-model'] }] }],
  });
  assert.deepEqual(curated.map((m) => m.id), ['gemini-4-neon-high', 'gemini-4-neon-xhigh']);

  // Without sorts: every labelled, non-internal model, sorted by id.
  const unsorted = cc.parseAntigravityModels({
    models: {
      'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)' },
      'gemini-flash-worker-agy': { displayName: 'Worker' },
      'gemini-4-hydrogen-sonar': { displayName: 'Sonar' },
      'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite' },
    },
  });
  assert.deepEqual(unsorted.map((m) => m.id), ['gemini-3.5-flash-lite', 'gemini-4-neon-high']);

  // Live retrieveUserQuotaSummary shape: two pooled groups, each with 5h + weekly.
  const summaryNow = 1_764_000_000_000;
  const summary = cc.parseAntigravityQuotaSummary(
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-12-01T12:33:16Z', remainingFraction: 0.6047009 },
            { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-11-26T08:35:03Z', remainingFraction: 0.98215425 },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            // proto3 omits zero: a fully used bucket has no remainingFraction.
            { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-12-03T05:28:29Z' },
            { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-26T10:28:29Z', remainingFraction: 0.99992967 },
          ],
        },
      ],
    },
    { email: 'me@gmail.com', plan: 'Google AI Pro', now: summaryNow }
  );
  assert.equal(summary.plan, 'Google AI Pro');
  assert.deepEqual(
    summary.windows.map((w) => [w.id, w.label, w.remainingPercent]),
    [
      ['gemini-5h', 'Gemini · 5-hour', 98],
      ['gemini-weekly', 'Gemini · weekly', 60],
      ['3p-5h', 'Claude & GPT · 5-hour', 100],
      ['3p-weekly', 'Claude & GPT · weekly', 0],
    ]
  );
  assert.equal(summary.windows[0].resetsAt, Date.parse('2026-11-26T08:35:03Z'));
  assert.equal(cc.parseAntigravityQuotaSummary({ groups: [] }), null);
  assert.equal(cc.parseAntigravityQuotaSummary({}), null);

  // Effort is baked into these catalog ids (incl. -xhigh), so no slider.
  const { guessEfforts } = loadSrc('lib/providers/effort');
  for (const id of ['gemini-4-neon-xhigh', 'gemini-4-carbon-medium', 'claude-opus-5-5-low', 'gemini-3.8-flash-high']) {
    assert.equal(guessEfforts('antigravity', id), undefined, id);
  }

  // The client identifies as the Antigravity CLI — the desktop-app UA gets no Gemini 4.
  assert.match(cc.ANTIGRAVITY_USER_AGENT, /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=android; arch=arm64; auth_method=consumer\)$/);

  const now = 1_700_000_000_000;
  const quota = cc.parseAntigravityQuota(
    {
      buckets: [
        { modelId: 'gemini-3-pro', remainingFraction: 0.9, resetTime: new Date(now + 2 * 3_600_000).toISOString(), remainingAmount: '900' },
        { modelId: 'gemini-3-flash', remainingFraction: 0.55, resetTime: new Date(now + 3 * 3_600_000).toISOString() },
        { modelId: 'claude-opus-4-6', remainingFraction: '0.05', resetTime: new Date(now + 7 * 24 * 3_600_000).toISOString() },
        { modelId: 'gemini-4-pro', remainingFraction: 0.4, resetTime: new Date(now + 6 * 24 * 3_600_000).toISOString() },
        { modelId: 'mystery-router', remainingFraction: 0.7 },
        // Live internal sentinels (tab/autocomplete) always report full — never bars.
        { tokenType: 'WTUS', modelId: 'chat_20706', remainingFraction: 1 },
        { tokenType: 'WTUS', modelId: 'chat_23310', remainingFraction: 1 },
        { remainingFraction: 'nonsense' },
      ],
    },
    { email: 'me@gmail.com', plan: 'Ultra', now }
  );
  assert.equal(quota.plan, 'Ultra');
  assert.equal(quota.email, 'me@gmail.com');
  // Per-model buckets aggregate into family+period pools (tightest member wins); unknown models keep their own bar.
  assert.deepEqual(quota.windows.map((w) => w.id), ['thirdparty|weekly', 'gemini|weekly', 'gemini|5h', 'other||mystery-router']);
  assert.equal(quota.windows[0].remainingPercent, 5);
  assert.equal(quota.windows[0].label, 'Claude & GPT · weekly');
  assert.equal(quota.windows[0].resetsAt, now + 7 * 24 * 3_600_000);
  assert.equal(quota.windows[1].remainingPercent, 40);
  assert.equal(quota.windows[1].label, 'Gemini · weekly');
  assert.equal(quota.windows[2].remainingPercent, 55);
  assert.equal(quota.windows[2].label, 'Gemini · 5-hour');
  assert.equal(quota.windows[2].detail, 'lowest: gemini 3 flash');
  assert.equal(quota.windows[2].resetsAt, now + 3 * 3_600_000);
  assert.equal(quota.windows[3].label, 'mystery router');

  assert.equal(cc.parseAntigravityRetryMs('429 Quota exceeded. Your quota will reset after 2h7m23s.'), (2 * 3600 + 7 * 60 + 23) * 1000);
  assert.equal(cc.parseAntigravityRetryMs('reset after 45s'), 45_000);
  assert.equal(cc.parseAntigravityRetryMs('Too many requests'), undefined);

  assert.equal(cc.formatCloudCodePlan('free-tier'), 'Free');
  assert.equal(cc.formatCloudCodePlan('ultra_tier', 'Google AI Ultra'), 'Google AI Ultra');

  const envelope = cc.buildAntigravityEnvelope('gemini-3-pro', 'proj-9', { contents: [] }, 'up-1');
  assert.deepEqual(envelope, { model: 'gemini-3-pro', project: 'proj-9', user_prompt_id: 'up-1', request: { contents: [] } });
  assert.equal('project' in cc.buildAntigravityEnvelope('m', undefined, {}, 'u'), false);
});

test('antigravity adapter posts the strict envelope and parses nested SSE chunks', async () => {
  const http = loadSrc('lib/providers/http');
  const cc = loadSrc('lib/subscriptions/cloudcode');
  const seen = [];
  const persist = [];
  let reply = '';
  let reasoning = '';
  let sseBody;

  // Per-request failure rules: ids the server doesn't know (404) and configs it rejects (400).
  let unknownModels = new Set();
  let rejectsConfig = () => false;
  const mockFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    seen.push({ url: String(url), body, ua: init?.headers?.['User-Agent'] });
    if (sseBody instanceof Error) throw sseBody;
    if (body && unknownModels.has(body.model)) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":{"message":"Requested entity was not found."}}' };
    }
    if (body && rejectsConfig(body.request?.generationConfig)) {
      return { ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"error":{"message":"Invalid thinking level"}}' };
    }
    if (sseBody.status) {
      return { ok: false, status: sseBody.status, statusText: 'Too Many Requests', text: async () => sseBody.text };
    }
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      }),
    };
  };

  const subs = {
    ANTIGRAVITY_USER_AGENT: cc.ANTIGRAVITY_USER_AGENT,
    ANTIGRAVITY_VERSION: cc.ANTIGRAVITY_VERSION,
    CLOUDCODE_HOSTS: [...cc.CLOUDCODE_HOSTS],
    buildAntigravityEnvelope: cc.buildAntigravityEnvelope,
    parseAntigravityRetryMs: cc.parseAntigravityRetryMs,
    groupAntigravityVariants: cc.groupAntigravityVariants,
    antigravityModelCandidates: cc.antigravityModelCandidates,
    bootstrapAntigravityProject: async () => ({ projectId: 'proj-live', planLabel: 'Ultra' }),
    // Live catalog shape: effort variants, a single-variant model, and a plain model.
    fetchAntigravityModels: async () => [
      { id: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)', contextLength: 1_048_576 },
      { id: 'gemini-4-neon-xhigh', displayName: 'Gemini 4 Neon (XHigh)', contextLength: 1_048_576 },
      { id: 'gemini-4-neon-medium', displayName: 'Gemini 4 Neon (Medium)', contextLength: 1_048_576 },
      { id: 'gemini-4-neon-low', displayName: 'Gemini 4 Neon (Low)', contextLength: 1_048_576 },
      { id: 'claude-opus-5-5-low', displayName: 'Claude Opus 5.5 (Low)', contextLength: 1_000_000 },
      { id: 'claude-opus-5-5-high', displayName: 'Claude Opus 5.5 (High)', contextLength: 1_000_000 },
      { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', contextLength: 131_072 },
      { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', contextLength: 1_000_000 },
    ],
    getValidCredentials: async () => ({ accessToken: 'ya29.tok', refreshToken: '1//rt' }),
    randomUuid: () => 'uuid-fixed',
    subscriptionAuth: { set: async (_ep, creds, acc) => persist.push({ slot: `${_ep}:${acc}`, projectId: creds.accountId, plan: creds.plan }) },
  };
  const deps = {
    '../subscriptions': subs,
    '../storage': { uid: () => 'u1' },
    '@/lib/net': { fetch: mockFetch },
    './http': http,
    './subscriptionRoute': { withSubscriptionAccount: async (_ep, _o, fn) => fn({ id: 'acc_1', label: 'me@gmail.com', addedAt: 1 }) },
  };
  const ag = loadSrc('lib/providers/antigravity', deps);
  const endpoint = { id: 'ep_ag', name: 'Antigravity', type: 'antigravity', baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal' };

  sseBody =
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"thinking hard","thought":true}]}}]}}\n\n' +
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hi"},{"functionCall":{"id":"c1","name":"search","args":{"q":"x"}}}]}}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":5,"thoughtsTokenCount":7,"cachedContentTokenCount":2}}}\n\n';

  const result = await ag.antigravity.stream({
    endpoint,
    model: 'gemini-4-neon',
    effort: 'xhigh',
    messages: [{ role: 'user', text: 'hello', images: [] }],
    onToken: (t) => {
      reply += t;
    },
    onReasoning: (t) => {
      reasoning += t;
    },
  });

  assert.equal(reply, 'Hi');
  assert.equal(reasoning, 'thinking hard');
  assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'search', input: { q: 'x' }, signature: undefined }]);
  assert.deepEqual(result.usage, { output: 12, input: 11, cached: 2 });

  const streamReq = seen[0];
  assert.match(streamReq.url, /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(Object.keys(streamReq.body).sort(), ['model', 'project', 'request', 'user_prompt_id']);
  assert.equal(streamReq.body.project, 'proj-live');
  assert.match(streamReq.body.user_prompt_id, /^[0-9a-f-]{36}$/);
  assert.equal(streamReq.ua, cc.ANTIGRAVITY_USER_AGENT);
  assert.equal(streamReq.body.request.contents[0].parts[0].text, 'hello');
  // The grouped model + effort becomes the variant id, with thoughts requested at that level.
  assert.equal(streamReq.body.model, 'gemini-4-neon-xhigh');
  assert.deepEqual(streamReq.body.request.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' } });
  // project + plan persisted after bootstrap
  assert.deepEqual(persist, [{ slot: 'ep_ag:acc_1', projectId: 'proj-live', plan: 'Ultra' }]);

  const okBody = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n';
  const streamOnce = async (model, effort) => {
    seen.length = 0;
    await ag.antigravity.stream({ endpoint, model, effort, messages: [{ role: 'user', text: 'hi', images: [] }], onToken: () => {} });
    return seen.map((s) => [s.body.model, s.body.request.generationConfig ?? null]);
  };
  sseBody = okBody;

  // A variant id saved before grouping is still sent as-is, at its own level.
  assert.deepEqual(await streamOnce('gemini-4-neon-high'), [
    ['gemini-4-neon-high', { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } }],
  ]);
  // A plain model with no effort still asks for thoughts — without it Google withholds them.
  assert.deepEqual(await streamOnce('gemini-3-pro'), [['gemini-3-pro', { thinkingConfig: { includeThoughts: true } }]]);
  // A plain model with an effort: the variant id 404s, so it falls back to the Gemini thinking level.
  unknownModels = new Set(['gemini-3-pro-high']);
  assert.deepEqual(await streamOnce('gemini-3-pro', 'high'), [
    ['gemini-3-pro-high', { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } }],
    ['gemini-3-pro', { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } }],
  ]);
  unknownModels = new Set();
  // A rejected thinking level is retried asking only for thoughts, keeping them on.
  rejectsConfig = (cfg) => Boolean(cfg?.thinkingConfig?.thinkingLevel);
  assert.deepEqual(await streamOnce('claude-opus-5-5', 'high'), [
    ['claude-opus-5-5-high', { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } }],
    ['claude-opus-5-5-high', { thinkingConfig: { includeThoughts: true } }],
  ]);
  rejectsConfig = () => false;

  // 429 body countdown becomes retryAfterMs for the account cooldown.
  sseBody = { status: 429, text: JSON.stringify({ error: { message: '429 Quota exceeded. Your quota will reset after 2h7m23s.' } }) };
  await assert.rejects(
    ag.antigravity.stream({
      endpoint,
      model: 'gemini-3-pro',
      messages: [{ role: 'user', text: 'hello', images: [] }],
      onToken: () => {},
    }),
    (e) => {
      assert.ok(e instanceof http.ProviderError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, (2 * 3600 + 7 * 60 + 23) * 1000);
      return true;
    }
  );

  const models = await ag.antigravity.listModels(endpoint);
  // Effort variants collapse into one model per family, levels lowest first; a single variant
  // keeps its full id; a plain gemini-3-pro gets the two-level ladder, same as the Gemini API.
  assert.deepEqual(models.models, [
    { id: 'gemini-4-neon', efforts: ['low', 'medium', 'high', 'xhigh'], contextLength: 1_048_576 },
    { id: 'claude-opus-5-5', efforts: ['low', 'high'], contextLength: 1_000_000 },
    { id: 'gpt-oss-120b-medium', contextLength: 131_072 },
    { id: 'gemini-3-pro', efforts: ['low', 'high'], contextLength: 1_000_000 },
  ]);
});

// ---- Endpoint headers in the keychain -----------------------------------------------------------

/** A keychain that keeps items in memory, refusing writes while `failing`. */
function fakeSecureStore() {
  const items = new Map();
  const store = {
    items,
    failing: false,
    getItemAsync: async (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => {
      if (store.failing) throw new Error('keystore unavailable');
      if (!/^[A-Za-z0-9._-]+$/.test(k)) throw new Error(`invalid key ${k}`);
      items.set(k, v);
    },
    deleteItemAsync: async (k) => void items.delete(k),
  };
  return store;
}

/**
 * The settings store as far as endpoint headers go: a zustand store persisted to `disk` (a Map of
 * JSON text) that leaves out headers the keychain holds, as src/store/settings.ts does.
 */
function launchSettings(disk, secureStore) {
  const { create } = require('zustand');
  const { persist, createJSONStorage } = require('zustand/middleware');
  const secrets = loadSrc('lib/secrets', { 'expo-secure-store': secureStore });
  const storage = createJSONStorage(() => ({
    getItem: (k) => disk.get(k) ?? null,
    setItem: (k, v) => void disk.set(k, v),
    removeItem: (k) => void disk.delete(k),
  }));
  const useSettings = create()(
    persist((set) => ({ endpoints: [], setEndpoints: (endpoints) => set({ endpoints }) }), {
      name: 'settings',
      storage,
      version: 3,
      partialize: (s) => ({ ...s, endpoints: s.endpoints.map(secrets.persistedEndpoint) }),
    })
  );
  secrets.endpointHeaderSecrets.attach(useSettings);
  return { secrets, useSettings, saved: () => JSON.parse(disk.get('settings')).state.endpoints };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
};

const SECRET_HEADERS = { Authorization: 'Bearer secret', 'CF-Access-Client-Secret': 'x'.repeat(3000) };

test('endpoint headers move from settings.json to the keychain on first launch, and come back on the next', async () => {
  const endpoints = [{ id: 'e1', baseUrl: 'https://a' }, { id: 'e2', baseUrl: 'https://b', headers: SECRET_HEADERS }];
  const disk = new Map([['settings', JSON.stringify({ version: 3, state: { endpoints } })]]);
  const keychain = fakeSecureStore();

  // First launch after the upgrade: requests still have the headers, and the file loses them.
  let app = launchSettings(disk, keychain);
  await app.secrets.endpointHeaderSecrets.ready();
  await settle();
  assert.deepEqual(app.useSettings.getState().endpoints[1].headers, SECRET_HEADERS);
  assert.ok(!disk.get('settings').includes('Bearer secret'), 'no header left in settings.json');
  assert.equal(app.saved()[1].headers, undefined);
  // Larger than one Android keychain item, so it's split.
  assert.match(keychain.items.get('endpoint_headers_e2'), /^chunks:/);
  assert.equal(keychain.items.has('endpoint_headers_e1'), false);

  // Next launch: read back from the keychain.
  app = launchSettings(disk, keychain);
  const stale = { ...app.useSettings.getState().endpoints[1] };
  assert.equal(stale.headers, undefined, 'not loaded yet');
  // A request made before then waits for them.
  assert.deepEqual((await app.secrets.withSavedHeaders(stale)).headers, SECRET_HEADERS);
  await settle();
  assert.deepEqual(app.useSettings.getState().endpoints[1].headers, SECRET_HEADERS);
  // An endpoint given headers, even none (the editor's draft), is used as it is.
  assert.deepEqual((await app.secrets.withSavedHeaders({ id: 'e2', headers: {} })).headers, {});

  // Changing and clearing headers follows into the keychain.
  const [e1, e2] = app.useSettings.getState().endpoints;
  app.useSettings.getState().setEndpoints([{ ...e1, headers: { 'X-Key': 'k' } }, { ...e2, headers: {} }]);
  await settle();
  assert.equal(keychain.items.get('endpoint_headers_e1'), JSON.stringify({ 'X-Key': 'k' }));
  assert.equal(keychain.items.has('endpoint_headers_e2'), false);
  assert.equal(keychain.items.has('endpoint_headers_e2_0'), false);
  assert.ok(!disk.get('settings').includes('X-Key'));

  // Removing an endpoint removes its headers.
  app.useSettings.getState().setEndpoints([e2]);
  await settle();
  assert.equal(keychain.items.has('endpoint_headers_e1'), false);
});

test('endpoint headers stay in settings.json while the keychain refuses them', async () => {
  const endpoints = [{ id: 'e1', baseUrl: 'https://a', headers: { Authorization: 'Bearer secret' } }];
  const disk = new Map([['settings', JSON.stringify({ version: 3, state: { endpoints } })]]);
  const keychain = fakeSecureStore();
  keychain.failing = true;
  let app = launchSettings(disk, keychain);
  await settle();
  app.useSettings.setState({});
  assert.deepEqual(app.saved()[0].headers, { Authorization: 'Bearer secret' }, 'kept rather than lost');
  assert.deepEqual(app.useSettings.getState().endpoints[0].headers, { Authorization: 'Bearer secret' });

  // A later launch, with the keychain working again, finishes the move.
  keychain.failing = false;
  app = launchSettings(disk, keychain);
  await settle();
  assert.equal(app.saved()[0].headers, undefined);
  assert.equal(keychain.items.get('endpoint_headers_e1'), JSON.stringify({ Authorization: 'Bearer secret' }));
});
