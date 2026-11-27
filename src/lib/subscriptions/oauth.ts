import { fetch } from '@/lib/net';
import { ProviderError } from '../providers/http';
import type { SubscriptionType } from '../providers/types';
import type { SubscriptionCredentials } from './credentials';
import { decodeJwtPayload, generatePkce, type PkcePair } from './pkce';

// ---- OAuth public client configuration (official CLI flows) ---------------------------------

export const CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  deviceUserCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  deviceVerifyUrl: 'https://auth.openai.com/codex/device',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  tokenUrl: 'https://auth.openai.com/oauth/token',
} as const;

export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  scopes: 'org:create_api_key user:profile user:inference',
} as const;

async function readError(res: { status: number; statusText?: string; text(): Promise<string> }) {
  const body = await res.text().catch(() => '');
  let msg = body;
  try {
    const json = JSON.parse(body);
    msg =
      json.error_description ??
      (typeof json.error === 'string' ? json.error : json.error?.message) ??
      json.message ??
      body;
  } catch {}
  return new ProviderError(`${res.status} ${res.statusText || 'Error'}${msg ? `: ${msg}` : ''}`, res.status);
}

function formBody(params: Record<string, string>) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function extractOpenAiClaims(accessToken: string, idToken?: string): { accountId?: string; email?: string; expiresAt?: number } {
  const access = decodeJwtPayload(accessToken);
  const id = idToken ? decodeJwtPayload(idToken) : null;
  const authClaim = access?.['https://api.openai.com/auth'] ?? id?.['https://api.openai.com/auth'];
  const profileClaim = access?.['https://api.openai.com/profile'] ?? id?.['https://api.openai.com/profile'];
  const accountId = typeof authClaim?.chatgpt_account_id === 'string' ? authClaim.chatgpt_account_id : undefined;
  const email =
    typeof profileClaim?.email === 'string'
      ? profileClaim.email
      : typeof id?.email === 'string'
        ? id.email
        : typeof access?.email === 'string'
          ? access.email
          : undefined;
  const expiresAt = typeof access?.exp === 'number' ? access.exp * 1000 : undefined;
  return { accountId, email, expiresAt };
}

// ---- Codex (OpenAI ChatGPT subscription) ----------------------------------------------------

export type CodexDeviceSession = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSec: number;
};

export async function startCodexDeviceAuth(): Promise<CodexDeviceSession> {
  const res = await fetch(CODEX_OAUTH.deviceUserCodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CODEX_OAUTH.clientId }),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as any;
  const deviceAuthId = String(data.device_auth_id ?? '');
  const userCode = String(data.user_code ?? data.usercode ?? '');
  if (!deviceAuthId || !userCode) throw new Error('OpenAI did not return a device code.');
  const intervalSec = Math.max(3, Number(data.interval) || 5);
  return {
    deviceAuthId,
    userCode,
    verificationUrl: String(data.verification_uri ?? CODEX_OAUTH.deviceVerifyUrl),
    intervalSec,
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Sign-in cancelled.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Sign-in cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollCodexDeviceAuth(
  session: CodexDeviceSession,
  signal: AbortSignal
): Promise<SubscriptionCredentials> {
  const deadline = Date.now() + 15 * 60 * 1000;
  let intervalMs = session.intervalSec * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs, signal);
    const res = await fetch(CODEX_OAUTH.deviceTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        device_auth_id: session.deviceAuthId,
        user_code: session.userCode,
      }),
      signal,
    });

    if (res.status === 403 || res.status === 404 || res.status === 428) continue;
    if (res.status === 429) {
      intervalMs = Math.min(intervalMs + 3000, 15000);
      continue;
    }
    if (!res.ok) throw await readError(res);

    const payload = (await res.json()) as any;
    // Direct token response (if OpenAI returns tokens directly from deviceauth/token).
    if (payload.access_token) {
      const claims = extractOpenAiClaims(payload.access_token, payload.id_token);
      return {
        accessToken: payload.access_token,
        ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
        expiresAt: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : claims.expiresAt,
        ...(claims.accountId ? { accountId: claims.accountId } : {}),
        ...(claims.email ? { email: claims.email } : {}),
      };
    }

    // Standard Codex device flow returns authorization_code + code_verifier for /oauth/token exchange.
    const authCode = payload.authorization_code;
    const codeVerifier = payload.code_verifier;
    if (!authCode || !codeVerifier) {
      throw new Error('Unexpected response while completing OpenAI sign-in.');
    }

    const tokenRes = await fetch(CODEX_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: CODEX_OAUTH.deviceRedirectUri,
        client_id: CODEX_OAUTH.clientId,
        code_verifier: codeVerifier,
      }),
      signal,
    });
    if (!tokenRes.ok) throw await readError(tokenRes);
    const tokens = (await tokenRes.json()) as any;
    if (!tokens.access_token) throw new Error('OpenAI token exchange returned no access token.');
    const claims = extractOpenAiClaims(tokens.access_token, tokens.id_token);
    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : claims.expiresAt,
      ...(claims.accountId ? { accountId: claims.accountId } : {}),
      ...(claims.email ? { email: claims.email } : {}),
    };
  }
  throw new Error('Sign-in timed out after 15 minutes. Start sign-in again.');
}

export async function refreshCodexToken(creds: SubscriptionCredentials): Promise<SubscriptionCredentials> {
  if (!creds.refreshToken) throw new Error('Codex session expired. Sign in again in Settings.');
  const res = await fetch(CODEX_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CODEX_OAUTH.clientId,
    }),
  });
  if (!res.ok) throw await readError(res);
  const tokens = (await res.json()) as any;
  if (!tokens.access_token) throw new Error('Codex token refresh returned no access token.');
  const claims = extractOpenAiClaims(tokens.access_token, tokens.id_token);
  return {
    ...creds,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? creds.refreshToken,
    expiresAt: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : claims.expiresAt,
    accountId: claims.accountId ?? creds.accountId,
    email: claims.email ?? creds.email,
  };
}

/** Parses pasted `~/.codex/auth.json` or raw token text into Codex credentials. */
export function parseCodexImport(raw: string): SubscriptionCredentials {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Paste ~/.codex/auth.json or an OAuth token.');
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    const t = json.tokens ?? json;
    const accessToken = String(t.access_token ?? t.accessToken ?? '');
    const refreshToken = t.refresh_token ?? t.refreshToken;
    const idToken = t.id_token ?? t.idToken;
    if (!accessToken && !refreshToken) throw new Error('No access_token or refresh_token found in JSON.');
    const claims = accessToken ? extractOpenAiClaims(accessToken, idToken) : {};
    return {
      accessToken,
      ...(refreshToken ? { refreshToken: String(refreshToken) } : {}),
      ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
      accountId: t.account_id ?? t.accountId ?? claims.accountId,
      email: claims.email,
    };
  }
  const claims = extractOpenAiClaims(trimmed);
  return {
    accessToken: trimmed,
    ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
    ...(claims.accountId ? { accountId: claims.accountId } : {}),
    ...(claims.email ? { email: claims.email } : {}),
  };
}

// ---- Claude (Anthropic Pro / Max subscription) ----------------------------------------------

export type BrowserCodeSession = {
  pkce: PkcePair;
  authorizeUrl: string;
};

export function buildClaudeAuthSession(): BrowserCodeSession {
  const pkce = generatePkce();
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
  });
  return { pkce, authorizeUrl: `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}` };
}

/** Extracts `code` (and optional `state`) from a pasted `code#state`, callback URL, or raw code. */
export function parsePastedAuthCode(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Paste the authorization code from your browser.');
  // Full URL paste (e.g. https://.../callback?code=...&state=...)
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? undefined;
    if (!code) throw new Error('No authorization code found in the pasted URL.');
    return { code: code.trim(), state: state?.trim() };
  }
  // Claude's callback page displays `code#state`.
  const hash = trimmed.indexOf('#');
  if (hash > 0) {
    return { code: trimmed.slice(0, hash).trim(), state: trimmed.slice(hash + 1).trim() || undefined };
  }
  return { code: trimmed };
}

export async function exchangeClaudeAuthCode(
  pasted: string,
  session: BrowserCodeSession
): Promise<SubscriptionCredentials> {
  const { code, state } = parsePastedAuthCode(pasted);
  // Claude's callback page shows `code#state`. People sometimes copy only the code, so a paste
  // without the state is allowed (it's sent with the one this sign-in made), but a different state
  // means the code came from another sign-in and isn't exchanged.
  if (state !== undefined && state !== session.pkce.state) {
    throw new Error('That code is from a different sign-in. Start sign-in again and paste the new code.');
  }
  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH.clientId,
      code,
      state: session.pkce.state,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      code_verifier: session.pkce.verifier,
    }),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as any;
  if (!data.access_token) throw new Error('Claude token exchange returned no access token.');
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
    email: data.account?.email_address ?? data.email,
  };
}

export async function refreshClaudeToken(creds: SubscriptionCredentials): Promise<SubscriptionCredentials> {
  if (!creds.refreshToken) throw new Error('Claude session expired. Sign in again in Settings.');
  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLAUDE_OAUTH.clientId,
      refresh_token: creds.refreshToken,
    }),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as any;
  if (!data.access_token) throw new Error('Claude token refresh returned no access token.');
  return {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : creds.expiresAt,
  };
}

/** Parses pasted `~/.claude/.credentials.json` or a raw `sk-ant-oat01-...` OAuth token. */
export function parseClaudeImport(raw: string): SubscriptionCredentials {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Paste ~/.claude/.credentials.json or an OAuth token.');
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    const oauth = json.claudeAiOauth ?? json;
    const accessToken = String(oauth.accessToken ?? oauth.access_token ?? '');
    const refreshToken = oauth.refreshToken ?? oauth.refresh_token;
    const expiresAt = oauth.expiresAt ?? oauth.expires_at;
    if (!accessToken && !refreshToken) throw new Error('No accessToken or refreshToken found in JSON.');
    return {
      accessToken,
      ...(refreshToken ? { refreshToken: String(refreshToken) } : {}),
      ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      ...(typeof oauth.subscriptionType === 'string' ? { plan: oauth.subscriptionType } : {}),
    };
  }
  return { accessToken: trimmed };
}

// ---- Antigravity (Google AI Pro / Ultra via Cloud Code Assist) --------------------------------

/**
 * The installed-app OAuth client the Antigravity IDE/CLI ship with — the client the Cloud Code
 * quota endpoint honors for AI Pro/Ultra entitlements. Its secret is non-confidential by design
 * (installed-app clients can't keep secrets), but it's Google's, not ours, so it stays out of the
 * repo: set both in `.env.local` (gitignored), which Expo CLI inlines into the bundle. Expo only
 * inlines the literal `process.env.EXPO_PUBLIC_…` dot form, so don't destructure these.
 */
export const ANTIGRAVITY_OAUTH = {
  clientId: process.env.EXPO_PUBLIC_ANTIGRAVITY_CLIENT_ID ?? '',
  clientSecret: process.env.EXPO_PUBLIC_ANTIGRAVITY_CLIENT_SECRET ?? '',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scopes: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email',
  /** Synthetic loopback redirect: nothing listens, the WebView intercepts the navigation. */
  redirectUri: 'http://127.0.0.1:41783/callback',
  /** Plain Chrome UA so Google's consent page doesn't reject the WebView as "disallowed_useragent". */
  webviewUserAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
} as const;

/** The configured OAuth client, or a clear error when `.env.local` is missing it. */
function antigravityClient(): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = ANTIGRAVITY_OAUTH;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Antigravity sign-in is not configured in this build. Set EXPO_PUBLIC_ANTIGRAVITY_CLIENT_ID and ' +
        'EXPO_PUBLIC_ANTIGRAVITY_CLIENT_SECRET in .env.local, then restart the bundler.'
    );
  }
  return { clientId, clientSecret };
}

export function buildAntigravityAuthSession(): BrowserCodeSession {
  const { clientId } = antigravityClient();
  const pkce = generatePkce();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ANTIGRAVITY_OAUTH.redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY_OAUTH.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return { pkce, authorizeUrl: `${ANTIGRAVITY_OAUTH.authorizeUrl}?${params.toString()}` };
}

/**
 * Extracts the authorization code from a navigation to the loopback redirect. Throws on Google
 * error redirects (`?error=access_denied`) and on state mismatch. Pure so tests can cover it.
 */
export function parseAntigravityCallback(url: string, expectedState: string): { code: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Antigravity sign-in redirect could not be parsed.');
  }
  const err = parsed.searchParams.get('error');
  if (err) {
    const desc = parsed.searchParams.get('error_description');
    throw new Error(`Google sign-in ${err}${desc ? `: ${desc}` : ''}`);
  }
  const code = parsed.searchParams.get('code');
  if (!code) throw new Error('No authorization code in the Antigravity redirect.');
  // Google always returns the state it was sent, so a missing one is refused like a wrong one.
  if (!expectedState || parsed.searchParams.get('state') !== expectedState) {
    throw new Error('Antigravity sign-in state mismatch. Try again.');
  }
  return { code };
}

async function exchangeGoogleToken(body: Record<string, string>): Promise<SubscriptionCredentials> {
  const res = await fetch(ANTIGRAVITY_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody(body),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as any;
  if (!data.access_token) throw new Error('Google token exchange returned no access token.');
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
  };
}

export async function exchangeAntigravityAuthCode(
  code: string,
  session: BrowserCodeSession
): Promise<SubscriptionCredentials> {
  const { clientId, clientSecret } = antigravityClient();
  return exchangeGoogleToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: ANTIGRAVITY_OAUTH.redirectUri,
    code_verifier: session.pkce.verifier,
  });
}

export async function refreshAntigravityToken(creds: SubscriptionCredentials): Promise<SubscriptionCredentials> {
  if (!creds.refreshToken) {
    throw new Error('Antigravity session expired and no refresh token was stored. Sign in again in Settings.');
  }
  const { clientId, clientSecret } = antigravityClient();
  const refreshed = await exchangeGoogleToken({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return {
    ...creds,
    accessToken: refreshed.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: refreshed.expiresAt ?? creds.expiresAt,
  };
}

/** Best-effort account email for the account label; undefined when offline. */
export async function fetchAntigravityEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(ANTIGRAVITY_OAUTH.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as any;
    return typeof json?.email === 'string' ? json.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses pasted Antigravity credentials: a JSON blob with access/refresh tokens (any casing,
 * `expires_in` or `expires_at`), a raw `ya29.` access token, or a raw Google refresh token.
 */
export function parseAntigravityImport(raw: string): SubscriptionCredentials {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Paste Antigravity credentials JSON or a token.');
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    const src = json.credentials ?? json;
    const accessToken = String(src.access_token ?? src.accessToken ?? '');
    const refreshToken = src.refresh_token ?? src.refreshToken;
    const expiresAtRaw = src.expires_at ?? src.expiresAt;
    let expiresAt: number | undefined;
    if (typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw)) {
      // Google stores OAuth expiry as epoch seconds; treat small numbers as a relative expiry.
      expiresAt = expiresAtRaw > 1e12 ? expiresAtRaw : expiresAtRaw > 1e9 ? expiresAtRaw * 1000 : undefined;
    } else if (typeof src.expires_in === 'number' && Number.isFinite(src.expires_in) && src.expires_in > 0) {
      expiresAt = Date.now() + src.expires_in * 1000;
    }
    if (!accessToken && !refreshToken) throw new Error('No access_token or refresh_token found in JSON.');
    const projectId = src.projectId ?? src.project_id ?? src.cloudaicompanionProject;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken: String(refreshToken) } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(typeof projectId === 'string' && projectId ? { accountId: projectId } : {}),
    };
  }
  if (trimmed.startsWith('ya29.')) return { accessToken: trimmed };
  // Anything else is treated as a refresh token (`1//…` for modern Google clients).
  return { accessToken: '', refreshToken: trimmed, expiresAt: 0 };
}

export async function refreshSubscriptionCredentials(
  type: SubscriptionType,
  creds: SubscriptionCredentials
): Promise<SubscriptionCredentials> {
  switch (type) {
    case 'codex':
      return refreshCodexToken(creds);
    case 'claude':
      return refreshClaudeToken(creds);
    case 'antigravity':
      return refreshAntigravityToken(creds);
  }
}
