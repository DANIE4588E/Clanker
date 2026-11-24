import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

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
      ...extraDeps,
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: abs })(
      (spec) => {
        if (spec in deps) return deps[spec];
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
