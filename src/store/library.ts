import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { jsonFileStorage } from '@/lib/storage';

export type LibraryView = 'grid' | 'list';

/** What the Library remembers about its files, by item key (see lib/library). */
interface LibraryState {
  /** Favorited items, with when. */
  favorites: Record<string, number>;
  /** Items deleted from the Library, with when: listed under Deleted until restored or removed for good. */
  deleted: Record<string, number>;
  /** Items removed for good, never listed again. */
  purged: Record<string, true>;
  view: LibraryView;
  setFavorite: (keys: string[], on: boolean) => void;
  remove: (keys: string[]) => void;
  restore: (keys: string[]) => void;
  purge: (keys: string[]) => void;
  setView: (view: LibraryView) => void;
}

const without = <T,>(record: Record<string, T>, keys: string[]) => {
  const next = { ...record };
  for (const k of keys) delete next[k];
  return next;
};

export const useLibrary = create<LibraryState>()(
  persist(
    (set) => ({
      favorites: {},
      deleted: {},
      purged: {},
      view: 'grid',
      setFavorite: (keys, on) =>
        set((s) => {
          if (!on) return { favorites: without(s.favorites, keys) };
          const now = Date.now();
          return { favorites: { ...s.favorites, ...Object.fromEntries(keys.map((k) => [k, s.favorites[k] ?? now])) } };
        }),
      remove: (keys) =>
        set((s) => {
          const now = Date.now();
          return { deleted: { ...s.deleted, ...Object.fromEntries(keys.map((k) => [k, now])) } };
        }),
      restore: (keys) => set((s) => ({ deleted: without(s.deleted, keys) })),
      purge: (keys) =>
        set((s) => ({
          deleted: without(s.deleted, keys),
          favorites: without(s.favorites, keys),
          purged: { ...s.purged, ...Object.fromEntries(keys.map((k) => [k, true as const])) },
        })),
      setView: (view) => set({ view }),
    }),
    {
      name: 'library',
      storage: jsonFileStorage,
      partialize: ({ favorites, deleted, purged, view }) => ({ favorites, deleted, purged, view }),
    }
  )
);
