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
  for (const [name, value] of pending) fileFor(name).write(JSON.stringify(value));
  pending.clear();
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
