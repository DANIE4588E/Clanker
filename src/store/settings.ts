import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { defaultEffort, isSubscriptionType, type Endpoint } from '@/lib/providers';
import { apiKeys, jsonFileStorage } from '@/lib/storage';
import { subscriptionAuth } from '@/lib/subscriptions/credentials';
import { useSubscriptionUsage } from './subscriptionUsage';

export type ThemePreference = 'system' | 'light' | 'dark';

export type ModelRef = { endpointId: string; model: string };

/** When history is compressed on its own, as percentages of the model's context budget. */
export type CompressionConfig = { trigger: number; target: number };

export const COMPRESSION_DEFAULTS: CompressionConfig = { trigger: 60, target: 30 };

/** What sending does while a reply is running: wait for it to finish, or steer it mid-task. */
export type FollowUpMode = 'queue' | 'steer';

/** When prompt suggestions are written afresh: once a day, each time the app starts, or for every new chat. */
export type SuggestionRefresh = 'daily' | 'launch' | 'chat';

export type SearchProvider = 'firecrawl' | 'duckduckgo' | 'exa' | 'brave' | 'tavily' | 'searxng';

/** Where web_search sends queries. Keys live in SecureStore under `search-<provider>`. */
export type SearchConfig = { provider: SearchProvider; /** SearXNG instance URL. */ url?: string };

// Hosted APIs whose current models all have windows of 128K tokens or more, though not every one reports it.
const LARGE_CONTEXT_HOSTS =
  /api\.openai\.com|chatgpt\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.deepseek\.com|api\.mistral\.ai|api\.x\.ai/i;

const DEFAULT_BUDGET = 32_000;

const effortKey = (ref: ModelRef) => `${ref.endpointId}/${ref.model}`;

interface SettingsState {
  endpoints: Endpoint[];
  active: ModelRef | null;
  theme: ThemePreference;
  /** Chosen effort level per model, keyed by `endpointId/model`. */
  efforts: Record<string, string>;
  /** Whether models get the file, script and shell tools. */
  tools: boolean;
  /** Tools the user turned off one by one, by name. */
  disabledTools: string[];
  /** Rounds of tool calls a reply may make before it is stopped, or null for no limit. */
  maxSteps: number | null;
  /** Whether the composer shows a context usage meter while typing. */
  contextUsage: boolean;
  /** Whether replies show the model's decode speed over the chat's last 10 responses. */
  decodeSpeed: boolean;
  /** Whether replies show how much of the prompt the server had cached over the chat's last 10 responses. */
  cacheHits: boolean;
  /** Whether models with tools also get web search and fetch. */
  web: boolean;
  search: SearchConfig;
  compression: CompressionConfig;
  /** Whether chats use and save memories about the user. */
  memory: boolean;
  /** Whether a short request after each reply saves anything worth remembering from it. */
  memoryAuto: boolean;
  /** Whether the chat lists show archived chats. */
  showArchived: boolean;
  /** Whether a short request after the first reply names the chat. */
  titleGeneration: boolean;
  /** Whether new chats show automatically generated prompt suggestions. */
  suggestions: boolean;
  /** The model that names chats, or null for the chat's own model. */
  titleModel: ModelRef | null;
  /** The model that writes prompt suggestions, or null for the selected model. */
  suggestionModel: ModelRef | null;
  suggestionRefresh: SuggestionRefresh;
  /** Whether providers and models show as brand marks with tidied names instead of raw ids. */
  friendlyModelNames: boolean;
  followUp: FollowUpMode;
  upsertEndpoint: (endpoint: Endpoint) => void;
  removeEndpoint: (id: string) => void;
  setActive: (ref: ModelRef) => void;
  setTheme: (theme: ThemePreference) => void;
  setEffort: (ref: ModelRef, level: string) => void;
  setTools: (on: boolean) => void;
  setToolsEnabled: (names: string[], on: boolean) => void;
  setMaxSteps: (steps: number | null) => void;
  setContextUsage: (on: boolean) => void;
  setDecodeSpeed: (on: boolean) => void;
  setCacheHits: (on: boolean) => void;
  setWeb: (on: boolean) => void;
  setSearch: (search: SearchConfig) => void;
  setCompression: (compression: CompressionConfig) => void;
  setMemory: (on: boolean) => void;
  setMemoryAuto: (on: boolean) => void;
  setShowArchived: (on: boolean) => void;
  setTitleGeneration: (on: boolean) => void;
  setSuggestions: (on: boolean) => void;
  setTitleModel: (ref: ModelRef | null) => void;
  setSuggestionModel: (ref: ModelRef | null) => void;
  setSuggestionRefresh: (when: SuggestionRefresh) => void;
  setFriendlyModelNames: (on: boolean) => void;
  setFollowUp: (mode: FollowUpMode) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      endpoints: [],
      active: null,
      theme: 'system',
      efforts: {},
      tools: true,
      disabledTools: [],
      maxSteps: null,
      contextUsage: false,
      decodeSpeed: false,
      cacheHits: false,
      web: true,
      search: { provider: 'firecrawl' },
      compression: COMPRESSION_DEFAULTS,
      memory: true,
      memoryAuto: true,
      showArchived: false,
      titleGeneration: true,
      suggestions: true,
      titleModel: null,
      suggestionModel: null,
      suggestionRefresh: 'launch',
      friendlyModelNames: true,
      followUp: 'queue',
      upsertEndpoint: (endpoint) => {
        const exists = get().endpoints.some((e) => e.id === endpoint.id);
        const endpoints = exists
          ? get().endpoints.map((e) => (e.id === endpoint.id ? endpoint : e))
          : [...get().endpoints, endpoint];
        let active = get().active;
        // Pick a model for the user if nothing usable is selected yet.
        const activeValid = active && endpoints.some((e) => e.id === active!.endpointId && e.models.includes(active!.model));
        if (!activeValid && endpoint.models.length) active = { endpointId: endpoint.id, model: endpoint.models[0] };
        set({ endpoints, active });
      },
      removeEndpoint: (id) => {
        const target = get().endpoints.find((e) => e.id === id);
        apiKeys.remove(id);
        if (target && isSubscriptionType(target.type)) {
          const ids = target.subscriptionAccounts?.map((a) => a.id) ?? [];
          void subscriptionAuth.removeAll(id, ids);
          useSubscriptionUsage.getState().removeEndpointUsage(id);
        }
        const endpoints = get().endpoints.filter((e) => e.id !== id);
        let active = get().active;
        if (active?.endpointId === id) {
          const next = endpoints.find((e) => e.models.length);
          active = next ? { endpointId: next.id, model: next.models[0] } : null;
        }
        const efforts = Object.fromEntries(Object.entries(get().efforts).filter(([k]) => !k.startsWith(`${id}/`)));
        // Side tasks that used the removed endpoint go back to the chat's model.
        const titleModel = get().titleModel?.endpointId === id ? null : get().titleModel;
        const suggestionModel = get().suggestionModel?.endpointId === id ? null : get().suggestionModel;
        set({ endpoints, active, efforts, titleModel, suggestionModel });
      },
      setActive: (active) => set({ active }),
      setTheme: (theme) => set({ theme }),
      setEffort: (ref, level) => set({ efforts: { ...get().efforts, [effortKey(ref)]: level } }),
      setTools: (tools) => set({ tools }),
      setToolsEnabled: (names, on) => {
        const rest = get().disabledTools.filter((n) => !names.includes(n));
        set({ disabledTools: on ? rest : [...rest, ...names] });
      },
      setMaxSteps: (maxSteps) => set({ maxSteps }),
      setContextUsage: (contextUsage) => set({ contextUsage }),
      setDecodeSpeed: (decodeSpeed) => set({ decodeSpeed }),
      setCacheHits: (cacheHits) => set({ cacheHits }),
      setWeb: (web) => set({ web }),
      setSearch: (search) => set({ search }),
      setCompression: (compression) => set({ compression }),
      setMemory: (memory) => set({ memory }),
      setMemoryAuto: (memoryAuto) => set({ memoryAuto }),
      setShowArchived: (showArchived) => set({ showArchived }),
      setTitleGeneration: (titleGeneration) => set({ titleGeneration }),
      setSuggestions: (suggestions) => set({ suggestions }),
      setTitleModel: (titleModel) => set({ titleModel }),
      setSuggestionModel: (suggestionModel) => set({ suggestionModel }),
      setSuggestionRefresh: (suggestionRefresh) => set({ suggestionRefresh }),
      setFriendlyModelNames: (friendlyModelNames) => set({ friendlyModelNames }),
      setFollowUp: (followUp) => set({ followUp }),
    }),
    {
      name: 'settings',
      storage: jsonFileStorage,
      version: 3,
      migrate: (persisted, version) => {
        const state = persisted as SettingsState & { contextBudget?: number };
        // v0 had one budget for every model whose window wasn't known; keep it on those models.
        const old = state.contextBudget;
        if (version < 1 && old && old !== DEFAULT_BUDGET) {
          state.endpoints = state.endpoints.map((e) => {
            if (LARGE_CONTEXT_HOSTS.test(e.baseUrl)) return e;
            const unknown = e.models.filter((m) => !e.contexts?.[m] && !e.budgets?.[m]);
            if (!unknown.length) return e;
            return { ...e, budgets: { ...e.budgets, ...Object.fromEntries(unknown.map((m) => [m, old])) } };
          });
        }
        delete state.contextBudget;
        // v1 defaulted to compressing at 90% down to 60%; settings left at that move to the new defaults.
        if (version < 2 && state.compression?.trigger === 90 && state.compression.target === 60) {
          state.compression = COMPRESSION_DEFAULTS;
        }
        // v2 could contain removed Gemini subscription endpoints; drop them and clean up their tokens.
        if (version < 3 && Array.isArray(state.endpoints)) {
          const removed = state.endpoints.filter((e) => (e.type as string) === 'gemini-sub');
          if (removed.length) {
            for (const ep of removed) {
              const ids = ep.subscriptionAccounts?.map((a) => a.id) ?? [];
              void subscriptionAuth.removeAll(ep.id, ids);
              useSubscriptionUsage.getState().removeEndpointUsage(ep.id);
            }
            const removedIds = new Set(removed.map((e) => e.id));
            state.endpoints = state.endpoints.filter((e) => !removedIds.has(e.id));
            if (state.active && removedIds.has(state.active.endpointId)) {
              const next = state.endpoints.find((e) => e.models.length);
              state.active = next ? { endpointId: next.id, model: next.models[0] } : null;
            }
          }
        }
        return state;
      },
    }
  )
);

/** The model's effort levels and the one to use, or null when it has no effort control. */
export function resolveEffort(state: Pick<SettingsState, 'endpoints' | 'efforts'>, ref: ModelRef | null) {
  if (!ref) return null;
  const levels = state.endpoints.find((e) => e.id === ref.endpointId)?.efforts?.[ref.model];
  if (!levels?.length) return null;
  const chosen = state.efforts[effortKey(ref)];
  return { levels, level: chosen && levels.includes(chosen) ? chosen : defaultEffort(levels) };
}

/**
 * Tokens of history to aim for: the budget the user set for the model; otherwise three quarters
 * of its reported window (the rest is for the system prompt, tool definitions and the reply);
 * 96K on large-context hosted APIs that don't report one; otherwise 32K, which suits most local servers.
 */
export function resolveBudget(endpoint: Pick<Endpoint, 'baseUrl' | 'contexts' | 'budgets'>, model: string) {
  const set = endpoint.budgets?.[model];
  if (set) return set;
  const window = endpoint.contexts?.[model];
  if (window) return Math.floor(window * 0.75);
  return LARGE_CONTEXT_HOSTS.test(endpoint.baseUrl) ? 96_000 : DEFAULT_BUDGET;
}

/**
 * The endpoint and model a side task (titles, suggestions) should use: its own choice while that
 * model still exists, otherwise null so the caller falls back to the chat's model.
 */
export function resolveTaskModel(endpoints: Endpoint[], ref: ModelRef | null) {
  if (!ref) return null;
  const endpoint = endpoints.find((e) => e.id === ref.endpointId);
  return endpoint?.models.includes(ref.model) ? { endpoint, model: ref.model } : null;
}

export function useEndpoint(id: string | undefined) {
  return useSettings((s) => s.endpoints.find((e) => e.id === id));
}
