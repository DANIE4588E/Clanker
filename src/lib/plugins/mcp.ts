import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { fetch } from '@/lib/net';
import { usePlugins, type McpConnection, type McpToolInfo, type PluginAccount } from '@/store/plugins';
import { runExclusiveRefresh, subscriptionAuth, type SubscriptionCredentials } from '../subscriptions/credentials';
import { generatePkce } from '../subscriptions/pkce';
import { appScheme, formBody, readRedirect, slot } from './auth';
import type { PluginDef } from './catalog';
import { PROVIDERS, type McpConfig, type ProviderId } from './providers';

/**
 * A client for hosted MCP servers over Streamable HTTP (MCP 2025-06-18), with the spec's
 * authorization: the server points to its authorization server (RFC 9728), the app registers
 * itself there (RFC 7591) with a redirect back into the app, and signs in with PKCE in the system
 * browser, naming the server as the resource (RFC 8707). Servers that need no account skip all that.
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'Clanker', version: Constants.expoConfig?.version ?? '1.0' };
const REQUEST_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 20_000;

export const mcpConfig = (provider: ProviderId) => {
  const auth = PROVIDERS[provider].auth;
  return auth.kind === 'mcp' ? auth : null;
};

const title = (provider: ProviderId) => PROVIDERS[provider].title;

/**
 * Runs `fn` with a signal that aborts after `ms` or when `signal` does, and clears the timer when
 * it's done. (React Native's AbortSignal has neither AbortSignal.timeout nor AbortSignal.any.)
 */
async function timed<T>(ms: number, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

async function getJson(url: string): Promise<Record<string, any> | null> {
  try {
    return await timed(DISCOVERY_TIMEOUT_MS, undefined, async (signal) => {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
      return res.ok ? ((await res.json()) as Record<string, any>) : null;
    });
  } catch {
    return null;
  }
}

async function firstJson(urls: string[]) {
  for (const url of urls) {
    const json = await getJson(url);
    if (json) return json;
  }
  return null;
}

/** "/mcp" stays "/mcp"; "/" becomes "" — for the path-suffixed well-known URLs. */
const pathOf = (url: URL) => url.pathname.replace(/\/+$/, '');

// ---- JSON-RPC over Streamable HTTP --------------------------------------------------------------

type JsonRpcMessage = { jsonrpc: '2.0'; id?: number | string; method?: string; result?: any; error?: { code: number; message: string; data?: unknown } };

/** Messages in a response body: plain JSON (one message or a batch) or a text/event-stream. */
export function parseMessages(contentType: string, body: string): JsonRpcMessage[] {
  if (contentType.includes('text/event-stream')) {
    const messages: JsonRpcMessage[] = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {}
    }
    return messages;
  }
  if (!body.trim()) return [];
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

type Session = { id?: string; protocolVersion: string; serverName?: string; instructions?: string };
const sessions = new Map<ProviderId, Promise<Session>>();
let nextId = 1;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function post(
  url: string,
  message: object,
  opts: { token?: string; session?: Session; signal?: AbortSignal }
): Promise<{ status: number; sessionId: string | null; messages: JsonRpcMessage[] }> {
  const { res, body } = await timed(REQUEST_TIMEOUT_MS, opts.signal, async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': opts.session?.protocolVersion ?? PROTOCOL_VERSION,
        ...(opts.session?.id ? { 'Mcp-Session-Id': opts.session.id } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(message),
      signal,
    });
    return { res, body: await res.text() };
  });
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body);
      detail = j.error?.message ?? j.error_description ?? j.message ?? (typeof j.error === 'string' ? j.error : detail);
    } catch {}
    throw new HttpError(detail || `HTTP ${res.status}`, res.status);
  }
  const messages = res.status === 202 ? [] : parseMessages(res.headers.get('content-type') ?? '', body);
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), messages };
}

async function initialize(provider: ProviderId, url: string, token: string | undefined, signal?: AbortSignal): Promise<Session> {
  const id = nextId++;
  const res = await post(
    url,
    { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } },
    { token, signal }
  );
  const reply = res.messages.find((m) => m.id === id);
  if (!reply) throw new Error(`${title(provider)} didn’t answer the MCP handshake.`);
  if (reply.error) throw new Error(`${title(provider)}: ${reply.error.message}`);
  const session: Session = {
    id: res.sessionId ?? undefined,
    protocolVersion: reply.result?.protocolVersion ?? PROTOCOL_VERSION,
    serverName: reply.result?.serverInfo?.title ?? reply.result?.serverInfo?.name,
    instructions: reply.result?.instructions,
  };
  await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, session, signal }).catch(() => {});
  return session;
}

/**
 * Calls an MCP method. Starts a session first when needed, refreshes the token once after a 401,
 * and starts over once when the server has forgotten the session (404).
 */
export async function mcpRequest<T = any>(provider: ProviderId, method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
  const connection = usePlugins.getState().mcp[provider];
  if (!connection) throw new Error(`${title(provider)} isn’t connected. Ask the user to add it under Plugins in the sidebar.`);
  let token = connection.oauth ? await mcpToken(provider) : undefined;

  for (let attempt = 0; ; attempt++) {
    let pending = sessions.get(provider);
    if (!pending) {
      const started = initialize(provider, connection.url, token, signal);
      pending = started;
      sessions.set(provider, started);
      started.catch(() => sessions.get(provider) === started && sessions.delete(provider));
    }
    try {
      const session = await pending;
      const id = nextId++;
      const res = await post(connection.url, { jsonrpc: '2.0', id, method, params }, { token, session, signal });
      const reply = res.messages.find((m) => m.id === id);
      if (!reply) throw new Error(`${title(provider)} sent no reply to ${method}.`);
      if (reply.error) throw new Error(`${title(provider)}: ${reply.error.message}`);
      return reply.result as T;
    } catch (e) {
      if (!(e instanceof HttpError) || attempt > 0) {
        if (e instanceof HttpError && e.status === 401) {
          usePlugins.getState().patchAccount(provider, { needsReconnect: true });
          throw new Error(`${title(provider)} access has expired or was removed. Ask the user to reconnect it under Plugins in the sidebar.`);
        }
        throw e instanceof HttpError ? new Error(`${title(provider)} returned ${e.status}: ${e.message}`) : e;
      }
      sessions.delete(provider);
      if (e.status === 401 && connection.oauth) token = await mcpToken(provider, true);
      else if (e.status !== 404 && e.status !== 400) throw new Error(`${title(provider)} returned ${e.status}: ${e.message}`);
    }
  }
}

// ---- Sign-in ------------------------------------------------------------------------------------

export type McpDiscovery =
  | { needsAuth: false }
  | {
      needsAuth: true;
      resource: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      registrationEndpoint?: string;
      revocationEndpoint?: string;
      scope?: string;
    };

/** Whether the server wants an account, and if so where its authorization server is. */
export async function discover(url: string): Promise<McpDiscovery> {
  let www = '';
  try {
    const res = await timed(DISCOVERY_TIMEOUT_MS, undefined, async (signal) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }),
        signal,
      });
      await r.text().catch(() => '');
      return r;
    });
    if (res.ok) return { needsAuth: false };
    if (res.status !== 401 && res.status !== 403) throw new Error(`The server answered ${res.status}.`);
    www = res.headers.get('www-authenticate') ?? '';
  } catch (e) {
    throw new Error(`Couldn’t reach the server: ${e instanceof Error ? e.message : e}`);
  }
  const u = new URL(url);
  const metadataUrl = www.match(/resource_metadata="([^"]+)"/)?.[1];
  const resource = await firstJson(
    [metadataUrl, `${u.origin}/.well-known/oauth-protected-resource${pathOf(u)}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(
      (x): x is string => !!x
    )
  );
  const issuer = new URL(resource?.authorization_servers?.[0] ?? u.origin);
  const as = await firstJson([
    `${issuer.origin}/.well-known/oauth-authorization-server${pathOf(issuer)}`,
    `${issuer.origin}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration${pathOf(issuer)}`,
    `${issuer.origin}${pathOf(issuer)}/.well-known/openid-configuration`,
  ]);
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error('The server’s sign-in settings couldn’t be found.');
  const scope = www.match(/scope="([^"]+)"/)?.[1] ?? (Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.join(' ') : undefined);
  return {
    needsAuth: true,
    resource: resource?.resource ?? url,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    revocationEndpoint: as.revocation_endpoint,
    ...(scope ? { scope } : {}),
  };
}

/** Registers the app with the authorization server, redirecting to clanker://oauth/<provider>. */
async function register(provider: ProviderId, d: Extract<McpDiscovery, { needsAuth: true }>, redirectUri: string) {
  if (!d.registrationEndpoint) {
    throw new Error(`${title(provider)} doesn’t let apps register themselves, so it can’t be connected here.`);
  }
  const endpoint = d.registrationEndpoint;
  const { res, json } = await timed(DISCOVERY_TIMEOUT_MS, undefined, async (signal) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Clanker',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(d.scope ? { scope: d.scope } : {}),
      }),
      signal,
    });
    return { res, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  });
  if (!res.ok || !json.client_id) {
    throw new Error(`${title(provider)} refused to register the app: ${json.error_description ?? json.error ?? res.status}`);
  }
  const method = json.token_endpoint_auth_method;
  return {
    clientId: String(json.client_id),
    ...(json.client_secret ? { clientSecret: String(json.client_secret) } : {}),
    authMethod: (method === 'client_secret_post' || method === 'client_secret_basic' ? method : json.client_secret ? 'client_secret_post' : 'none') as
      | 'none'
      | 'client_secret_post'
      | 'client_secret_basic',
  };
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function tokenRequest(oauth: NonNullable<McpConnection['oauth']>, params: Record<string, string | undefined>) {
  const basic = oauth.authMethod === 'client_secret_basic' && oauth.clientSecret;
  const res = await fetch(oauth.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(basic ? { Authorization: `Basic ${btoa(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret!)}`)}` } : {}),
    },
    body: formBody({
      ...params,
      client_id: oauth.clientId,
      client_secret: oauth.authMethod === 'client_secret_post' ? oauth.clientSecret : undefined,
      resource: oauth.resource,
    }),
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

/** A current access token for the server, refreshed when about to expire (or `force`d after a 401). */
async function mcpToken(provider: ProviderId, force = false): Promise<string> {
  const oauth = usePlugins.getState().mcp[provider]?.oauth;
  const creds = await subscriptionAuth.get(slot(provider));
  if (!oauth || !creds) throw new Error(`${title(provider)} isn’t connected. Ask the user to add it under Plugins in the sidebar.`);
  const fresh = !creds.expiresAt || creds.expiresAt - 60_000 > Date.now();
  if (!force && fresh) return creds.accessToken;
  const next = await runExclusiveRefresh(slot(provider), async () => {
    if (!creds.refreshToken) {
      usePlugins.getState().patchAccount(provider, { needsReconnect: true });
      throw new Error(`${title(provider)} access has expired. Ask the user to reconnect it under Plugins in the sidebar.`);
    }
    try {
      const refreshed = credsFrom(await tokenRequest(oauth, { grant_type: 'refresh_token', refresh_token: creds.refreshToken }), creds);
      await subscriptionAuth.set(slot(provider), refreshed);
      return refreshed;
    } catch (e) {
      if ((e as { code?: string }).code === 'invalid_grant' || (e as { code?: string }).code === 'invalid_client') {
        usePlugins.getState().patchAccount(provider, { needsReconnect: true });
        throw new Error(`${title(provider)} access has expired or was removed. Ask the user to reconnect it under Plugins in the sidebar.`);
      }
      throw e;
    }
  });
  return next.accessToken;
}

/** "search_issues" → "Search issues". */
const humanize = (name: string) => {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A tool name every model provider accepts: letters, digits, _ and -, at most 64 characters. */
export function toolKey(prefix: string, name: string, taken: Set<string>) {
  const base = `${prefix}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
  taken.add(key);
  return key;
}

type RawTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean };
};

/** The tools in a tools/list result, named for the model. */
export function toToolInfos(prefix: string, tools: RawTool[]): McpToolInfo[] {
  const taken = new Set<string>();
  return tools.map((t) => ({
    name: t.name,
    key: toolKey(prefix, t.name, taken),
    title: t.title ?? t.annotations?.title ?? humanize(t.name),
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    readOnly: t.annotations?.readOnlyHint === true,
  }));
}

/** Asks the server for its tools (every page) and keeps them for the model. */
export async function refreshMcpTools(provider: ProviderId, signal?: AbortSignal) {
  const config = mcpConfig(provider)!;
  const tools: RawTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await mcpRequest<{ tools?: RawTool[]; nextCursor?: string }>(provider, 'tools/list', cursor ? { cursor } : {}, signal);
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  const infos = toToolInfos(config.prefix, tools);
  const session = await sessions.get(provider)?.catch(() => undefined);
  usePlugins.getState().patchMcp(provider, { tools: infos, toolsAt: Date.now(), serverName: session?.serverName });
  return infos;
}

/** Refreshes the tool lists of connected servers that haven't been checked for `maxAgeMs`. */
export async function refreshStaleMcpTools(maxAgeMs = 6 * 60 * 60_000) {
  const { mcp, accounts } = usePlugins.getState();
  await Promise.all(
    (Object.keys(mcp) as ProviderId[])
      .filter((p) => Date.now() - (mcp[p]?.toolsAt ?? 0) > maxAgeMs && !accounts[p]?.needsReconnect)
      .map((p) => refreshMcpTools(p).catch(() => {}))
  );
}

/**
 * Connects the plugin's MCP server: straight away when it needs no account, otherwise by signing
 * in in the system browser. Resolves with the account, or null when the person closed the browser.
 */
export async function connectMcp(plugin: PluginDef): Promise<PluginAccount | null> {
  const provider = plugin.provider;
  const config = mcpConfig(provider) as McpConfig;
  sessions.delete(provider);
  const d = await discover(config.url);
  const state = usePlugins.getState();

  if (!d.needsAuth) {
    state.setMcp(provider, { url: config.url, tools: [], toolsAt: 0 });
  } else {
    const redirectUri = `${appScheme()}://oauth/${provider}`;
    // A client registered earlier for the same server and redirect is reused rather than piling up.
    const previous = state.mcp[provider]?.oauth;
    const client =
      previous && previous.redirectUri === redirectUri && previous.tokenEndpoint === d.tokenEndpoint
        ? { clientId: previous.clientId, clientSecret: previous.clientSecret, authMethod: previous.authMethod }
        : await register(provider, d, redirectUri);
    const oauth: NonNullable<McpConnection['oauth']> = {
      ...client,
      redirectUri,
      authorizationEndpoint: d.authorizationEndpoint,
      tokenEndpoint: d.tokenEndpoint,
      revocationEndpoint: d.revocationEndpoint,
      resource: d.resource,
      ...(d.scope ? { scope: d.scope } : {}),
    };
    const pkce = generatePkce();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: pkce.state,
      resource: oauth.resource,
      ...(oauth.scope ? { scope: oauth.scope } : {}),
    });
    const sep = oauth.authorizationEndpoint.includes('?') ? '&' : '?';
    const result = await WebBrowser.openAuthSessionAsync(`${oauth.authorizationEndpoint}${sep}${params}`, redirectUri, { showInRecents: false });
    if (result.type !== 'success') return null;
    const code = readRedirect(result.url, pkce.state);
    const tokens = await tokenRequest(oauth, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pkce.verifier });
    await subscriptionAuth.set(slot(provider), credsFrom(tokens));
    state.setMcp(provider, { url: config.url, oauth, tools: [], toolsAt: 0 });
  }

  // The account counts as connected once the server lists its tools.
  state.setAccount(provider, { scopes: [], connectedAt: Date.now() });
  try {
    await refreshMcpTools(provider);
  } catch (e) {
    state.setAccount(provider, null);
    throw e;
  }
  const serverName = usePlugins.getState().mcp[provider]?.serverName;
  const account: PluginAccount = { name: serverName && serverName !== config.url ? serverName : PROVIDERS[provider].title, scopes: [], connectedAt: Date.now() };
  state.setAccount(provider, account);
  return account;
}

/** Forgets the server's session, so the next request starts a new one (after a disconnect). */
export const dropMcpSession = (provider: ProviderId) => sessions.delete(provider);

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; name?: string; description?: string; mimeType?: string };

export type McpToolResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

export const callMcpTool = (provider: ProviderId, name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
  mcpRequest<McpToolResult>(provider, 'tools/call', { name, arguments: args }, signal);
