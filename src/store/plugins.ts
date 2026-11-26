import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PluginId } from '@/lib/plugins/catalog';
import type { ProviderId } from '@/lib/plugins/providers';
import { jsonFileStorage } from '@/lib/storage';

/** A connected account. Its tokens live in the keychain (lib/plugins/auth). */
export type PluginAccount = {
  name?: string;
  email?: string;
  /** Scopes the user granted, which can be fewer than were asked for. */
  scopes: string[];
  connectedAt: number;
  /** Set when the provider refused the saved sign-in (access removed or expired): connect again. */
  needsReconnect?: boolean;
};

export type InstalledPlugin = {
  installedAt: number;
  /** Whether agents also get the tools that change things, or only search and read. */
  write: boolean;
};

export type PluginClient = { id: string; secret?: string };

/** A tool an MCP server offers, as the plugin lists it and the model sees it. */
export type McpToolInfo = {
  /** The server's name for it. */
  name: string;
  /** The name the model calls it by: <prefix>_<name>, safe for every provider. */
  key: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Marked read-only by the server; everything else counts as making changes. */
  readOnly: boolean;
};

/** How to reach and sign in to a hosted MCP server, and the tools it offered last. */
export type McpConnection = {
  url: string;
  /** Unset for servers that need no account. */
  oauth?: {
    clientId: string;
    clientSecret?: string;
    /** How the client authenticates at the token endpoint, as registered. */
    authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
    redirectUri: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    /** The protected resource (RFC 8707), sent with authorization and token requests. */
    resource: string;
    scope?: string;
  };
  tools: McpToolInfo[];
  toolsAt: number;
  serverName?: string;
};

interface PluginsState {
  accounts: Partial<Record<ProviderId, PluginAccount>>;
  installed: Partial<Record<PluginId, InstalledPlugin>>;
  /** People's own OAuth clients, in place of the ones built into the app. */
  clients: Partial<Record<ProviderId, PluginClient>>;
  /** Hosted MCP servers connected to, by provider. */
  mcp: Partial<Record<ProviderId, McpConnection>>;
  /** The plugin being connected right now, for its spinner. Not saved. */
  connecting: PluginId | null;
  setAccount: (provider: ProviderId, account: PluginAccount | null) => void;
  patchAccount: (provider: ProviderId, patch: Partial<PluginAccount>) => void;
  install: (id: PluginId) => void;
  uninstall: (ids: PluginId[]) => void;
  setWrite: (id: PluginId, write: boolean) => void;
  setClient: (provider: ProviderId, client: PluginClient | null) => void;
  setConnecting: (id: PluginId | null) => void;
  setMcp: (provider: ProviderId, connection: McpConnection | null) => void;
  patchMcp: (provider: ProviderId, patch: Partial<McpConnection>) => void;
}

export const usePlugins = create<PluginsState>()(
  persist(
    (set, get) => ({
      accounts: {},
      installed: {},
      clients: {},
      mcp: {},
      connecting: null,
      setAccount: (provider, account) => {
        const { [provider]: _, ...rest } = get().accounts;
        set({ accounts: account ? { ...rest, [provider]: account } : rest });
      },
      patchAccount: (provider, patch) => {
        const account = get().accounts[provider];
        if (account) set({ accounts: { ...get().accounts, [provider]: { ...account, ...patch } } });
      },
      install: (id) => {
        if (!get().installed[id]) set({ installed: { ...get().installed, [id]: { installedAt: Date.now(), write: true } } });
      },
      uninstall: (ids) => {
        const installed = { ...get().installed };
        for (const id of ids) delete installed[id];
        set({ installed });
      },
      setWrite: (id, write) => {
        const plugin = get().installed[id];
        if (plugin) set({ installed: { ...get().installed, [id]: { ...plugin, write } } });
      },
      setClient: (provider, client) => {
        const { [provider]: _, ...rest } = get().clients;
        set({ clients: client?.id.trim() ? { ...rest, [provider]: client } : rest });
      },
      setConnecting: (connecting) => set({ connecting }),
      setMcp: (provider, connection) => {
        const { [provider]: _, ...rest } = get().mcp;
        set({ mcp: connection ? { ...rest, [provider]: connection } : rest });
      },
      patchMcp: (provider, patch) => {
        const connection = get().mcp[provider];
        if (connection) set({ mcp: { ...get().mcp, [provider]: { ...connection, ...patch } } });
      },
    }),
    {
      name: 'plugins',
      version: 2,
      storage: jsonFileStorage,
      partialize: (s) => ({ accounts: s.accounts, installed: s.installed, clients: s.clients, mcp: s.mcp }),
      migrate: (persisted, version) => {
        // Version 1 connected Notion, Linear, Todoist and ClickUp with pasted tokens; they now use
        // their MCP servers, so those connections go and the plugins are added again.
        if (version === 1) {
          const state = persisted as PluginsState;
          const moved = ['notion', 'linear', 'todoist', 'clickup'] as const;
          const accounts = { ...state.accounts };
          const installed = { ...state.installed };
          for (const id of moved) {
            delete accounts[id];
            delete installed[id];
          }
          return { ...state, accounts, installed, mcp: {} } as PluginsState;
        }
        if (version >= 2) return persisted as PluginsState;
        // Version 0 had one Google account with per-plugin switches for Drive, Docs and Sheets.
        const old = persisted as {
          google?: PluginAccount | null;
          prefs?: Record<string, { enabled?: boolean; write?: boolean }>;
          googleClientId?: string;
          googleClientSecret?: string;
        };
        const installed: PluginsState['installed'] = {};
        if (old.google) {
          for (const id of ['google-drive', 'google-docs', 'google-sheets'] as const) {
            const pref = old.prefs?.[id];
            if (pref?.enabled !== false) installed[id] = { installedAt: old.google.connectedAt, write: pref?.write ?? true };
          }
        }
        return {
          accounts: old.google ? { google: old.google } : {},
          installed,
          clients: old.googleClientId ? { google: { id: old.googleClientId, secret: old.googleClientSecret } } : {},
          mcp: {},
        } as unknown as PluginsState;
      },
    }
  )
);
