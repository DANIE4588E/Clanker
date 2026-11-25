import { File, Paths } from 'expo-file-system';
import { TurboModuleRegistry } from 'react-native';
import type { LlamaContext } from 'llama.rn';
import { create } from 'zustand';
import { contextFor, useLocalModels, type KvShape, type LocalModel } from '@/store/localModels';

/**
 * Keeps one llama.cpp context loaded at a time and runs completions on it one after another:
 * a context can only decode one request, and a phone can rarely hold two models.
 */

export function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * What the runtime is busy with before a reply's first token, for the chat to show: reading the
 * model into memory (progress 0–100), or reading the prompt, which on a phone can take a minute.
 */
export type LocalActivity =
  | { modelId: string; phase: 'loading'; progress: number }
  | { modelId: string; phase: 'prompt'; tokens: number; since: number };

export const useLocalActivity = create<{ activity: LocalActivity | null }>()(() => ({ activity: null }));

export const setActivity = (activity: LocalActivity | null) => useLocalActivity.setState({ activity });

/** What `modelId` is busy with, or null when it's idle or already streaming. */
export function useActivityOf(modelId: string | undefined) {
  return useLocalActivity((s) => (modelId && s.activity?.modelId === modelId ? s.activity : null));
}

/** Whether this build of the app includes the llama.cpp native module. */
export function runtimeAvailable() {
  try {
    return TurboModuleRegistry.get('RNLlama') != null;
  } catch {
    return false;
  }
}

type Loaded = {
  modelId: string;
  /** What the context was loaded with; a change means loading it again. */
  key: string;
  context: LlamaContext;
  nCtx: number;
  vision: boolean;
};

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
/** The tail of the queue of requests waiting for the context. */
let queue: Promise<unknown> = Promise.resolve();

function llama(): typeof import('llama.rn') {
  if (!runtimeAvailable()) {
    throw new Error('This build of Clanker doesn’t include the on-device runtime. Install a newer build to run local models.');
  }
  // Loaded on first use, so the rest of the app starts without it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('llama.rn');
}

function pathOf(model: LocalModel, file: string) {
  const uri = new File(Paths.document, 'models', model.dir, file).uri;
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

async function load(model: LocalModel): Promise<Loaded> {
  const { gpu, vision } = useLocalModels.getState();
  const nCtx = contextFor(model);
  const cache = model.cacheType ?? 'f16';
  const withVision = vision && !!model.mmproj;
  const key = `${model.id}|${nCtx}|${cache}|${gpu}|${withVision}`;
  if (loaded?.key === key) return loaded;
  if (loaded) await release();
  const { initLlama } = llama();
  setActivity({ modelId: model.id, phase: 'loading', progress: 0 });
  try {
    const context = await initLlama(
      {
        model: pathOf(model, model.file),
        n_ctx: nCtx,
        n_gpu_layers: gpu ? 99 : 0,
        use_mlock: false,
        use_mmap: true,
        // Multimodal prompts can't be shifted out of the window.
        ctx_shift: !withVision,
        no_gpu_devices: !gpu,
        cache_type_k: cache,
        cache_type_v: cache,
        // llama.cpp can only quantize the V cache with flash attention on.
        flash_attn_type: cache === 'f16' ? 'auto' : 'on',
      },
      (progress) => setActivity({ modelId: model.id, phase: 'loading', progress: Math.round(progress) })
    );
    if (__DEV__) {
      // Which CPU build loaded (dotprod / i8mm make a large difference), and whether the GPU took it.
      console.log(
        `[on-device] loaded ${model.id}: ${nCtx} context, ${cache} cache, library ${context.androidLib ?? 'default'}, ` +
          `GPU ${context.gpu ? `on (${(context.devices ?? []).join(', ') || 'yes'})` : `off${context.reasonNoGPU ? ` (${context.reasonNoGPU})` : ''}`}
` +
          `${context.systemInfo}`
      );
    }
    if (!model.kv) {
      const kv = kvShapeOf(context.model.metadata as Record<string, unknown>);
      if (kv) useLocalModels.getState().updateModel(model.id, { kv });
    }
    let visionOn = false;
    if (withVision) {
      try {
        visionOn = await context.initMultimodal({ path: pathOf(model, model.mmproj!), use_gpu: gpu });
      } catch {
        visionOn = false;
      }
    }
    loaded = { modelId: model.id, key, context, nCtx, vision: visionOn };
    return loaded;
  } finally {
    setActivity(null);
  }
}

/** A GGUF metadata value as a number; the runtime hands them over as strings. */
function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Per-layer values ("[8, 8, 4]") summed, or one value times the layer count. */
function perLayerSum(value: unknown, layers: number): number | undefined {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + (num(v) ?? 0), 0) || undefined;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      return perLayerSum(JSON.parse(value), layers);
    } catch {
      return undefined;
    }
  }
  const n = num(value);
  return n ? n * layers : undefined;
}

/** The KV cache's shape from GGUF metadata (`<arch>.block_count` and the attention sizes). */
export function kvShapeOf(meta: Record<string, unknown>): KvShape | undefined {
  const arch = meta['general.architecture'];
  if (typeof arch !== 'string') return undefined;
  const get = (key: string) => meta[`${arch}.${key}`];
  const layers = num(get('block_count'));
  const headCount = get('attention.head_count');
  const heads = layers ? perLayerSum(get('attention.head_count_kv') ?? headCount, layers) : undefined;
  const embd = num(get('embedding_length'));
  const firstHeads = num(Array.isArray(headCount) ? headCount[0] : headCount);
  const fallback = embd && firstHeads ? embd / firstHeads : undefined;
  const keyLength = num(get('attention.key_length')) ?? fallback;
  const valueLength = num(get('attention.value_length')) ?? keyLength;
  if (!heads || !keyLength || !valueLength) return undefined;
  return { heads, keyLength, valueLength };
}

const inspected = new Set<string>();

/**
 * Reads a downloaded model's header (not its weights) to fill in what memory estimates need.
 * Quick, and safe to call while another model is loaded.
 */
export async function inspectModel(model: LocalModel) {
  // Once per model per run: a header without the fields it needs won't grow them.
  if (model.kv || inspected.has(model.id) || !runtimeAvailable()) return;
  inspected.add(model.id);
  try {
    const meta = (await llama().loadLlamaModelInfo(pathOf(model, model.file))) as Record<string, unknown>;
    const kv = kvShapeOf(meta);
    const arch = meta['general.architecture'];
    const trained = typeof arch === 'string' ? num(meta[`${arch}.context_length`]) : undefined;
    const patch = {
      ...(kv ? { kv } : {}),
      ...(!model.contextLength && trained ? { contextLength: trained } : {}),
    };
    if (Object.keys(patch).length) useLocalModels.getState().updateModel(model.id, patch);
  } catch {
    // Estimates just stay unavailable.
  }
}

async function release() {
  const current = loaded;
  loaded = null;
  if (current) await current.context.release().catch(() => {});
}

/** Unloads the model if it's the one in memory, before its files are deleted. */
export async function releaseModel(modelId: string) {
  await queue.catch(() => {});
  if (loaded?.modelId === modelId) await release();
}

/** Frees the loaded model's memory. */
export async function unloadAll() {
  await queue.catch(() => {});
  await release();
}

export function loadedModelId() {
  return loaded?.modelId ?? null;
}

/**
 * Runs `fn` with the model's context once the requests ahead of it are done, loading the model
 * first if another one (or other settings) is in memory.
 */
export function withContext<T>(modelId: string, signal: AbortSignal, fn: (loaded: Loaded) => Promise<T>): Promise<T> {
  const run = async () => {
    if (signal.aborted) throw abortError();
    const model = useLocalModels.getState().models.find((m) => m.id === modelId);
    if (!model) throw new Error(`${modelId} isn’t downloaded on this phone any more.`);
    loading = load(model);
    let ctx: Loaded;
    try {
      ctx = await loading;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Couldn’t load ${modelId}: ${message}. The phone may not have enough free memory for it; try a smaller quantization or a shorter context.`);
    } finally {
      loading = null;
    }
    if (signal.aborted) throw abortError();
    return fn(ctx);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
