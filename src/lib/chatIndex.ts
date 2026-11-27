import type { Message } from '@/store/chats';
import type { AttachmentPart, ContentPart } from './providers';

/**
 * What the chat list keeps of each chat without its messages (see store/chats and lib/storage):
 * enough for lists, the usage heatmap and the Library, so a chat's messages are only read from
 * disk once something needs them. Pure functions only: the store imports this module.
 */

// ---- settling --------------------------------------------------------------------------------

/** A tool call the model is still writing. */
export function isDraft(part: ContentPart): boolean {
  return part.type === 'tool' && part.status === 'writing';
}

/**
 * Settles a reply that stopped partway, so the history stays valid for the API: tool calls that
 * never got a result are marked failed, and calls the model never finished writing are dropped.
 */
export function interruptContent(content: ContentPart[]): ContentPart[] {
  return content
    .filter((p) => !isDraft(p))
    .map((p) =>
      p.type === 'tool' && p.status === 'running'
        ? { ...p, status: 'error', output: p.output ?? 'Interrupted before it finished.' }
        : p
    );
}

// ---- files a reply handed over (the Library and the turn's file chips) -----------------------

/** Files a reply handed over with present_files, or null when it handed over none. */
export function presentedIn(content: ContentPart[]): string[] | null {
  const calls = content.filter((p) => p.type === 'tool' && p.name === 'present_files' && p.status === 'done');
  if (!calls.length) return null;
  return [...new Set(calls.flatMap((p) => (p.type === 'tool' ? (p.files ?? []) : [])))];
}

/** Every workspace file a reply's tool calls created or changed, in the order first touched. */
export function touchedIn(content: ContentPart[]): string[] {
  return [...new Set(content.flatMap((p) => (p.type === 'tool' ? (p.files ?? []) : [])))];
}

// For replies that didn't say which files were for the user: what agents make for themselves.
const SCRATCH_DIR = /(^|\/)(\.[^/]*|__pycache__|node_modules|tmp|temp|scratch|cache|venv|\.venv)\//i;
const SCRATCH_NAME =
  /^(test|tests|check|verify|validate|debug|scratch|tmp|temp|probe|inspect|try|sanity|lint)([-_. \d]|$)|[-_.](test|spec|check|debug|tmp)\.[^./]+$|\.(pyc|log|map|tmp|bak|lock|orig)$/i;

/** Whether a path looks like a helper an agent wrote for its own use: a check, a test, a temp file. */
export const looksScratch = (path: string) => SCRATCH_DIR.test(path) || SCRATCH_NAME.test(path.split('/').pop() ?? path);

/** The files a reply made for the user (see presentedIn), for the Library. */
export const deliverablesOf = (content: ContentPart[]) => presentedIn(content) ?? touchedIn(content).filter((p) => !looksScratch(p));

// ---- per-chat facts --------------------------------------------------------------------------

// lib/context's estimate; imported from there it would make a cycle through the store.
const CHARS_PER_TOKEN = 4;

const textOf = (m: Pick<Message, 'content'>) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

/**
 * Usage is summed over spans this long. Every time zone is a whole number of quarter hours off
 * UTC, so a span never straddles a local midnight: days worked out from spans match the replies'.
 */
export const USAGE_SPAN = 15 * 60 * 1000;

/**
 * The usage of the replies in one span with one model: [span start, model (null: the chat's
 * own), input, output, cached, cacheable, requests]. See lib/activity.
 */
export type UsageBucket = [number, string | null, number, number, number, number, number];

/** A file or image the user attached, for the Library. */
export type UploadRef = {
  /** "<message id>:<part index>". */
  k: string;
  /** The message's id. */
  m: string;
  at: number;
  /** In the chat list, the part without its inlined text (which stays in the chat's own file). */
  part: AttachmentPart;
  /** Set in the chat list when the part has inlined text. */
  t?: 1;
  /** The file's size, or its inlined text's length. */
  z?: number;
};

/** A workspace file a reply handed over: [path, when the reply was written]. */
export type FileRef = [string, number];

export type ChatSummary = {
  /** How many messages the chat has. */
  n: number;
  /** Its last message was still being written. */
  w?: 1;
  /** That message is a reply the app may pick up again (see resumeInterruptedReplies in lib/chat). */
  r?: 1;
  /** The first line of the last message the user sent. */
  p?: string;
  u?: UsageBucket[];
  up?: UploadRef[];
  /** Files replies handed over, as they'd be once the chat is loaded (a cut-off reply settled). */
  f?: FileRef[];
};

type Facts = {
  usage: [number, string | null, number, number, number, number, number] | null;
  uploads: UploadRef[];
  /** For the chat list: what the reply handed over, a reply still being written as if settled. */
  files: string[];
};

const facts = new WeakMap<Message, Facts>();

/** One message's share of the summary, kept per message: a streamed token only redoes the last one. */
function factsOf(m: Message): Facts {
  let f = facts.get(m);
  if (f) return f;
  let usage: Facts['usage'] = null;
  if (m.role === 'assistant') {
    const steps = m.steps ?? [];
    let input = 0;
    let output = 0;
    let cached = 0;
    let cacheable = 0;
    for (const s of steps) {
      output += s.tokens;
      input += s.input ?? 0;
      if (s.input && s.cached != null) {
        cached += s.cached;
        cacheable += s.input;
      }
    }
    if (!steps.length) output = Math.ceil(textOf(m).length / CHARS_PER_TOKEN);
    if (input || output) {
      usage = [m.createdAt - (m.createdAt % USAGE_SPAN), m.model ?? null, input, output, cached, cacheable, Math.max(steps.length, 1)];
    }
  }
  const uploads: UploadRef[] = [];
  if (m.role === 'user') {
    m.content.forEach((p, i) => {
      if (p.type !== 'image' && p.type !== 'file') return;
      uploads.push({ k: `${m.id}:${i}`, m: m.id, at: m.createdAt, part: p });
    });
  }
  const files =
    m.role === 'assistant' ? deliverablesOf(m.status === 'streaming' ? interruptContent(m.content) : m.content) : [];
  f = { usage, uploads, files };
  facts.set(m, f);
  return f;
}

const buckets = new WeakMap<Message[], UsageBucket[]>();

/** The chat's usage by span and model (see UsageBucket), in order of first reply. */
export function usageBuckets(messages: Message[]): UsageBucket[] {
  let out = buckets.get(messages);
  if (out) return out;
  const byKey = new Map<string, UsageBucket>();
  for (const m of messages) {
    const u = factsOf(m).usage;
    if (!u) continue;
    const key = `${u[0]}\n${u[1] ?? '\u0000'}`;
    const b = byKey.get(key);
    if (!b) byKey.set(key, [...u]);
    else for (let i = 2; i < 7; i++) (b[i] as number) += u[i] as number;
  }
  out = [...byKey.values()];
  buckets.set(messages, out);
  return out;
}

export type LibraryRefs = { uploads: UploadRef[]; files: FileRef[] };

const liveRefs = new WeakMap<Message[], LibraryRefs>();

/**
 * What the chat adds to the Library: its uploads, newest first, and the files its finished replies
 * handed over, in order. With the full parts, as the loaded chat has them.
 */
export function libraryRefs(messages: Message[]): LibraryRefs {
  let out = liveRefs.get(messages);
  if (out) return out;
  const uploads: UploadRef[] = [];
  const files: FileRef[] = [];
  for (const m of messages) {
    const f = factsOf(m);
    uploads.push(...f.uploads);
    if (m.status !== 'streaming') for (const path of f.files) files.push([path, m.createdAt]);
  }
  out = { uploads: uploads.reverse(), files };
  liveRefs.set(messages, out);
  return out;
}

/** The first line of the last message the user sent. */
export function previewOf(messages: Message[]): string {
  const lastUser = messages.findLast((m) => m.role === 'user');
  return lastUser ? textOf(lastUser).trim().split('\n')[0] : '';
}

// Lists show the preview on one line; nothing past this is ever seen.
const PREVIEW_CHARS = 300;

const summaries = new WeakMap<Message[], ChatSummary>();

/** The chat list's summary of a chat's messages (see ChatSummary). */
export function summarize(messages: Message[]): ChatSummary {
  let s = summaries.get(messages);
  if (s) return s;
  const last = messages[messages.length - 1];
  const working = last?.status === 'streaming';
  const uploads: UploadRef[] = [];
  const files: FileRef[] = [];
  for (const m of messages) {
    const f = factsOf(m);
    for (const u of f.uploads) {
      const { text, ...part } = u.part as AttachmentPart & { text?: string };
      const size = part.type === 'file' ? (part.size ?? text?.length) : undefined;
      uploads.push({ ...u, part: part as AttachmentPart, ...(text != null ? { t: 1 as const } : {}), ...(size != null ? { z: size } : {}) });
    }
    for (const path of f.files) files.push([path, m.createdAt]);
  }
  const preview = previewOf(messages).slice(0, PREVIEW_CHARS);
  const usage = usageBuckets(messages);
  s = {
    n: messages.length,
    ...(working ? { w: 1 as const } : {}),
    ...(working && last.role === 'assistant' && !last.autoResumed ? { r: 1 as const } : {}),
    ...(preview ? { p: preview } : {}),
    ...(usage.length ? { u: usage } : {}),
    ...(uploads.length ? { up: uploads.reverse() } : {}),
    ...(files.length ? { f: files } : {}),
  };
  summaries.set(messages, s);
  return s;
}
