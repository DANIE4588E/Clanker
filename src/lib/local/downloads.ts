import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import { guessEfforts } from '@/lib/providers/effort';
import { useLocalModels, type Download, type DownloadFile, type LocalModel } from '@/store/localModels';
import { formatBytes, freeStorage, STORAGE_MARGIN } from './device';
import { fileUrl, hfHeaders, type Quant, type RepoInfo } from './hf';
import { inspectModel, releaseModel } from './runtime';

/** Downloads GGUF files from Hugging Face into the app's storage, one file at a time per model. */

export const modelsDir = () => new Directory(Paths.document, 'models');

export const modelDir = (dir: string) => new Directory(modelsDir(), dir);

export const basename = (path: string) => path.split('/').pop() ?? path;

/** Where a downloaded model's file lives, as llama.cpp wants it (a plain path). */
export function modelPath(model: Pick<LocalModel, 'dir'>, file: string) {
  return new File(modelDir(model.dir), file).uri;
}

/** Model id the chats use: owner, repo name without "GGUF", and the quantization. */
export function modelIdFor(repo: string, quant: string) {
  const [owner, name = owner] = repo.split('/');
  const base = name.replace(/[-_.]?gguf$/i, '');
  return `${owner}/${base}-${quant}`;
}

const safeDir = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Hybrid models whose templates switch thinking, read from the template itself where we have it. */
function effortsFor(id: string, repo: RepoInfo) {
  const tmpl = repo.chatTemplate ?? '';
  if (/reasoning_effort/.test(tmpl)) return ['low', 'medium', 'high'];
  if (/enable_thinking/.test(tmpl)) return ['off', 'on'];
  return guessEfforts('openai', `${repo.id} ${id}`, 'chat_template_kwargs');
}

/** Bytes still to come for downloads already running or paused. */
function pendingBytes(except?: string) {
  return Object.values(useLocalModels.getState().downloads)
    .filter((d) => d.id !== except)
    .reduce((n, d) => n + Math.max(0, d.total - d.received), 0);
}

/** Whether the phone has room for `bytes` more, after what other downloads still need. */
export function storageCheck(bytes: number, except?: string) {
  const free = freeStorage();
  const need = bytes + pendingBytes(except) + STORAGE_MARGIN;
  return { ok: free == null || free >= need, free, need };
}

export function storageMessage(free: number | null, need: number) {
  return `This needs ${formatBytes(need)} free, including what other downloads still need and some room to spare, but only ${formatBytes(free ?? 0)} is available.`;
}

type Live = { task?: DownloadTask; cancelled?: boolean; pausing?: boolean };
const live = new Map<string, Live>();

export const isLive = (id: string) => live.has(id);

export function startDownload(repo: RepoInfo, quant: Quant, withProjector: boolean): string {
  const id = modelIdFor(repo.id, quant.label);
  const store = useLocalModels.getState();
  if (store.downloads[id] || store.models.some((m) => m.id === id)) return id;
  const files: DownloadFile[] = quant.files.map((f) => ({ path: f.path, size: f.size, done: false }));
  const mmproj = withProjector ? repo.mmproj : undefined;
  if (mmproj) files.push({ path: mmproj.path, size: mmproj.size, done: false });
  const download: Download = {
    id,
    repo: repo.id,
    quant: quant.label,
    dir: safeDir(id),
    files,
    mmproj: mmproj?.path,
    total: files.reduce((n, f) => n + f.size, 0),
    received: 0,
    status: 'downloading',
    meta: { contextLength: repo.contextLength, params: repo.params, efforts: effortsFor(id, repo) },
    startedAt: Date.now(),
  };
  store.setDownload(download);
  void run(id);
  return id;
}

export function resumeDownload(id: string) {
  const d = useLocalModels.getState().downloads[id];
  if (!d || live.has(id)) return;
  const remaining = d.files.filter((f) => !f.done).reduce((n, f) => n + f.size, 0);
  const check = storageCheck(remaining, id);
  if (!check.ok) {
    useLocalModels.getState().patchDownload(id, { status: 'error', error: storageMessage(check.free, check.need) });
    return;
  }
  useLocalModels.getState().patchDownload(id, { status: 'downloading', error: undefined });
  void run(id);
}

export function pauseDownload(id: string) {
  const entry = live.get(id);
  if (!entry) return;
  entry.pausing = true;
  // Without a task running (between files), the loop sees the flag before the next file.
  if (entry.task?.state === 'active') entry.task.pause();
}

/** Stops a download and deletes what it fetched so far. */
export function cancelDownload(id: string) {
  const entry = live.get(id);
  const d = useLocalModels.getState().downloads[id];
  if (entry) {
    entry.cancelled = true;
    entry.task?.cancel();
  }
  useLocalModels.getState().removeDownload(id);
  if (d && !entry) removeDir(d.dir);
}

export async function deleteModel(id: string) {
  const model = useLocalModels.getState().models.find((m) => m.id === id);
  if (!model) return;
  await releaseModel(id);
  useLocalModels.getState().removeModel(id);
  removeDir(model.dir);
}

function removeDir(dir: string) {
  try {
    const d = modelDir(dir);
    if (d.exists) d.delete();
  } catch {
    // Left behind; the next download into the same folder clears it.
  }
}

const PROGRESS_MS = 400;

const REFUSED =
  'Hugging Face refused the download. If the repo is gated, accept its terms on huggingface.co and add your access token in On-device settings.';

async function run(id: string) {
  const entry: Live = {};
  live.set(id, entry);
  const get = () => useLocalModels.getState().downloads[id];
  const patch = (p: Partial<Download>) => useLocalModels.getState().patchDownload(id, p);
  try {
    const start = get();
    if (!start) return;
    const dir = modelDir(start.dir);
    if (!dir.exists) dir.create({ intermediates: true });
    const headers = await hfHeaders();

    for (const file of start.files) {
      if (get()?.files.find((f) => f.path === file.path)?.done) continue;
      // Pressed between two files, while no task was running.
      if (entry.cancelled) return;
      if (entry.pausing) {
        patch({ status: 'paused' });
        return;
      }
      const name = basename(file.path);
      const part = new File(dir, `${name}.part`);
      const doneBytes = () => (get()?.files ?? []).filter((f) => f.done).reduce((n, f) => n + f.size, 0);
      let last = 0;
      const onProgress = ({ bytesWritten }: { bytesWritten: number }) => {
        const now = Date.now();
        if (now - last < PROGRESS_MS) return;
        last = now;
        patch({ received: doneBytes() + bytesWritten });
      };

      const current = get();
      let task: DownloadTask;
      let result: File | null;
      if (current?.pause && current.pausedPath === file.path) {
        task = DownloadTask.fromSavable(current.pause, { headers, onProgress });
        entry.task = task;
        patch({ pause: undefined, pausedPath: undefined });
        result = await task.resumeAsync();
      } else {
        if (part.exists) part.delete();
        task = new DownloadTask(fileUrl(start.repo, file.path), part, { headers, onProgress });
        entry.task = task;
        result = await task.downloadAsync();
      }

      if (entry.cancelled) return;
      if (result === null) {
        // Paused: keep the resume data so it can continue, even after the app restarts.
        patch({ status: 'paused', pause: task.savable(), pausedPath: file.path });
        return;
      }

      const got = new File(part.uri);
      if (file.size && got.size !== file.size) {
        // A tiny file is the error page the Hub sent back instead.
        if (got.size < 64 * 1024) throw new Error(REFUSED);
        throw new Error(`${name} came out ${formatBytes(got.size)} instead of ${formatBytes(file.size)}. Try again.`);
      }
      const final = new File(dir, name);
      if (final.exists) final.delete();
      got.rename(name);
      const files = (get()?.files ?? []).map((f) => (f.path === file.path ? { ...f, done: true } : f));
      patch({ files, received: files.filter((f) => f.done).reduce((n, f) => n + f.size, 0) });
    }

    const d = get();
    if (!d) return;
    const shards = d.files.filter((f) => f.path !== d.mmproj);
    const model: LocalModel = {
      id: d.id,
      repo: d.repo,
      quant: d.quant,
      dir: d.dir,
      file: basename(shards[0].path),
      ...(d.mmproj ? { mmproj: basename(d.mmproj) } : {}),
      size: d.total,
      ...d.meta,
      addedAt: Date.now(),
    };
    useLocalModels.getState().addModel(model);
    useLocalModels.getState().removeDownload(id);
    // For the memory estimate on its settings screen.
    void inspectModel(model);
  } catch (e) {
    if (entry.cancelled) return;
    const message = e instanceof Error ? e.message : String(e);
    const error = /(401|403)/.test(message) ? REFUSED : /abort|cancel/i.test(message) ? 'Download stopped.' : message;
    patch({ status: 'error', error });
  } finally {
    live.delete(id);
    if (entry.cancelled) {
      const d = useLocalModels.getState().downloads[id];
      removeDir(d?.dir ?? safeDir(id));
    }
  }
}
