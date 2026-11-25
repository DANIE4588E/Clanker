import type { File } from 'expo-file-system';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { jsonFileStorage } from '@/lib/storage';
import { downloadRelease, fetchNewerRelease, installApk, isNewer, type Release } from '@/lib/updates';

/** How often the automatic check asks GitHub: each time the app starts, or once a day. */
export type UpdateInterval = 'launch' | 'daily';

export type UpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** Checked, and this build is the latest. */
  | { phase: 'current' }
  | { phase: 'available'; release: Release }
  | { phase: 'downloading'; release: Release; progress: number }
  /** Downloaded; the installer was opened or is about to be. */
  | { phase: 'ready'; release: Release }
  | { phase: 'failed'; error: string; release?: Release };

interface UpdatesState {
  /** When GitHub was last asked, in ms; the launch check skips a day after it. */
  lastCheck: number;
  /** Whether the app asks GitHub on its own, as often as checkInterval says. */
  checkOnLaunch: boolean;
  checkInterval: UpdateInterval;
  /** A version the user chose not to hear about; only a newer one is offered on its own. */
  dismissedVersion: string | null;
  /** Whether pre-releases count as updates, not just stable releases. */
  prereleases: boolean;
  status: UpdatePhase;
  setCheckOnLaunch: (on: boolean) => void;
  setCheckInterval: (interval: UpdateInterval) => void;
  dismiss: (version: string) => void;
  /** Whether this release, or a newer one, was dismissed. */
  isDismissed: (release: Release) => boolean;
  setPrereleases: (on: boolean) => void;
  /** The newer release, or null. Throws when GitHub can't be reached. */
  check: () => Promise<Release | null>;
  /** Downloads the release, then opens the installer. */
  download: (release: Release) => Promise<void>;
  cancelDownload: () => void;
  /** Opens the installer again for the downloaded release. */
  install: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Outside the store: neither belongs in the persisted state.
let downloaded: File | null = null;
let controller: AbortController | null = null;

export const useUpdates = create<UpdatesState>()(
  persist(
    (set, get) => ({
      lastCheck: 0,
      checkOnLaunch: true,
      checkInterval: 'launch',
      dismissedVersion: null,
      prereleases: false,
      status: { phase: 'idle' },
      setCheckOnLaunch: (checkOnLaunch) => set({ checkOnLaunch }),
      setCheckInterval: (checkInterval) => set({ checkInterval }),
      dismiss: (dismissedVersion) => set({ dismissedVersion }),
      isDismissed: (release) => {
        const dismissed = get().dismissedVersion;
        return !!dismissed && !isNewer(release.version, dismissed);
      },
      setPrereleases: (prereleases) => {
        const { phase } = get().status;
        // What the last check found may no longer apply; a download under way carries on.
        const stale = phase === 'current' || phase === 'available' || phase === 'failed';
        // Due a fresh look at launch too, rather than waiting out the day.
        set({ prereleases, lastCheck: 0, ...(stale && { status: { phase: 'idle' } }) });
      },
      check: async () => {
        set({ status: { phase: 'checking' } });
        try {
          const release = await fetchNewerRelease(get().prereleases);
          set({ lastCheck: Date.now(), status: release ? { phase: 'available', release } : { phase: 'current' } });
          return release;
        } catch (e) {
          set({ status: { phase: 'failed', error: message(e) } });
          throw e;
        }
      },
      download: async (release) => {
        if (get().status.phase === 'downloading') return;
        controller = new AbortController();
        const signal = controller.signal;
        set({ status: { phase: 'downloading', release, progress: 0 } });
        try {
          downloaded = await downloadRelease(
            release,
            (fraction) => {
              const progress = Math.floor(fraction * 100) / 100;
              const s = get().status;
              // Whole percents, so the Settings row re-renders at most a hundred times.
              if (s.phase === 'downloading' && s.progress !== progress) set({ status: { ...s, progress } });
            },
            signal
          );
        } catch (e) {
          set({ status: signal.aborted ? { phase: 'available', release } : { phase: 'failed', error: message(e), release } });
          return;
        } finally {
          controller = null;
        }
        set({ status: { phase: 'ready', release } });
        await get().install();
      },
      cancelDownload: () => controller?.abort(),
      install: async () => {
        const s = get().status;
        if (s.phase !== 'ready' || !downloaded) return;
        try {
          await installApk(downloaded);
        } catch (e) {
          set({ status: { phase: 'failed', error: message(e), release: s.release } });
        }
      },
    }),
    {
      name: 'updates',
      storage: jsonFileStorage,
      partialize: (s) => ({
        lastCheck: s.lastCheck,
        checkOnLaunch: s.checkOnLaunch,
        checkInterval: s.checkInterval,
        dismissedVersion: s.dismissedVersion,
        prereleases: s.prereleases,
      }),
    }
  )
);
