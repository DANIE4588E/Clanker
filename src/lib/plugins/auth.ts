import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { fetch } from '@/lib/net';
import { usePlugins, type PluginAccount } from '@/store/plugins';
import { runExclusiveRefresh, subscriptionAuth, type SubscriptionCredentials } from '../subscriptions/credentials';
import { generatePkce, type PkcePair } from '../subscriptions/pkce';
import { pluginGranted, PLUGINS, type PluginDef } from './catalog';
import { PROVIDERS, type DeviceConfig, type OAuthConfig, type ProviderId } from './providers';

/**
 * Signing in to plugin providers and making authorized requests for their tools. Tokens are kept
 * in the keychain, one slot per provider; the plugins store keeps the account's name and scopes.
 */

/** Keychain slot of a provider's tokens. */
export const slot = (provider: ProviderId) => `plugin_${provider}`;

const splitScopes = (s: unknown) => (typeof s === 'string' ? s.split(/[\s,]+/).filter(Boolean) : []);

/** The OAuth client to sign in with: the person's own when they entered one, else the app's. */
export function providerClient(provider: ProviderId): { id: string; secret?: string } | null {
  const own = usePlugins.getState().clients[provider];
  if (own?.id.trim()) return { id: own.id.trim(), secret: own.secret?.trim() };
  const built = PROVIDERS[provider].builtInClient;
  return built?.id ? built : null;
}

/** URL schemes this build opens (app.config.js adds Google's reversed client ID one). */
function registeredSchemes(): string[] {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme : scheme ? [scheme] : []).map((s) => s.toLowerCase());
}

/** The app's own URL scheme (clanker). */
export const appScheme = () => registeredSchemes()[0] ?? 'clanker';

/** Google's reversed client ID scheme: com.googleusercontent.apps.<id>. */
export const googleScheme = (clientId: string) =>
  `com.googleusercontent.apps.${clientId.trim().replace(/\.apps\.googleusercontent\.com$/, '')}`.toLowerCase();

/** Where the provider's sign-in returns to the app, for a client ID. */
export function redirectUriFor(provider: ProviderId, clientId: string) {
  const auth = PROVIDERS[provider].auth as OAuthConfig;
  return auth.redirect === 'google' ? `${googleScheme(clientId)}:/oauth2redirect` : `${appScheme()}://oauth/${provider}`;
}

/** Whether this build can receive the provider's redirect for a client ID (Google's scheme is per client). */
export function redirectRegistered(provider: ProviderId, clientId: string) {
  const auth = PROVIDERS[provider].auth;
  if (auth.kind !== 'oauth' || auth.redirect !== 'google') return true;
  return !!clientId.trim() && registeredSchemes().includes(googleScheme(clientId));
}

/** Whether connecting needs an OAuth client that isn't set up (or built in) yet. Token sign-in needs none. */
export function needsClientSetup(provider: ProviderId) {
  if (PROVIDERS[provider].auth.kind !== 'oauth') return false;
  const client = providerClient(provider);
  return !client || !redirectRegistered(provider, client.id);
}

/** GitHub signs in by device code when an OAuth client is set up, and by pasted token otherwise. */
export function signInKind(provider: ProviderId): 'oauth' | 'mcp' | 'device' | 'token' | 'none' {
  const { auth } = PROVIDERS[provider];
  if (auth.kind === 'device') return providerClient(provider) ? 'device' : 'token';
  return auth.kind;
}

/** Whether the account already allows the plugin, so adding it needs no sign-in. */
export function canInstallSilently(plugin: PluginDef) {
  if (plugin.provider === 'none') return true;
  const account = usePlugins.getState().accounts[plugin.provider];
  return !!account && !account.needsReconnect && pluginGranted(plugin);
}

async function saveAccount(provider: ProviderId, creds: SubscriptionCredentials, scopes: string[]) {
  const who = await whoami(provider, creds.accessToken).catch(() => ({}) as { name?: string; email?: string });
  await subscriptionAuth.set(slot(provider), creds);
  const account: PluginAccount = { ...who, scopes, connectedAt: Date.now() };
  usePlugins.getState().setAccount(provider, account);
  return account;
}

async function whoami(provider: ProviderId, token: string) {
  const def = PROVIDERS[provider];
  if (!def.whoami) return {};
  const res = await fetch(def.whoami.url, {
    method: def.whoami.method ?? 'GET',
    headers: { Accept: 'application/json', ...def.headers, ...def.whoami.headers, ...authHeaders(provider, token) },
    ...(def.whoami.body ? { body: def.whoami.body } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`${def.title} didn’t accept the token. Check it was copied whole.`);
  if (!res.ok) throw new Error(`${def.title} returned ${res.status} when checking the account.`);
  return def.whoami.pick(await res.json());
}

function authHeaders(provider: ProviderId, token: string): Record<string, string> {
  return PROVIDERS[provider].authHeader?.(token) ?? { Authorization: `Bearer ${token}` };
}

export const formBody = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join('&');

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(url: string, params: Record<string, string | undefined>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody(params),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || `Sign-in failed (${res.status}).`) as Error & { code?: string };
    error.code = data.error;
    throw error;
  }
  return data;
}

const credsFrom = (data: TokenResponse, previous?: SubscriptionCredentials): SubscriptionCredentials => ({
  accessToken: data.access_token!,
  ...((data.refresh_token ?? previous?.refreshToken) ? { refreshToken: data.refresh_token ?? previous?.refreshToken } : {}),
  ...(data.expires_in ? { expiresAt: Date.now() + data.expires_in * 1000 } : {}),
});

// ---- OAuth in the system browser -------------------------------------------------------------

export type OAuthSession = { provider: ProviderId; pkce: PkcePair; authorizeUrl: string; redirectUri: string; scopes: string[] };

/**
 * A sign-in that asks for the plugin's scopes plus those of the provider's other installed
 * plugins, so the new token covers them all.
 */
export function buildOAuthSession(plugin: PluginDef): OAuthSession {
  const provider = plugin.provider;
  const auth = PROVIDERS[provider].auth as OAuthConfig;
  const client = providerClient(provider);
  if (!client) throw new Error(`No ${PROVIDERS[provider].title} sign-in client is set up.`);
  const redirectUri = redirectUriFor(provider, client.id);
  const installed = usePlugins.getState().installed;
  const scopes = [
    ...new Set([
      ...auth.baseScopes,
      ...PLUGINS.filter((p) => p.provider === provider && (installed[p.id] || p.id === plugin.id)).flatMap((p) => p.scopes),
    ]),
  ];
  const pkce = generatePkce();
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    ...auth.params,
  });
  return { provider, pkce, authorizeUrl: `${auth.authorizeUrl}?${params}`, redirectUri, scopes };
}

/** The authorization code from the redirect. Throws on errors and state mismatch. */
export function parseOAuthCallback(url: string, session: OAuthSession): string {
  return readRedirect(url, session.pkce.state);
}

/** The authorization code from a sign-in redirect, checked against the state sent. */
export function readRedirect(url: string, expectedState: string): string {
  // Custom-scheme URLs parse unreliably across engines; only the query matters.
  const query = new URLSearchParams(url.split('#')[0].split('?')[1] ?? '');
  const err = query.get('error');
  if (err) {
    if (err === 'access_denied') throw new Error('Sign-in was cancelled.');
    throw new Error(`Sign-in failed: ${query.get('error_description') || err}`);
  }
  const code = query.get('code');
  if (!code) throw new Error('The sign-in sent no authorization code.');
  const state = query.get('state');
  if (state && state !== expectedState) throw new Error('Sign-in state mismatch. Try again.');
  return code;
}

export async function completeOAuth(session: OAuthSession, code: string) {
  const auth = PROVIDERS[session.provider].auth as OAuthConfig;
  const client = providerClient(session.provider)!;
  const data = await tokenRequest(auth.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: session.redirectUri,
    code_verifier: session.pkce.verifier,
  });
  if (!data.refresh_token && data.expires_in) {
    throw new Error(`${PROVIDERS[session.provider].title} sent no refresh token, so the connection would stop working within the hour. Remove Clanker’s access from your account and connect again.`);
  }
  const scopes = data.scope ? splitScopes(data.scope) : session.scopes;
  return saveAccount(session.provider, credsFrom(data), scopes);
}

/**
 * Signs in to the plugin's provider in the system browser (Chrome Custom Tabs on Android,
 * ASWebAuthenticationSession on iOS), which redirects back into the app. Resolves with the account,
 * or null when the person closed the browser.
 */
export async function signInWithBrowser(plugin: PluginDef) {
  const session = buildOAuthSession(plugin);
  const result = await WebBrowser.openAuthSessionAsync(session.authorizeUrl, session.redirectUri, { showInRecents: false });
  if (result.type !== 'success') return null;
  return completeOAuth(session, parseOAuthCallback(result.url, session));
}

/** Opens a web page in the system browser's in-app tab, for token pages, docs and policies. */
export const openInBrowser = (url: string) => WebBrowser.openBrowserAsync(url, { showInRecents: false }).catch(() => {});

// ---- Device code (GitHub) ---------------------------------------------------------------------

export type DeviceSession = { provider: ProviderId; deviceCode: string; userCode: string; verificationUri: string; interval: number };

export async function startDeviceAuth(provider: ProviderId): Promise<DeviceSession> {
  const auth = PROVIDERS[provider].auth as DeviceConfig;
  const client = providerClient(provider);
  if (!client) throw new Error('No sign-in client is set up.');
  const res = await fetch(auth.deviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody({ client_id: client.id, scope: auth.scopes.join(' ') }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !data.device_code) throw new Error(data.error_description || data.error || `Couldn’t start sign-in (${res.status}).`);
  return {
    provider,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Math.max(5, Number(data.interval) || 5),
  };
}

/**
 * Asks once whether the person has entered the code yet. The caller polls: on a timer, and right
 * away when the app comes back from the browser (timers can pause while it's in the background).
 * Resolves with the account once authorized, or how many seconds to wait before asking again.
 */
export async function checkDeviceAuth(session: DeviceSession, signal?: AbortSignal): Promise<{ account: PluginAccount } | { wait: number }> {
  const auth = PROVIDERS[session.provider].auth as DeviceConfig;
  const client = providerClient(session.provider)!;
  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody({ client_id: client.id, device_code: session.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { interval?: number };
  if (data.access_token) {
    return { account: await saveAccount(session.provider, credsFrom(data), data.scope ? splitScopes(data.scope) : auth.scopes) };
  }
  if (data.error === 'authorization_pending') return { wait: session.interval };
  if (data.error === 'slow_down') {
    // GitHub asks for a longer interval from now on.
    session.interval = Number(data.interval) || session.interval + 5;
    return { wait: session.interval };
  }
  if (data.error === 'expired_token') throw new Error('The code expired. Try again.');
  throw new Error(data.error === 'access_denied' ? 'Sign-in was cancelled.' : data.error_description || data.error || 'Sign-in failed.');
}

// ---- Pasted tokens ----------------------------------------------------------------------------

/** Checks the token with the service and saves the account. */
export async function connectWithToken(provider: ProviderId, token: string) {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Paste the token first.');
  return saveAccount(provider, { accessToken: trimmed }, []);
}

// ---- Disconnecting ----------------------------------------------------------------------------

/** Revokes the provider's tokens where it can (best effort), forgets them, and removes its plugins. */
export async function disconnectProvider(provider: ProviderId) {
  const creds = await subscriptionAuth.get(slot(provider)).catch(() => null);
  const auth = PROVIDERS[provider].auth;
  if (creds && auth.kind === 'oauth' && auth.revokeUrl) {
    const token = creds.refreshToken || creds.accessToken;
    const google = provider === 'google';
    await fetch(google ? `${auth.revokeUrl}?token=${encodeURIComponent(token)}` : auth.revokeUrl, {
      method: 'POST',
      headers: google ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { Authorization: `Bearer ${creds.accessToken}` },
    }).catch(() => {});
  }
  // MCP servers revoke through their authorization server's endpoint (RFC 7009), when it has one.
  const mcp = usePlugins.getState().mcp[provider]?.oauth;
  if (creds && mcp?.revocationEndpoint) {
    await fetch(mcp.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ token: creds.refreshToken || creds.accessToken, client_id: mcp.clientId, client_secret: mcp.clientSecret }),
    }).catch(() => {});
  }
  await subscriptionAuth.remove(slot(provider));
  const state = usePlugins.getState();
  state.setMcp(provider, null);
  state.uninstall(PLUGINS.filter((p) => p.provider === provider).map((p) => p.id));
  state.setAccount(provider, null);
}

// ---- Requests -------------------------------------------------------------------------------

const reconnect = (provider: ProviderId) =>
  `${PROVIDERS[provider].title} access has expired or was removed. Ask the user to reconnect it under Plugins in the sidebar.`;

async function refreshed(provider: ProviderId, creds: SubscriptionCredentials) {
  return runExclusiveRefresh(slot(provider), async () => {
    const auth = PROVIDERS[provider].auth;
    if (auth.kind !== 'oauth' || !creds.refreshToken) {
      usePlugins.getState().patchAccount(provider, { needsReconnect: true });
      throw new Error(reconnect(provider));
    }
    const client = providerClient(provider);
    if (!client) throw new Error(`No ${PROVIDERS[provider].title} sign-in client is set up.`);
    let data: TokenResponse;
    try {
      data = await tokenRequest(auth.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: client.id,
        client_secret: client.secret,
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'invalid_grant') {
        usePlugins.getState().patchAccount(provider, { needsReconnect: true });
        throw new Error(reconnect(provider));
      }
      throw e;
    }
    const next = credsFrom(data, creds);
    await subscriptionAuth.set(slot(provider), next);
    if (data.scope) usePlugins.getState().patchAccount(provider, { scopes: splitScopes(data.scope) });
    return next;
  });
}

/** A current access token, refreshed when it is about to expire (or `force`d after a 401). */
async function accessToken(provider: ProviderId, force = false) {
  const creds = await subscriptionAuth.get(slot(provider));
  if (!creds || !usePlugins.getState().accounts[provider]) {
    throw new Error(`${PROVIDERS[provider].title} isn’t connected. Ask the user to connect it under Plugins in the sidebar.`);
  }
  const fresh = !creds.expiresAt || creds.expiresAt - 60_000 > Date.now();
  if (!force && creds.accessToken && fresh) return creds.accessToken;
  return (await refreshed(provider, creds)).accessToken;
}

export class PluginApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response body as text, for tools that need the details. */
    readonly body = ''
  ) {
    super(message);
  }
}

/** The message in an API's JSON error body, whichever shape it takes. */
function errorMessage(body: string): { message: string; reason: string } {
  try {
    const j = JSON.parse(body);
    const e = j.error;
    const message =
      (typeof e === 'object' ? e?.message : undefined) ??
      j.error_description ??
      j.error_summary ??
      j.message ??
      j.errors?.[0]?.message ??
      j.err ??
      (typeof e === 'string' ? e : undefined) ??
      body.slice(0, 300);
    const reason = (typeof e === 'object' ? (e?.errors?.[0]?.reason ?? e?.status ?? e?.code) : '') ?? '';
    return { message: String(message), reason: String(reason) };
  } catch {
    return { message: body.slice(0, 300), reason: '' };
  }
}

async function apiError(provider: ProviderId, res: { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }) {
  const body = await res.text().catch(() => '');
  const { message, reason } = errorMessage(body);
  const title = PROVIDERS[provider].title;
  const both = `${reason} ${message}`;
  if (res.status === 401) {
    usePlugins.getState().patchAccount(provider, { needsReconnect: true });
    return new PluginApiError(reconnect(provider), 401, body);
  }
  if (res.status === 403 && /insufficient|scope|permission/i.test(both) && !/premium/i.test(both)) {
    return new PluginApiError(
      `${title} refused: ${message || 'not allowed'}. If the account is missing access, ask the user to reconnect under Plugins and allow everything asked for.`,
      403,
      body
    );
  }
  if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(both)) {
    return new PluginApiError(`${message} The API must be enabled for the sign-in client’s project.`, 403, body);
  }
  if (res.status === 404) {
    const account = usePlugins.getState().accounts[provider];
    const who = account?.email ?? account?.name;
    return new PluginApiError(`Not found (${message || 'no such item'}). Check the ID or link${who ? `, or whether ${who} can see it` : ''}.`, 404, body);
  }
  if (res.status === 429) {
    const wait = res.headers.get('retry-after');
    return new PluginApiError(`${title} is rate-limiting requests${wait ? `; try again in ${wait} seconds` : ''}.`, 429, body);
  }
  return new PluginApiError(`${title} API error ${res.status}${message ? `: ${message}` : ''}`, res.status, body);
}

export type PluginRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
  signal?: AbortSignal;
};

/**
 * An authorized request to a provider's API, with its standard headers. OAuth tokens refresh when
 * they are about to expire, and once more after a 401. Throws a PluginApiError on error statuses.
 * The provider "none" sends no credentials.
 */
export async function pluginFetch(provider: ProviderId, url: string, init: PluginRequest = {}) {
  const def = PROVIDERS[provider];
  const send = (token?: string) =>
    fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...def.headers, ...init.headers, ...(token ? authHeaders(provider, token) : {}) },
    });
  if (provider === 'none') {
    const res = await send();
    if (!res.ok) throw await apiError(provider, res);
    return res;
  }
  let res = await send(await accessToken(provider));
  if (res.status === 401 && def.auth.kind === 'oauth') res = await send(await accessToken(provider, true));
  if (!res.ok) throw await apiError(provider, res);
  return res;
}

/** pluginFetch for JSON APIs: sends `json` as the body and parses the response (empty → {}). */
export async function pluginJson<T = any>(
  provider: ProviderId,
  url: string,
  { json, ...init }: Omit<PluginRequest, 'body'> & { json?: unknown } = {}
): Promise<T> {
  const res = await pluginFetch(provider, url, {
    ...init,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json', ...init.headers } } : {}),
  });
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const googleFetch = (url: string, init?: PluginRequest) => pluginFetch('google', url, init);
export const googleJson = <T = any>(url: string, init?: Omit<PluginRequest, 'body'> & { json?: unknown }) => pluginJson<T>('google', url, init);
