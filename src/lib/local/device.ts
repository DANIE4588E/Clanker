import * as Device from 'expo-device';
import { Paths } from 'expo-file-system';

/** What this phone can hold and run: its RAM and free storage. */

/** Room left on disk after a download, so the phone isn't filled to the last byte. */
export const STORAGE_MARGIN = 512 * 1024 * 1024;

export function totalRam(): number | null {
  return Device.totalMemory ?? null;
}

export function freeStorage(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

export function formatBytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * How a model of this size sits in the phone's memory. The weights load whole, and the system
 * and other apps keep a good share of RAM, so past about 60% it may be slow or get killed.
 */
export type Fit = 'ok' | 'tight' | 'over' | 'unknown';

export function fitOf(bytes: number, ram = totalRam()): Fit {
  if (!ram) return 'unknown';
  if (bytes > ram) return 'over';
  if (bytes > ram * 0.6) return 'tight';
  return 'ok';
}

export function fitMessage(fit: Fit, ram = totalRam()) {
  const amount = ram ? formatBytes(ram) : 'its';
  switch (fit) {
    case 'over':
      return `Larger than this phone's ${amount} of RAM. It will likely fail to load, or crash the app.`;
    case 'tight':
      return `Uses most of this phone's ${amount} of RAM. It may run slowly, or be closed by the system.`;
    default:
      return undefined;
  }
}
