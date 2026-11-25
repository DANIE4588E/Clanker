import { fetch } from '@/lib/net';
import { apiKeys } from '@/lib/storage';

/** Hugging Face Hub: finding GGUF repos and the quantizations each one offers. */

const HUB = 'https://huggingface.co';

/** SecureStore id of the optional Hugging Face token, for gated repos and higher rate limits. */
export const HF_TOKEN_ID = 'huggingface';

export const hfToken = {
  get: () => apiKeys.get(HF_TOKEN_ID),
  set: (token: string) => apiKeys.set(HF_TOKEN_ID, token.trim()),
};

export async function hfHeaders(): Promise<Record<string, string>> {
  const token = await hfToken.get().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type HfSort = 'trendingScore' | 'downloads' | 'likes' | 'lastModified';

export type HfModel = {
  id: string;
  downloads: number;
  likes: number;
  /** e.g. text-generation, image-text-to-text. */
  pipeline?: string;
  tags: string[];
  updatedAt?: string;
};

export type QuantFile = { path: string; size: number };

export type Quant = {
  /** The folder and file stem the shards share; unique within the repo. */
  key: string;
  /** The quantization as people name it, e.g. Q4_K_M or UD-Q4_K_XL. */
  label: string;
  /** Shards in order; usually just one. */
  files: QuantFile[];
  size: number;
};

export type RepoInfo = {
  id: string;
  quants: Quant[];
  /** Vision projector, when the repo has one; lets the model see images. */
  mmproj?: QuantFile;
  /** Parameter count from the GGUF header. */
  params?: number;
  architecture?: string;
  /** Context window the model was trained for. */
  contextLength?: number;
  chatTemplate?: string;
  /** Set when the repo makes people accept terms before downloading. */
  gated: boolean;
  pipeline?: string;
  downloads: number;
  likes: number;
};

class HubError extends Error {}

async function hubJson<T>(url: string, signal?: AbortSignal): Promise<{ json: T; next?: string }> {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...(await hfHeaders()) }, signal });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new HubError('Hugging Face refused the request. This repo may be gated: add a token in On-device settings.');
    }
    if (res.status === 404) throw new HubError('Repo not found on Hugging Face.');
    if (res.status === 429) throw new HubError('Hugging Face is rate limiting requests. Try again in a minute, or add a token.');
    throw new HubError(`Hugging Face returned ${res.status}.`);
  }
  // The tree listing pages with a Link header.
  const link = res.headers.get('link') ?? '';
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  return { json: (await res.json()) as T, next };
}

export async function searchModels(opts: {
  query?: string;
  sort: HfSort;
  author?: string;
  signal?: AbortSignal;
}): Promise<HfModel[]> {
  const params = new URLSearchParams({ filter: 'gguf', sort: opts.sort, direction: '-1', limit: '40' });
  if (opts.query?.trim()) params.set('search', opts.query.trim());
  if (opts.author) params.set('author', opts.author);
  const { json } = await hubJson<any[]>(`${HUB}/api/models?${params}`, opts.signal);
  return json.map((m) => ({
    id: m.id ?? m.modelId,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    pipeline: m.pipeline_tag,
    tags: m.tags ?? [],
    updatedAt: m.lastModified ?? m.createdAt,
  }));
}

const SHARD = /-(\d{5})-of-(\d{5})$/;
const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[0-9A-Z]+)*|BF16|F16|F32|FP16|FP32|MXFP4(?:_MOE)?|TQ\d_\d))(?=$|[-_.])/gi;

/** The quantization a file or folder name carries, e.g. "Qwen3-4B-UD-Q4_K_XL" → "UD-Q4_K_XL". */
export function quantOf(name: string): string | undefined {
  const matches = [...name.matchAll(QUANT)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : undefined;
}

const isMmproj = (path: string) => /mmproj/i.test(path.split('/').pop() ?? '');

/**
 * GGUFs that ship beside the model but aren't one: importance matrices, and the small draft
 * models for speculative decoding (MTP heads, Unsloth's "dspark" drafts), at the top or in folders.
 */
const isAuxiliary = (path: string) => /(^|[/_-])(imatrix|mtp|dspark|draft)([/_.-]|$)/i.test(path);

/** Projectors in the order llama.cpp on a phone handles them best. */
function pickMmproj(files: QuantFile[]) {
  const rank = (p: string) => {
    const n = p.toUpperCase();
    if (/(^|[^B])F16/.test(n)) return 0;
    if (n.includes('BF16')) return 1;
    if (n.includes('Q8_0')) return 2;
    if (n.includes('F32')) return 3;
    return 4;
  };
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.size - b.size)[0];
}

/** Groups a repo's .gguf files into quantizations, joining the shards of split models. */
export function groupQuants(files: QuantFile[]): { quants: Quant[]; mmproj?: QuantFile } {
  const ggufs = files.filter((f) => f.path.toLowerCase().endsWith('.gguf'));
  const projectors = ggufs.filter((f) => isMmproj(f.path));
  const groups = new Map<string, Quant>();
  for (const f of ggufs) {
    if (isMmproj(f.path) || isAuxiliary(f.path)) continue;
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash) : '';
    const stem = f.path.slice(slash + 1).replace(/\.gguf$/i, '').replace(SHARD, '');
    const key = `${dir}/${stem}`;
    const group = groups.get(key) ?? {
      key,
      label: quantOf(stem) ?? quantOf(dir.split('/').pop() ?? '') ?? stem,
      files: [],
      size: 0,
    };
    group.files.push(f);
    group.size += f.size;
    groups.set(key, group);
  }
  const quants = [...groups.values()]
    .map((q) => ({ ...q, files: q.files.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.size - b.size);
  // Two groups with one label (say, one in a folder and one at the top) keep their stems apart.
  const counts = new Map<string, number>();
  for (const q of quants) counts.set(q.label, (counts.get(q.label) ?? 0) + 1);
  for (const q of quants) if ((counts.get(q.label) ?? 0) > 1) q.label = q.key.replace(/^\//, '');
  return { quants, mmproj: projectors.length ? pickMmproj(projectors) : undefined };
}

export async function getRepo(id: string, signal?: AbortSignal): Promise<RepoInfo> {
  const expand = ['gguf', 'gated', 'downloads', 'likes', 'pipeline_tag'].map((e) => `expand[]=${e}`).join('&');
  const infoReq = hubJson<any>(`${HUB}/api/models/${id}?${expand}`, signal);
  const files: QuantFile[] = [];
  let url: string | undefined = `${HUB}/api/models/${id}/tree/main?recursive=true`;
  for (let page = 0; url && page < 20; page++) {
    const { json, next }: { json: any[]; next?: string } = await hubJson<any[]>(url, signal);
    for (const entry of json) {
      if (entry.type !== 'file') continue;
      files.push({ path: entry.path, size: entry.lfs?.size ?? entry.size ?? 0 });
    }
    url = next;
  }
  const { json: info } = await infoReq;
  const { quants, mmproj } = groupQuants(files);
  const gguf = info.gguf ?? {};
  return {
    id,
    quants,
    mmproj,
    params: typeof gguf.total === 'number' ? gguf.total : undefined,
    architecture: gguf.architecture,
    contextLength: typeof gguf.context_length === 'number' ? gguf.context_length : undefined,
    chatTemplate: typeof gguf.chat_template === 'string' ? gguf.chat_template : undefined,
    gated: !!info.gated,
    pipeline: info.pipeline_tag,
    downloads: info.downloads ?? 0,
    likes: info.likes ?? 0,
  };
}

export function fileUrl(repo: string, path: string) {
  return `${HUB}/${repo}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}?download=true`;
}

/** Quantizations most people should start with, best first. */
const PREFERRED = [
  'UD-Q4_K_XL',
  'Q4_K_M',
  'UD-Q4_K_M',
  'Q4_K_S',
  'UD-Q4_K_S',
  'IQ4_XS',
  'UD-IQ4_XS',
  'IQ4_NL',
  'Q4_0',
  'UD-Q3_K_XL',
  'Q3_K_M',
  'UD-IQ3_XXS',
  'Q5_K_M',
  'Q6_K',
  'Q8_0',
];

/** The quantization to suggest: the first preferred one that fits, else the smallest. */
export function recommendedQuant(quants: Quant[], fits: (bytes: number) => boolean): Quant | undefined {
  for (const label of PREFERRED) {
    const q = quants.find((x) => x.label === label);
    if (q && fits(q.size)) return q;
  }
  return quants.find((q) => fits(q.size));
}

export function formatCount(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

/** "4.0B" from a parameter count. */
export function formatParams(n: number) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  return `${Math.round(n / 1e6)}M`;
}
