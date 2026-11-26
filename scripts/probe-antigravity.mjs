#!/usr/bin/env node
/**
 * Live shape probe for the Antigravity / Cloud Code Assist API.
 *
 *   node scripts/probe-antigravity.mjs                     # interactive sign-in on this PC, then probe
 *   node scripts/probe-antigravity.mjs --token ya29...     # reuse an access token (dumped by the app)
 *   node scripts/probe-antigravity.mjs --model gemini-3-pro --prompt "hi"
 *
 * Sign-in without the phone: the script prints the same authorize URL the app loads in its WebView.
 * Open it anywhere, approve, and the browser lands on http://127.0.0.1:41783/callback?code=… (the page
 * will fail to load — nothing is listening). Copy that final URL from the address bar and paste it
 * back here; the code is exchanged on this machine with the same PKCE verifier.
 *
 * Dumps condensed JSON so the real response shapes (loadCodeAssist, fetchAvailableModels,
 * retrieveUserQuota, streamGenerateContent SSE chunks) can be checked against src/lib/subscriptions/cloudcode.ts.
 */
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// Same OAuth client the app uses, read from the gitignored .env.local (see src/lib/subscriptions/oauth.ts).
try {
  process.loadEnvFile(new URL('../.env.local', import.meta.url));
} catch {}
const CLIENT_ID = process.env.EXPO_PUBLIC_ANTIGRAVITY_CLIENT_ID;
const CLIENT_SECRET = process.env.EXPO_PUBLIC_ANTIGRAVITY_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set EXPO_PUBLIC_ANTIGRAVITY_CLIENT_ID and EXPO_PUBLIC_ANTIGRAVITY_CLIENT_SECRET in .env.local first.');
  process.exit(1);
}
const REDIRECT = 'http://127.0.0.1:41783/callback';
const SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email';
// Same identity as src/lib/subscriptions/cloudcode.ts: the Antigravity CLI UA unlocks the full catalog.
const UA = `antigravity/cli/${process.env.AGY_VERSION || '1.5.17'} (aidev_client; os_type=android; arch=arm64; auth_method=consumer)`;
// Daily is the live surface for current clients; prod is a fallback.
const HOSTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const METADATA_VARIANTS = [
  { ideType: 'ANTIGRAVITY' },
  { ideType: 'GEMINI_CLI', platform: 'DARWIN_ARM64', pluginType: 'GEMINI' },
  { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
];
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Condense a JSON value: keep structure, clamp strings/arrays, redact token-ish values. */
function shape(v, depth = 0) {
  const pad = '  '.repeat(depth);
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    const s = /^(ya29[.\S]{6,}|1\/[.\S]{6,}|[\w-]{80,})$/.test(v) ? `${v.slice(0, 14)}…(${v.length})` : v;
    return s.length > 120 ? `${JSON.stringify(s.slice(0, 120))}…` : JSON.stringify(s);
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const head = v.slice(0, 3).map((x) => `${pad}  ${shape(x, depth + 1)}`);
    return `(${v.length}) [\n${head.join(',\n')}${v.length > 3 ? `,\n${pad}  …+${v.length - 3}` : ''}\n${pad}]`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  const lines = keys.slice(0, 24).map((k) => `${pad}  ${k}: ${shape(v[k], depth + 1)}`);
  return `{\n${lines.join(',\n')}${keys.length > 24 ? `,\n${pad}  …+${keys.length - 24} keys` : ''}\n${pad}}`;
}

async function manualSignIn() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  Object.entries({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: b64url(crypto.randomBytes(16)),
    access_type: 'offline',
    prompt: 'consent',
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  console.log('\nOpen this URL in a browser and approve:\n\n' + url.toString() + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question('Paste the final http://127.0.0.1:41783/callback?… URL: ')).trim();
  rl.close();
  const params = new URL(pasted).searchParams;
  if (params.get('error')) throw new Error(`Google returned ${params.get('error')}: ${params.get('error_description') ?? ''}`);
  const code = params.get('code');
  if (!code) throw new Error('No code= in the pasted URL.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  console.log('Token exchanged. refresh_token:', json.refresh_token ? 'yes' : 'NO (re-consent needed!)');
  return json.access_token;
}

async function post(token, host, method, body) {
  const res = await fetch(`${host}/v1internal:${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 400);
  }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const token = arg('token') || (await manualSignIn());

  console.log('\n=== userinfo ===');
  const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  console.log(shape(who));

  let project = arg('project');
  console.log('\n=== loadCodeAssist ===');
  for (const metadata of METADATA_VARIANTS) {
    const r = await post(token, HOSTS[0], 'loadCodeAssist', { metadata });
    console.log(`metadata=${metadata.ideType} -> HTTP ${r.status}`);
    if (!r.ok) continue;
    console.log(shape(r.json));
    project ??= typeof r.json?.cloudaicompanionProject === 'string' ? r.json.cloudaicompanionProject : undefined;
    if (!project && r.json?.currentTier) {
      console.log('!! currentTier present but no cloudaicompanionProject — probe cannot continue without --project');
    }
    if (!project && !r.json?.currentTier && !args.includes('--no-onboard')) {
      const tierId = (r.json?.allowedTiers ?? []).find((t) => t?.isDefault)?.id ?? 'free-tier';
      console.log(`\n=== onboardUser (tier ${tierId}) ===`);
      const ob = await post(token, HOSTS[0], 'onboardUser', { tierId, metadata });
      console.log(`HTTP ${ob.status}`, shape(ob.json));
      const name = ob.json?.name;
      for (let i = 0; name && !project && i < 24; i++) {
        await sleep(5000);
        const op = await fetch(`${HOSTS[0]}/v1internal/${encodeURIComponent(name)}`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
        }).then((r) => r.json());
        project = op?.response?.cloudaicompanionProject?.id ?? op?.response?.cloudaicompanionProject;
        if (op?.done) console.log('onboard done:', shape(op.response ?? op.error));
      }
    }
    break;
  }
  if (!project) {
    console.log('\nNo project resolved — rerun with --project <id> (models/quota/stream skipped).');
    return;
  }
  console.log(`\nproject = ${project}`);

  console.log('\n=== fetchAvailableModels ===');
  const models = await post(token, HOSTS[0], 'fetchAvailableModels', { project });
  console.log(`HTTP ${models.status}`, shape(models.json, 0));

  console.log('\n=== retrieveUserQuota ===');
  const quota = await post(token, HOSTS[0], 'retrieveUserQuota', { project });
  console.log(`HTTP ${quota.status}`, shape(quota.json));

  console.log('\n=== streamGenerateContent (alt=sse) ===');
  const modelId = arg('model') ?? Object.keys(models.json?.models ?? {})[0] ?? 'gemini-2.5-flash';
  const res = await fetch(`${HOSTS[0]}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': UA },
    body: JSON.stringify({
      model: modelId,
      project,
      user_prompt_id: crypto.randomUUID(),
      request: { contents: [{ role: 'user', parts: [{ text: arg('prompt') ?? 'Reply with exactly one word: OK' }] }] },
    }),
  });
  console.log(`model=${modelId} HTTP ${res.status}`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 500));
    return;
  }
  let text = '';
  let chunks = 0;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let chunk;
      try {
        chunk = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (chunks < 2) console.log(`chunk#${chunks} top-level keys:`, Object.keys(chunk).join(','), '\n' + shape(chunk, 1));
      chunks++;
      for (const p of chunk?.response?.candidates?.[0]?.content?.parts ?? []) if (p.text) text += p.text;
    }
  }
  console.log(`(${chunks} data chunks) reply: ${JSON.stringify(text)}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
