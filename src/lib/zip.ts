import { unzipSync, type UnzipFileFilter, type Unzipped } from 'fflate';

/** Thrown when an archive is past one of unzipBounded's limits (as a zip bomb would be). */
export class ZipLimitError extends Error {}

export const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;

/**
 * unzipSync with caps on how much it inflates. The sizes checked are the ones the archive's
 * directory declares, which bound the real output too: fflate inflates each entry into a buffer of
 * exactly its declared size, so an entry can't expand past what was counted here.
 */
export function unzipBounded(
  bytes: Uint8Array,
  { maxBytes = MAX_UNZIPPED_BYTES, maxEntries = MAX_ZIP_ENTRIES, filter }: { maxBytes?: number; maxEntries?: number; filter?: UnzipFileFilter } = {}
): Unzipped {
  let entries = 0;
  let total = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      if (++entries > maxEntries) throw new ZipLimitError(`The archive holds more than ${maxEntries} files.`);
      if (filter && !filter(file)) return false;
      total += file.originalSize;
      if (total > maxBytes) {
        throw new ZipLimitError(`The archive expands to more than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      }
      return true;
    },
  });
}
