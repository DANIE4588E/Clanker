import { fetch } from '@/lib/net';

export function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 60 * 60 * 1000);
  const ts = Date.parse(raw);
  if (Number.isFinite(ts) && ts > Date.now()) return Math.min(ts - Date.now(), 60 * 60 * 1000);
  return undefined;
}

async function errorFrom(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => '');
  let message = body;
  try {
    const json = JSON.parse(body);
    const err = Array.isArray(json) ? json[0]?.error : json.error;
    message = (typeof err === 'string' ? err : err?.message) ?? json.message ?? body;
  } catch {}
  return new ProviderError(
    `${res.status} ${res.statusText || 'Error'}${message ? `: ${message}` : ''}`,
    res.status,
    parseRetryAfter(res)
  );
}

export async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }
) {
  const res = await fetch(url, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  if (!res.ok) throw await errorFrom(res as unknown as Response);
  return res;
}

export async function getJson<T = any>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await request(url, { headers });
  return (await res.json()) as T;
}

/** Yields each complete line of a streamed response body. */
export async function* readLines(res: { body: ReadableStream<Uint8Array> | null }) {
  if (!res.body) throw new ProviderError('Response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // How much of the buffer is known to hold no line break, so a long line arriving over many
  // chunks isn't searched from its start each time.
  let searched = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Lines are read off by position and the rest kept once per chunk, not copied once per line.
    let start = 0;
    let nl: number;
    while ((nl = buffer.indexOf('\n', Math.max(start, searched))) >= 0) {
      const line = buffer.slice(start, nl);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      start = nl + 1;
    }
    if (start) buffer = buffer.slice(start);
    searched = buffer.length;
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/** Yields the `data:` payloads of a server-sent-events stream. */
export async function* readSSE(res: { body: ReadableStream<Uint8Array> | null }) {
  for await (const line of readLines(res)) {
    if (line.startsWith('data:')) yield line.slice(5).trimStart();
  }
}
