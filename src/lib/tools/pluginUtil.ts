import { formatSize, type Workspace } from '../workspace';
import { requireObserved } from './observe';
import { htmlToMarkdown } from './web';

/** Helpers shared by the plugin tools (Gmail, GitHub, Dropbox, ...). */

export const MAX_OUTPUT_CHARS = 30_000;
/** Largest file a plugin tool uploads or downloads. */
export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

/** Cuts long results down to their head and tail. */
export function clip(text: string, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.25));
  return `${head}\n\n[… ${text.length - head.length - tail.length} characters omitted …]\n\n${tail}`;
}

/** A required string argument. */
export function str(value: unknown, name: string): string {
  if (value == null || value === '') throw new Error(`Missing required argument "${name}".`);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** An optional string argument, trimmed; undefined when empty. */
export const opt = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** An integer argument within [min, max], or the fallback. */
export function int(value: unknown, fallback: number, min = 1, max = 100) {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** An array argument; models sometimes send arrays as JSON strings, or one item bare. */
export function list<T = unknown>(value: unknown): T[] {
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('[')) {
      try {
        return JSON.parse(t);
      } catch {}
    }
    return [value as T];
  }
  return Array.isArray(value) ? value : [value as T];
}

/** Like list(), for strings: also splits "a, b". */
export const strings = (value: unknown) =>
  list(value)
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : [String(v)]))
    .map((v) => v.trim())
    .filter(Boolean);

/** A file name safe for the workspace. */
export const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';

export const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export const extOf = (name: string) => name.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? '';

export const mimeFor = (name: string, fallback = 'application/octet-stream') => EXT_MIME[extOf(name)] ?? fallback;

/** A workspace file to upload: its bytes, name and type. Refuses missing and oversized files. */
export async function readUpload(ws: Workspace, path: string) {
  const rel = ws.normalizePath(str(path, 'path'));
  const file = ws.fileAt(rel);
  if (!file.exists) throw new Error(`No such file in the workspace: "${rel}".`);
  if (file.size > MAX_TRANSFER_BYTES) throw new Error(`${rel} is ${formatSize(file.size)}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);
  const name = rel.split('/').pop()!;
  return { path: rel, name, bytes: await file.bytes(), mime: mimeFor(name, file.type || 'application/octet-stream'), size: file.size };
}

/**
 * Saves downloaded bytes into the workspace: at `saveAs` (refused if it's an existing file the
 * model hasn't seen), or under `dir` with a name that doesn't clash. Returns the path, to list
 * in the outcome's `files`.
 */
export async function saveDownload(opts: {
  ws: Workspace;
  conversationId: string;
  bytes: Uint8Array;
  name: string;
  dir: string;
  saveAs?: string;
}) {
  const { ws, conversationId, bytes, name, dir } = opts;
  if (bytes.length > MAX_TRANSFER_BYTES) throw new Error(`The file is ${formatSize(bytes.length)}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);
  let path: string;
  if (opts.saveAs?.trim()) {
    path = ws.normalizePath(opts.saveAs);
    if (ws.dirAt(path).exists) throw new Error(`"${path}" is a folder.`);
    requireObserved(conversationId, path, 'overwrite');
  } else path = ws.freePath(safeName(name), dir);
  ws.ensureParent(path);
  const file = ws.fileAt(path);
  await file.write(bytes);
  return { path, size: file.size };
}

/** A multipart/related upload body: JSON metadata, then the file's bytes. */
export function multipartRelated(meta: object, bytes: Uint8Array, mime: string) {
  const boundary = `clanker${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/** Base64 of bytes (standard alphabet, padded). */
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Bytes of base64 or base64url text. */
export function fromBase64(text: string) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Readable text from an HTML email or page body. */
export const htmlToText = (html: string) => htmlToMarkdown(html, 'https://example.invalid/').text;

/** A short date-time for listings, e.g. "2026-11-26 14:05". */
export const shortDate = (iso: string | undefined) => (iso ? iso.replace('T', ' ').slice(0, 16) : '');

/** Labels for tool rows in the chat, by tool name. */
export type ToolLabels = Record<string, (input: Record<string, unknown>) => string>;

/** A string field of a tool call's input, for labels. */
export const field = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');

/** Shortens text for a label. */
export const short = (text: string, max = 50) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
