import { Directory, File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { Conversation } from '@/store/chats';
import { useLibrary } from '@/store/library';
import { attachmentUri, duplicateAttachment, importFile } from './attachments';
import { chatUploads, shareFile, uploadFile, type Upload } from './chatExport';
import { workspaceKeyOf } from './projects';
import type { AttachmentPart, ContentPart } from './providers';
import { Workspace } from './workspace';

export type LibraryKind = 'image' | 'pdf' | 'document' | 'sheet' | 'slides' | 'site' | 'code' | 'text' | 'media' | 'archive' | 'other';

/**
 * A file in the Library: one the user attached to a message, or one an agent made for them.
 * `key` stays the same across visits: "u:<chat>:<message>:<part>" for uploads, and
 * "f:<workspace>:<path>" for agent files, which chats in a project share.
 */
export type LibraryItem = {
  key: string;
  /** The name it is shown, shared and saved under. */
  name: string;
  kind: LibraryKind;
  source: 'upload' | 'agent';
  /** The chat it came from: for an agent file, the one that last handed it over. */
  chatId: string;
  chatTitle: string;
  projectId?: string;
  at: number;
  size?: number;
  upload?: Upload;
  workspace?: string;
  path?: string;
};

const KINDS: [RegExp, LibraryKind][] = [
  [/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
  [/\.(docx?|docm|dotx|odt|rtf|pages|epub)$/i, 'document'],
  [/\.(xlsx?|xlsm|xltx|ods|numbers|csv|tsv)$/i, 'sheet'],
  [/\.(pptx?|pptm|potx|odp|key)$/i, 'slides'],
  [/\.html?$/i, 'site'],
  [/\.(md|markdown|txt|log|rst|tex)$/i, 'text'],
  [/\.(mp4|mov|webm|mkv|avi|m4v|mp3|wav|ogg|m4a|flac|aac|opus)$/i, 'media'],
  [/\.(zip|gz|tgz|7z|rar|tar|bz2|xz)$/i, 'archive'],
  [
    /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|cxx|java|kt|kts|swift|scala|sh|bash|zsh|ps1|bat|sql|css|scss|less|json|jsonl|ya?ml|xml|toml|ini|cfg|conf|lua|pl|php|dart|vue|svelte|r|ipynb)$/i,
    'code',
  ],
];

export const kindOf = (name: string): LibraryKind => KINDS.find(([re]) => re.test(name))?.[1] ?? 'other';

export const KIND_LABEL: Record<LibraryKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  document: 'Document',
  sheet: 'Spreadsheet',
  slides: 'Slides',
  site: 'Website',
  code: 'Code',
  text: 'Text',
  media: 'Media',
  archive: 'Archive',
  other: 'File',
};

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

const pad = (n: number) => String(n).padStart(2, '0');

/** Photos are stored under random names; they get a camera-style one instead. */
function photoName(at: number) {
  const d = new Date(at);
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

/**
 * Every file in the Library, newest first: what the user attached in any chat, and what agents
 * handed over in replies and is still in their workspace. Remote chats' files live on the remote
 * machine, so only their uploads are listed. Deleted and favorite state is applied by the caller.
 */
export function libraryItems(conversations: Record<string, Conversation>): LibraryItem[] {
  const items = new Map<string, LibraryItem>();
  for (const c of Object.values(conversations)) {
    const from = { chatId: c.id, chatTitle: c.title, projectId: c.projectId };
    for (const u of chatUploads(c)) {
      const key = `u:${c.id}:${u.key}`;
      const image = u.part.type === 'image';
      const name = image ? photoName(u.at) : u.name;
      const size = u.part.type === 'file' ? (u.part.size ?? u.part.text?.length) : undefined;
      items.set(key, { key, name, kind: image ? 'image' : kindOf(name), source: 'upload', ...from, at: u.at, size, upload: u });
    }
    if (c.backendId && c.backendId !== 'local') continue;
    const workspace = workspaceKeyOf(c);
    for (const m of c.messages) {
      if (m.role !== 'assistant' || m.status === 'streaming') continue;
      for (const path of deliverablesOf(m.content)) {
        const key = `f:${workspace}:${path}`;
        const prev = items.get(key);
        if (prev && prev.at > m.createdAt) continue;
        const name = path.split('/').pop() ?? path;
        items.set(key, { key, name, kind: kindOf(name), source: 'agent', ...from, at: m.createdAt, workspace, path });
      }
    }
  }

  const out: LibraryItem[] = [];
  const workspaces = new Map<string, Workspace>();
  for (const item of items.values()) {
    if (item.source === 'agent') {
      try {
        let ws = workspaces.get(item.workspace!);
        if (!ws) workspaces.set(item.workspace!, (ws = new Workspace(item.workspace!)));
        const file = ws.fileAt(item.path!);
        // Deleted or moved away since.
        if (!file.exists) continue;
        item.size = file.size;
        item.at = file.modificationTime || item.at;
      } catch {
        continue;
      }
    } else {
      // Uploads whose stored copy is gone can still be opened when their text was inlined.
      const part = item.upload!.part;
      const stored = !!part.file && new File(attachmentUri(part.file)).exists;
      if (!stored && !(part.type === 'file' && part.text != null)) continue;
    }
    out.push(item);
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * An agent's workspace file by Library key, whether or not the Library lists it (a page a reply
 * touched but didn't hand over, say), for the full-screen preview.
 */
export function workspaceItem(key: string, conversations: Record<string, Conversation>): LibraryItem | undefined {
  const match = key.match(/^f:((?:chat|project):[^:]+|shared):(.+)$/);
  if (!match) return undefined;
  const [, workspace, path] = match;
  try {
    const file = new Workspace(workspace).fileAt(path);
    if (!file.exists) return undefined;
    const chat = Object.values(conversations).find((c) => workspaceKeyOf(c) === workspace);
    const name = path.split('/').pop() ?? path;
    return {
      key,
      name,
      kind: kindOf(name),
      source: 'agent',
      chatId: chat?.id ?? '',
      chatTitle: chat?.title ?? '',
      projectId: chat?.projectId,
      at: file.modificationTime ?? 0,
      size: file.size,
      workspace,
      path,
    };
  } catch {
    return undefined;
  }
}

/** Where the item's bytes are, for thumbnails and previews; undefined when they aren't on disk. */
export function itemUri(item: LibraryItem): string | undefined {
  try {
    if (item.upload) return item.upload.part.file ? attachmentUri(item.upload.part.file) : undefined;
    return new Workspace(item.workspace!).fileAt(item.path!).uri;
  } catch {
    return undefined;
  }
}

/** The folder relative files of an agent's page resolve against, so a game's scripts load. */
export function itemFolderUri(item: LibraryItem): string | undefined {
  return item.workspace ? new Workspace(item.workspace).dir.uri : undefined;
}

/** The item as a file on disk, named as the user knows it (uploads are stored under random names). */
export function itemFile(item: LibraryItem): File {
  if (item.upload) {
    const stored = uploadFile(item.upload);
    if (stored.name === item.name) return stored;
    const copy = shareFile(item.name);
    stored.copySync(copy);
    return copy;
  }
  const file = new Workspace(item.workspace!).fileAt(item.path!);
  if (!file.exists) throw new Error(`"${item.name}" is no longer on this device.`);
  return file;
}

const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

export function mimeOf(item: LibraryItem, file?: File) {
  if (item.upload?.part.mimeType) return item.upload.part.mimeType;
  if (file?.type) return file.type;
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (item.kind === 'image') return IMAGE_MIME[ext] ?? `image/${ext}`;
  if (item.kind === 'pdf') return 'application/pdf';
  if (item.kind === 'site') return 'text/html';
  return undefined;
}

/** Shows the share sheet for the item. */
export async function shareItem(item: LibraryItem) {
  const file = itemFile(item);
  await Sharing.shareAsync(file.uri, { mimeType: mimeOf(item, file), dialogTitle: item.name });
}

/**
 * Saves a copy outside the app: into a folder the user picks on Android, and through the share
 * sheet's "Save to Files" on iOS. False when the user backed out.
 */
export async function saveItem(item: LibraryItem): Promise<boolean> {
  const file = itemFile(item);
  if (Platform.OS !== 'android') {
    await Sharing.shareAsync(file.uri, { mimeType: mimeOf(item, file), dialogTitle: item.name });
    return true;
  }
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch (e) {
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
  const target = dir.createFile(item.name, mimeOf(item, file) ?? 'application/octet-stream');
  await target.write(await file.bytes());
  return true;
}

/** Opens the item in the system's previewer, or the share sheet when nothing can preview it. */
export async function openItemExternally(item: LibraryItem) {
  const file = itemFile(item);
  const mimeType = mimeOf(item, file);
  try {
    if (await file.canPreview({ mimeType })) return await file.preview({ title: item.name, mimeType });
  } catch {
    // No previewer for the type (on Android, say); sharing still lets the user pick an app.
  }
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: item.name });
}

/** A new attachment of the item, for a message in another chat. Each message owns its copy. */
export async function attachmentFor(item: LibraryItem): Promise<AttachmentPart> {
  const part = item.upload?.part;
  if (part) {
    // The copy in the old chat's workspace isn't the new chat's; it gets its own when sent.
    const { path: _, ...rest } = part;
    if (rest.type === 'image') return { ...rest, file: duplicateAttachment(rest.file) };
    return rest.file ? { ...rest, file: duplicateAttachment(rest.file) } : rest;
  }
  const file = itemFile(item);
  return importFile({ uri: file.uri, name: item.name, mimeType: mimeOf(item, file), size: file.size });
}

/**
 * Removes items for good: an agent's file is deleted from its workspace (and so from its chat),
 * while an upload stays in the message it was sent with and only leaves the Library.
 */
export function purgeItems(items: LibraryItem[]) {
  for (const item of items) {
    if (item.source !== 'agent') continue;
    try {
      const file = new Workspace(item.workspace!).fileAt(item.path!);
      if (file.exists) file.delete();
    } catch {
      // Already gone.
    }
  }
  useLibrary.getState().purge(items.map((i) => i.key));
}
