import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

const dataDir = new Directory(Paths.document, 'data');

function fileFor(name: string) {
  if (!dataDir.exists) dataDir.create({ intermediates: true });
  return new File(dataDir, `${name}.json`);
}

const WRITE_MS = 2500;
const DEFER_RETRY_MS = 500;

const pending = new Map<string, StorageValue<unknown>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let scrollDeferCount = 0;

function flush(force = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending.size) return;
  if (!force && scrollDeferCount > 0) {
    // Avoid stalling the JS thread with JSON.stringify + sync disk writes mid-scroll.
    timer = setTimeout(() => flush(false), DEFER_RETRY_MS);
    return;
  }
  for (const [name, value] of pending) {
    const split = splits.get(name);
    if (split?.lazy) writeLazySplit(split, value);
    else if (split) writeSplit(split, value);
    else fileFor(name).writeSync(JSON.stringify(value));
  }
  pending.clear();
}

/**
 * How a split store keeps its entries out of memory until they're used (see splitJsonFileStorage).
 * The meta file then lists every entry without its `heavy` fields, plus a summary of them, so the
 * store can start from that alone.
 */
export type LazySplitOptions = {
  /** Fields kept only in the entry's own file, and read from it the first time one is used. */
  heavy: readonly string[];
  /** What the listing keeps of a loaded entry's heavy fields, for code that must not load it. */
  summarize: (entry: any) => unknown;
  /**
   * Brings an entry read on demand up to date, in place: `version` is the store version its file
   * was written at, for migrations of the heavy fields. Its other fields are the listing's.
   */
  revive?: (entry: any, version: number | undefined) => void;
  /**
   * An array field whose last item may be saved on its own while `live` says it's still changing
   * (a reply streaming), so each save writes that item rather than the whole entry.
   */
  tail?: { field: string; live: (item: any) => boolean };
};

/**
 * What an entry's file holds: its heavy fields as last written or read, the stamp written with
 * them, and the store version they're at (files from before the listing don't say).
 */
type OnDisk = { refs: Record<string, unknown>; stamp?: string; version?: number };

/** An entry in the meta file's listing: its fields but the heavy ones, their summary, and its file's version. */
type Listing = { e: Record<string, unknown>; s: unknown; v?: number };

/**
 * A store whose one big record (all chats) is kept as a file per entry, so a write serializes only
 * the entries that changed rather than everything the app has ever said. `meta` holds the rest of
 * the state, the version and the entries' order, and is written last: a split that never finished
 * is ignored in favour of the single file it was made from (`legacy`).
 */
type Split = {
  field: string;
  dir: Directory;
  meta: File;
  legacy: File;
  lazy?: LazySplitOptions & { heavySet: Set<string> };
  /** Each entry as last written or read. State is replaced, not changed, so another object has changed since. */
  written: Map<string, unknown>;
  /** Lazy: every entry with a file, and what it holds (null: an entry not loaded, whose file is as it was). */
  files: Map<string, OnDisk | null>;
  /** Lazy: entries with a tail file, and the array it was written from (true: found on disk). */
  tails: Map<string, unknown>;
  /** Lazy: the heavy fields of entries loaded on demand, by key. */
  loaded: Map<string, Record<string, unknown>>;
  /** Lazy: entries whose file exists but couldn't be read; it's moved aside before anything is written over it. */
  unreadable: Set<string>;
  /** Lazy: the meta file's contents as last written, to skip writing it again when nothing in it changed. */
  lastMeta?: { version: number | undefined; rest: string; keys: string[]; index: Map<string, { item: unknown; json?: string }> };
  /** The version on disk; a different one means migrating, which may have changed entries in place. */
  version: number | undefined;
  /** Everything needs writing, as when what's on disk is still the single file. */
  all: boolean;
};

const splits = new Map<string, Split>();

const entryFile = (split: Split, key: string) => new File(split.dir, `${encodeURIComponent(key)}.json`);
// Not .json, so a listing of entries passes over it.
const tailFile = (split: Split, key: string) => new File(split.dir, `${encodeURIComponent(key)}.tail`);

function splitFor(name: string, field: string, lazy?: LazySplitOptions) {
  let split = splits.get(name);
  if (!split) {
    split = {
      field,
      dir: new Directory(dataDir, name),
      meta: fileFor(`${name}.meta`),
      legacy: fileFor(name),
      lazy: lazy && { ...lazy, heavySet: new Set(lazy.heavy) },
      written: new Map(),
      files: new Map(),
      tails: new Map(),
      loaded: new Map(),
      unreadable: new Set(),
      version: undefined,
      all: false,
    };
    splits.set(name, split);
  }
  return split;
}

function readSplit(split: Split): StorageValue<unknown> | null {
  if (split.lazy) return readLazySplit(split);
  if (split.meta.exists && split.dir.exists) {
    const meta = JSON.parse(split.meta.textSync()) as { version?: number; state?: object; keys?: string[] };
    const entries = new Map<string, unknown>();
    for (const entry of split.dir.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.json')) continue;
      try {
        entries.set(decodeURIComponent(entry.name.slice(0, -'.json'.length)), JSON.parse(entry.textSync()));
      } catch {
        // One damaged file loses its own entry, not all of them.
      }
    }
    const record: Record<string, unknown> = {};
    for (const key of meta.keys ?? []) if (entries.has(key)) record[key] = entries.get(key);
    for (const [key, value] of entries) if (!(key in record)) record[key] = value;
    split.written = new Map(Object.entries(record));
    split.version = meta.version;
    split.all = false;
    return { version: meta.version, state: { ...meta.state, [split.field]: record } };
  }
  if (split.legacy.exists) {
    split.all = true;
    return JSON.parse(split.legacy.textSync());
  }
  return null;
}

function writeSplit(split: Split, value: StorageValue<unknown>) {
  const { [split.field]: record = {}, ...rest } = value.state as Record<string, unknown>;
  const entries = record as Record<string, unknown>;
  const all = split.all || value.version !== split.version;
  if (!split.dir.exists) split.dir.create({ intermediates: true });
  for (const [key, entry] of Object.entries(entries)) {
    if (!all && split.written.get(key) === entry) continue;
    entryFile(split, key).writeSync(JSON.stringify(entry));
    split.written.set(key, entry);
  }
  for (const key of [...split.written.keys()]) {
    if (key in entries) continue;
    const file = entryFile(split, key);
    if (file.exists) file.delete();
    split.written.delete(key);
  }
  split.meta.writeSync(JSON.stringify({ version: value.version, state: rest, keys: Object.keys(entries) }));
  split.version = value.version;
  if (split.all) {
    if (split.legacy.exists) split.legacy.delete();
    split.all = false;
  }
}

// ---- lazy splits ---------------------------------------------------------------------------------
//
// The meta file lists every entry (`index`): its fields but the heavy ones, and a summary of those.
// Reading the store reads only that, and makes each entry a stub: an object with the listed fields
// whose heavy fields are getters, which read the entry's file the first time one is used. So code
// that reads a chat's messages always gets them, loaded or not, while lists never read a chat file.
//
// The guard against losing data: a stub's file is never written, since what the stub holds isn't
// the entry. Changing a listed field gives a new stub (restub), still unloaded; anything else makes
// a plain copy, which spreading the stub fills from its file, and that copy is written like any
// entry. An entry that's gone from the record has its files deleted, loaded or not.

type StubInfo = {
  split: Split;
  key: string;
  summary: unknown;
  /** The store version of its file, where the file doesn't say. */
  version: number | undefined;
  /** The stub's listing, once worked out. */
  item?: Listing;
};

const stubs = new WeakMap<object, StubInfo>();

/** The entry's fields but its heavy ones. Reading those of a stub would load it. */
function listedFields(entry: object, heavy: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(entry)) if (!heavy.has(key)) out[key] = (entry as Record<string, unknown>)[key];
  return out;
}

function pickHeavy(entry: object, heavy: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const key of heavy) out[key] = (entry as Record<string, unknown>)[key];
  return out;
}

function makeStub(split: Split, key: string, fields: Record<string, unknown>, info: Omit<StubInfo, 'split' | 'key'>) {
  const stub: Record<string, unknown> = { ...fields };
  for (const field of split.lazy!.heavy) {
    // Enumerable, so spreading or serializing the stub reads the real values.
    Object.defineProperty(stub, field, {
      enumerable: true,
      configurable: true,
      get: () => loadEntry(split, key, stub)[field],
    });
  }
  stubs.set(stub, { split, key, ...info });
  return stub;
}

/** Whether `entry` is a stub of a lazy split store: an entry whose file hasn't been read into it. */
export function isStub(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && stubs.has(entry);
}

/** The summary the listing keeps of a stub (see LazySplitOptions.summarize); undefined for other entries. */
export function stubSummary<T>(entry: unknown): T | undefined {
  return (entry && typeof entry === 'object' ? stubs.get(entry)?.summary : undefined) as T | undefined;
}

/** Whether a stub's file has been read, so using its heavy fields costs nothing. */
export function stubLoaded(entry: unknown): boolean {
  const info = entry && typeof entry === 'object' ? stubs.get(entry) : undefined;
  return !info || info.split.loaded.has(info.key);
}

/** Reads a stub's file now, as using one of its heavy fields would. */
export function loadStub(entry: unknown) {
  const info = entry && typeof entry === 'object' ? stubs.get(entry) : undefined;
  if (info) loadEntry(info.split, info.key, entry as object);
}

/**
 * The stub with `patch` applied to its listed fields, still unloaded, for changes that don't
 * touch the heavy ones (renaming a chat, archiving it). Any other entry, or a patch with heavy
 * fields, gets a plain copy, which reads the file first.
 */
export function restub<T extends object>(entry: T, patch: Partial<T>): T {
  const info = stubs.get(entry);
  const heavy = info?.split.lazy?.heavySet;
  if (!info || !heavy || Object.keys(patch).some((k) => heavy.has(k))) return { ...entry, ...patch };
  const { split, key, summary, version } = info;
  return makeStub(split, key, { ...listedFields(entry, heavy), ...patch }, { summary, version }) as T;
}

/**
 * Renames an entry file that couldn't be read out of the way before a copy of its entry, loaded
 * empty, is written in its place. False when it can't be moved: then nothing may be written there.
 */
function moveAside(split: Split, key: string): boolean {
  try {
    const file = entryFile(split, key);
    if (file.exists) file.rename(`${encodeURIComponent(key)}.json.unreadable-${Date.now()}`);
    split.unreadable.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** Sets a damaged entry file aside (as .damaged), rather than leave it to be overwritten. */
function setAside(split: Split, key: string, text: string) {
  try {
    new File(split.dir, `${encodeURIComponent(key)}.json.damaged`).writeSync(text);
    entryFile(split, key).delete();
  } catch {
    // Left where it is.
  }
}

/**
 * An entry's file as written: the entry, the stamp it was written with and the store version,
 * with the tail written since applied (`tailed`). Null when there's no file or it can't be read.
 */
function readEntryFile(
  split: Split,
  key: string
): { entry: Record<string, unknown>; stamp?: string; version?: number; tailed?: boolean } | null {
  const file = entryFile(split, key);
  if (!file.exists) return null;
  let text: string;
  try {
    text = file.textSync();
  } catch {
    // There but unreadable for now (an I/O error): the entry loads empty, so its file must not be
    // written over as if it held nothing (see moveAside).
    split.unreadable.add(key);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    setAside(split, key, text);
    return null;
  }
  const { $w: stamp, $v: version, ...entry } = parsed as Record<string, unknown>;
  const tail = split.lazy?.tail;
  let tailed = false;
  if (tail && split.tails.has(key)) {
    try {
      const t = JSON.parse(tailFile(split, key).textSync()) as { of?: string; at?: number; item?: unknown };
      const list = entry[tail.field];
      // Only a tail written on top of this very file: one left from before it was rewritten is stale.
      if (stamp && t.of === stamp && Array.isArray(list) && Number.isInteger(t.at) && t.at! >= 0 && t.at! <= list.length) {
        entry[tail.field] = [...list.slice(0, t.at), t.item];
        tailed = true;
      }
    } catch {
      // A tail cut short by the app dying: the entry as last fully written.
    }
  }
  return {
    entry,
    stamp: typeof stamp === 'string' ? stamp : undefined,
    version: typeof version === 'number' ? version : undefined,
    tailed,
  };
}

/** A stub's heavy fields, read from its file the first time. */
function loadEntry(split: Split, key: string, stub: object): Record<string, unknown> {
  const cached = split.loaded.get(key);
  if (cached) return cached;
  const lazy = split.lazy!;
  const info = stubs.get(stub);
  const read = readEntryFile(split, key);
  const entry: Record<string, unknown> = {};
  // Heavy fields from the file; the rest are the listing's, which may be newer.
  if (read) for (const field of lazy.heavy) if (field in read.entry) entry[field] = read.entry[field];
  Object.assign(entry, listedFields(stub, lazy.heavySet));
  const tailList = lazy.tail && entry[lazy.tail.field];
  lazy.revive?.(entry, read?.version ?? info?.version);
  const heavy = pickHeavy(entry, lazy.heavy);
  split.loaded.set(key, heavy);
  // What the file holds, as far as writing goes: reading it (and reviving) gives these again. An
  // entry with no readable file is written as soon as a copy of it is.
  if (split.files.has(key)) split.files.set(key, read ? onDisk(read, heavy, tailList !== heavy[lazy.tail?.field ?? ''], info?.version) : { refs: {} });
  return heavy;
}

/**
 * What a file read holds, for writing. A new tail goes on top of the file as written, so it's only
 * offered (with the stamp) when what was read is just that: no tail applied, nothing settled.
 */
function onDisk(
  read: { stamp?: string; version?: number; tailed?: boolean },
  refs: Record<string, unknown>,
  changed: boolean,
  version: number | undefined
): OnDisk {
  return { refs, stamp: read.tailed || changed ? undefined : read.stamp, version: read.version ?? version };
}

function readLazySplit(split: Split): StorageValue<unknown> | null {
  const lazy = split.lazy!;
  if (split.meta.exists && split.dir.exists) {
    const meta = JSON.parse(split.meta.textSync()) as {
      version?: number;
      state?: object;
      keys?: string[];
      index?: Record<string, Partial<Listing> | undefined>;
    };
    split.files = new Map();
    split.tails = new Map();
    split.loaded = new Map();
    split.unreadable = new Set();
    split.lastMeta = undefined;
    // Only names: no entry file is read here, unless the listing doesn't have it.
    const names = new Set<string>();
    for (const entry of split.dir.list()) {
      if (!(entry instanceof File)) continue;
      if (entry.name.endsWith('.json')) names.add(decodeURIComponent(entry.name.slice(0, -'.json'.length)));
      else if (entry.name.endsWith('.tail')) split.tails.set(decodeURIComponent(entry.name.slice(0, -'.tail'.length)), true);
    }
    const record: Record<string, unknown> = {};
    const readWhole = (key: string) => {
      const read = readEntryFile(split, key);
      if (!read) return;
      record[key] = read.entry;
      split.files.set(key, onDisk(read, pickHeavy(read.entry, lazy.heavy), false, meta.version));
    };
    for (const key of meta.keys ?? []) {
      // An entry listed without a file was deleted just before the app died: it stays deleted.
      if (!names.has(key)) continue;
      const item = meta.index?.[key];
      if (item) {
        record[key] = makeStub(split, key, item.e ?? {}, { summary: item.s, version: item.v ?? meta.version });
        split.files.set(key, null);
      } else readWhole(key); // From before the listing.
    }
    // Written just before the app died, ahead of the meta file that would have listed it.
    for (const key of names) if (!(key in record)) readWhole(key);
    split.version = meta.version;
    split.all = false;
    return { version: meta.version, state: { ...meta.state, [split.field]: record } };
  }
  if (split.legacy.exists) {
    split.all = true;
    return JSON.parse(split.legacy.textSync());
  }
  return null;
}

/** Whether `refs` differ from what's on disk only in a live last item of the tail field. */
function onlyTail(lazy: LazySplitOptions, refs: Record<string, unknown>, disk: OnDisk) {
  const tail = lazy.tail;
  if (!tail || !disk.stamp) return false;
  for (const field of lazy.heavy) if (field !== tail.field && refs[field] !== disk.refs[field]) return false;
  const list = refs[tail.field];
  const base = disk.refs[tail.field];
  if (!Array.isArray(list) || !Array.isArray(base) || !list.length) return false;
  const at = list.length - 1;
  if (at > base.length || !tail.live(list[at])) return false;
  for (let i = 0; i < at; i++) if (list[i] !== base[i]) return false;
  return true;
}

const listings = new WeakMap<object, Listing>();

function writeLazySplit(split: Split, value: StorageValue<unknown>) {
  const lazy = split.lazy!;
  const { [split.field]: record = {}, ...rest } = value.state as Record<string, unknown>;
  const entries = record as Record<string, object>;
  const all = split.all || value.version !== split.version;
  if (!split.dir.exists) split.dir.create({ intermediates: true });
  const keys = Object.keys(entries);
  const index: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = entries[key];
    const info = stubs.get(entry);
    if (info) {
      // Not loaded into this entry: its file stays exactly as it is; only its listing is written.
      if (all) info.item = undefined;
      index[key] = info.item ??= { e: listedFields(entry, lazy.heavySet), s: info.summary, v: info.version };
      continue;
    }
    const refs = pickHeavy(entry, lazy.heavy);
    const disk = split.files.get(key);
    if (all || !disk || lazy.heavy.some((f) => refs[f] !== disk.refs[f])) {
      if (!all && disk && onlyTail(lazy, refs, disk)) {
        const list = refs[lazy.tail!.field] as unknown[];
        if (split.tails.get(key) !== list) {
          const at = list.length - 1;
          tailFile(split, key).writeSync(JSON.stringify({ of: disk.stamp, at, item: list[at] }));
          split.tails.set(key, list);
        }
      } else if (split.unreadable.has(key) && !moveAside(split, key)) {
        // Its file couldn't be read nor moved: left as it is, and tried again on the next save.
      } else {
        const stamp = uid();
        entryFile(split, key).writeSync(JSON.stringify({ ...entry, $w: stamp, $v: value.version }));
        split.files.set(key, { refs, stamp, version: value.version });
        if (split.tails.has(key)) {
          const tail = tailFile(split, key);
          if (tail.exists) tail.delete();
          split.tails.delete(key);
        }
      }
    }
    const version = split.files.get(key)?.version;
    let item = listings.get(entry);
    if (!item || item.v !== version) listings.set(entry, (item = { e: listedFields(entry, lazy.heavySet), s: lazy.summarize(entry), v: version }));
    index[key] = item;
  }
  for (const key of [...split.files.keys()]) {
    if (key in entries) continue;
    const file = entryFile(split, key);
    if (file.exists) file.delete();
    const tail = tailFile(split, key);
    if (split.tails.has(key) && tail.exists) tail.delete();
    split.files.delete(key);
    split.tails.delete(key);
    split.loaded.delete(key);
    split.unreadable.delete(key);
  }
  // Written last, and only when what it says changed: while a reply streams, usually nothing has.
  const restJson = JSON.stringify(rest);
  const last = split.lastMeta;
  let same =
    !all &&
    !!last &&
    last.version === value.version &&
    last.rest === restJson &&
    last.keys.length === keys.length &&
    keys.every((key, i) => last.keys[i] === key);
  const listed = new Map<string, { item: unknown; json?: string }>();
  for (const key of keys) {
    const before = last?.index.get(key);
    const item = index[key];
    if (same && !before) same = false;
    if (same && before && before.item !== item) {
      // A new object, as for every save of a chat that changed: the same listing all the same?
      const json = JSON.stringify(item);
      before.json ??= JSON.stringify(before.item);
      if (json === before.json) {
        index[key] = before.item;
        listed.set(key, before);
        continue;
      }
      same = false;
      listed.set(key, { item, json });
      continue;
    }
    listed.set(key, before && before.item === item ? before : { item });
  }
  if (!same) split.meta.writeSync(JSON.stringify({ version: value.version, state: rest, keys, index }));
  split.lastMeta = { version: value.version, rest: restJson, keys, index: listed };
  split.version = value.version;
  if (split.all) {
    if (split.legacy.exists) split.legacy.delete();
    split.all = false;
  }
}

/** Pause periodic disk flushes while a scroll gesture or fling is active. */
export function setStorageWriteDeferred(deferred: boolean) {
  scrollDeferCount = Math.max(0, scrollDeferCount + (deferred ? 1 : -1));
}

/** Persist a rate-limit reservation or settled reply immediately. */
export function flushJsonStorage() {
  flush(true);
}

// The app may be killed once it leaves the foreground, so waiting writes go out then.
AppState.addEventListener('change', (state) => {
  if (state !== 'active') flush(true);
});

/**
 * Zustand storage backed by JSON files in the document directory. Writes are throttled, and the
 * state is only serialized when it's written: serializing the whole history on every streamed
 * token was what slowed the app most while a reply streamed.
 */
export const jsonFileStorage: PersistStorage<any> = {
  getItem: (name) => {
    const value = pending.get(name);
    // A copy, since rehydrating may change the state it's given.
    if (value) return JSON.parse(JSON.stringify(value));
    const file = fileFor(name);
    return file.exists ? JSON.parse(file.textSync()) : null;
  },
  setItem: (name, value) => {
    pending.set(name, value);
    timer ??= setTimeout(() => flush(false), WRITE_MS);
  },
  removeItem: (name) => {
    pending.delete(name);
    const file = fileFor(name);
    if (file.exists) file.delete();
  },
};

/**
 * Like jsonFileStorage, but `field` (a record, such as the chats by id) is kept as a file per
 * entry, and a write only rewrites the entries that changed. Reads the single file jsonFileStorage
 * wrote, and replaces it on the first write.
 *
 * With `lazy`, reading the store reads only the meta file's listing of the entries, and each
 * entry's file is read the first time something uses one of its heavy fields (see LazySplitOptions
 * and the stubs above). Files from before the listing are read whole, once, and listed from then on.
 */
export function splitJsonFileStorage(field: string, lazy?: LazySplitOptions): PersistStorage<any> {
  return {
    getItem: (name) => {
      const split = splitFor(name, field, lazy);
      const value = pending.get(name);
      if (value) {
        if (split.lazy) {
          // Copying the state would read every stub in it: save it, and read the listing back.
          flush(true);
          return readSplit(split);
        }
        return JSON.parse(JSON.stringify(value));
      }
      return readSplit(split);
    },
    setItem: (name, value) => {
      splitFor(name, field, lazy);
      pending.set(name, value);
      timer ??= setTimeout(() => flush(false), WRITE_MS);
    },
    removeItem: (name) => {
      const split = splitFor(name, field, lazy);
      pending.delete(name);
      if (split.dir.exists) split.dir.delete();
      if (split.meta.exists) split.meta.delete();
      if (split.legacy.exists) split.legacy.delete();
      split.written.clear();
      split.files.clear();
      split.tails.clear();
      split.loaded.clear();
      split.lastMeta = undefined;
      split.version = undefined;
      split.all = false;
    },
  };
}

// SecureStore keys may only contain alphanumerics, ".", "-" and "_".
const keyName = (endpointId: string) => `apikey_${endpointId}`;

export const apiKeys = {
  get: (endpointId: string) => SecureStore.getItemAsync(keyName(endpointId)),
  set: (endpointId: string, key: string) =>
    key ? SecureStore.setItemAsync(keyName(endpointId), key) : SecureStore.deleteItemAsync(keyName(endpointId)),
  remove: (endpointId: string) => SecureStore.deleteItemAsync(keyName(endpointId)),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
