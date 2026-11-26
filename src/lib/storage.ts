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
    if (split) writeSplit(split, value);
    else fileFor(name).write(JSON.stringify(value));
  }
  pending.clear();
}

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
  /** Each entry as last written or read. State is replaced, not changed, so another object has changed since. */
  written: Map<string, unknown>;
  /** The version on disk; a different one means migrating, which may have changed entries in place. */
  version: number | undefined;
  /** Everything needs writing, as when what's on disk is still the single file. */
  all: boolean;
};

const splits = new Map<string, Split>();

const entryFile = (split: Split, key: string) => new File(split.dir, `${encodeURIComponent(key)}.json`);

function splitFor(name: string, field: string) {
  let split = splits.get(name);
  if (!split) {
    split = {
      field,
      dir: new Directory(dataDir, name),
      meta: fileFor(`${name}.meta`),
      legacy: fileFor(name),
      written: new Map(),
      version: undefined,
      all: false,
    };
    splits.set(name, split);
  }
  return split;
}

function readSplit(split: Split): StorageValue<unknown> | null {
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
    entryFile(split, key).write(JSON.stringify(entry));
    split.written.set(key, entry);
  }
  for (const key of [...split.written.keys()]) {
    if (key in entries) continue;
    const file = entryFile(split, key);
    if (file.exists) file.delete();
    split.written.delete(key);
  }
  split.meta.write(JSON.stringify({ version: value.version, state: rest, keys: Object.keys(entries) }));
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
 */
export function splitJsonFileStorage(field: string): PersistStorage<any> {
  return {
    getItem: (name) => {
      const split = splitFor(name, field);
      const value = pending.get(name);
      if (value) return JSON.parse(JSON.stringify(value));
      return readSplit(split);
    },
    setItem: (name, value) => {
      splitFor(name, field);
      pending.set(name, value);
      timer ??= setTimeout(() => flush(false), WRITE_MS);
    },
    removeItem: (name) => {
      const split = splitFor(name, field);
      pending.delete(name);
      if (split.dir.exists) split.dir.delete();
      if (split.meta.exists) split.meta.delete();
      if (split.legacy.exists) split.legacy.delete();
      split.written.clear();
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
