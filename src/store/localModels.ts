import type { DownloadPauseState } from 'expo-file-system';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { jsonFileStorage } from '@/lib/storage';

/** GGUF models downloaded to the phone and run on it with llama.cpp. */

export const LOCAL_ENDPOINT_ID = 'on-device';

/** Context new models load with, unless the model's own window is smaller. */
export const DEFAULT_CONTEXT = 8192;

/** Window to offer up to when a model doesn't say what it was trained for. */
const UNKNOWN_MAX_CONTEXT = 32768;

/** How the KV cache stores keys and values: full half-precision, or quantized to save memory. */
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0';

export const KV_CACHE_TYPES: { value: KvCacheType; label: string }[] = [
  { value: 'f16', label: 'F16' },
  { value: 'q8_0', label: 'Q8_0' },
  { value: 'q4_0', label: 'Q4_0' },
];

/** Bytes per cached element: q8_0 and q4_0 pack 32 values with a 2-byte scale. */
const KV_BYTES: Record<KvCacheType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

/** What the KV cache's size per token depends on, read from the GGUF header. */
export type KvShape = {
  /** Sum over layers of each layer's KV heads, as some models vary them by layer. */
  heads: number;
  keyLength: number;
  valueLength: number;
};

export type LocalModel = {
  /** The model id chats and the model picker use, e.g. `unsloth/Qwen3-4B-Q4_K_M`. */
  id: string;
  repo: string;
  quant: string;
  /** Folder under the models directory that holds the files. */
  dir: string;
  /** The file llama.cpp opens: the only one, or the first shard of a split model. */
  file: string;
  /** Vision projector file in the same folder, when downloaded. */
  mmproj?: string;
  size: number;
  /** Context window the model was trained for. */
  contextLength?: number;
  /** Tokens of context to load it with, set by the user; see `contextFor`. */
  context?: number;
  /** KV cache type to load it with; f16 when unset. */
  cacheType?: KvCacheType;
  /** Read from the model file once the runtime has looked at it; for memory estimates. */
  kv?: KvShape;
  /**
   * Whether chats give it the agent tools. Off unless turned on: their definitions run to thousands
   * of tokens, which a phone reads slowly, and llama.cpp re-parses every token against them.
   */
  tools?: boolean;
  efforts?: string[];
  params?: number;
  addedAt: number;
};

export type DownloadFile = { path: string; size: number; done: boolean };

export type Download = {
  id: string;
  repo: string;
  quant: string;
  dir: string;
  /** Model shards first, then the projector if there is one. */
  files: DownloadFile[];
  /** Repo path of the projector among `files`. */
  mmproj?: string;
  total: number;
  received: number;
  /**
   * `interrupted` when the app closed mid-download: finished files are kept and the one that was
   * downloading starts over. `paused` downloads pick up where they stopped.
   */
  status: 'downloading' | 'paused' | 'error' | 'interrupted';
  error?: string;
  /** Resume data for the file that was downloading when paused. */
  pause?: DownloadPauseState;
  pausedPath?: string;
  meta: Pick<LocalModel, 'contextLength' | 'efforts' | 'params'>;
  startedAt: number;
};

interface LocalState {
  models: LocalModel[];
  downloads: Record<string, Download>;
  /** Whether to offload layers to the GPU (OpenCL on Adreno, Metal on iOS). */
  gpu: boolean;
  /** Load the vision projector with models that have one, so they can see images. */
  vision: boolean;
  setDownload: (download: Download) => void;
  patchDownload: (id: string, patch: Partial<Download>) => void;
  removeDownload: (id: string) => void;
  addModel: (model: LocalModel) => void;
  removeModel: (id: string) => void;
  updateModel: (id: string, patch: Partial<Omit<LocalModel, 'id'>>) => void;
  setGpu: (on: boolean) => void;
  setVision: (on: boolean) => void;
}

export const useLocalModels = create<LocalState>()(
  persist(
    (set, get) => ({
      models: [],
      downloads: {},
      // Metal is dependable on iPhones; OpenCL only on some Android GPUs, so it's opt-in there.
      gpu: Platform.OS === 'ios',
      vision: true,
      setDownload: (download) => set({ downloads: { ...get().downloads, [download.id]: download } }),
      patchDownload: (id, patch) => {
        const current = get().downloads[id];
        if (current) set({ downloads: { ...get().downloads, [id]: { ...current, ...patch } } });
      },
      removeDownload: (id) => {
        const { [id]: _, ...rest } = get().downloads;
        set({ downloads: rest });
      },
      addModel: (model) => {
        set({ models: [...get().models.filter((m) => m.id !== model.id), model] });
      },
      removeModel: (id) => {
        set({ models: get().models.filter((m) => m.id !== id) });
      },
      updateModel: (id, patch) => set({ models: get().models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }),
      setGpu: (gpu) => set({ gpu }),
      setVision: (vision) => set({ vision }),
    }),
    {
      name: 'local-models',
      storage: jsonFileStorage,
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as LocalState & { contextSize?: number };
        // v0 had one context length for every model; each model now keeps its own.
        if (version < 1) {
          const old = state.contextSize ?? DEFAULT_CONTEXT;
          state.models = (state.models ?? []).map((m) => ({ ...m, context: m.context ?? clampContext(m, old) }));
          delete state.contextSize;
        }
        return state;
      },
      // A download that was running when the app closed has no task behind it any more.
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<LocalState>) };
        state.downloads = Object.fromEntries(
          Object.entries(state.downloads ?? {}).map(([id, d]) => [
            id,
            d.status === 'downloading' ? { ...d, status: 'interrupted' as const } : d,
          ])
        );
        return state;
      },
    }
  )
);

/** The largest context a model can be given: its trained window. */
export function maxContext(model: Pick<LocalModel, 'contextLength'>) {
  return model.contextLength ?? UNKNOWN_MAX_CONTEXT;
}

function clampContext(model: Pick<LocalModel, 'contextLength'>, n: number) {
  return Math.min(n, maxContext(model));
}

/** The context a model loads with: the one set for it, else 8K or its own window if smaller. */
export function contextFor(model: Pick<LocalModel, 'contextLength' | 'context'>) {
  return clampContext(model, model.context ?? DEFAULT_CONTEXT);
}

/** Context lengths to offer on the slider, up to the model's window (always included). */
export function contextSteps(model: Pick<LocalModel, 'contextLength'>) {
  const max = maxContext(model);
  const steps: number[] = [];
  for (let n = 1024; n < max; n *= 2) {
    steps.push(n);
    // A midpoint between each doubling, from 4K up: 6K, 12K, 24K...
    if (n >= 4096 && n * 1.5 < max) steps.push(n * 1.5);
  }
  steps.push(max);
  return steps;
}

/** Roughly how much memory the KV cache takes at `context` tokens, or null if the shape isn't known. */
export function kvCacheBytes(model: Pick<LocalModel, 'kv'>, context: number, type: KvCacheType = 'f16') {
  const kv = model.kv;
  if (!kv) return null;
  return Math.round(context * kv.heads * (kv.keyLength + kv.valueLength) * KV_BYTES[type]);
}

/** Whether chats with this on-device model get tools; false for models that aren't downloaded. */
export function localToolsOn(modelId: string) {
  return !!useLocalModels.getState().models.find((m) => m.id === modelId)?.tools;
}
