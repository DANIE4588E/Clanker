import { workspaceFilesVersion, type Workspace } from './workspace';

// A run of characters that can be in a file name in prose, ending in an extension. Spaces end it,
// so names with spaces are only found in code spans and links, where the whole text is the name.
const NAME = String.raw`[^\s/\\()[\]{}<>"'\x60*,;:!?|]`;
const MENTION = new RegExp(String.raw`(?:${NAME}+/)*${NAME}*\.[A-Za-z0-9]{1,10}`, 'g');
const LOOKS_LIKE_FILE = /\.[A-Za-z0-9]{1,10}$/;
const WALK_LIMIT = 5000;

/**
 * What a workspace was found to hold, shared by every reply on screen: each block of a reply used
 * to look its names up (and list the whole workspace for bare names) for itself. Dropped when tools
 * or uploads change files (see workspaceFilesChanged), and after a while for changes made elsewhere.
 */
type Index = {
  version: number;
  at: number;
  /** Whether a workspace path is a file. */
  exists: Map<string, boolean>;
  /** The newest file of each name, lowercased; null until a bare name needs it. */
  byName: Map<string, string> | null;
  /** Whether byName lists every file (the listing stops at WALK_LIMIT). */
  complete: boolean;
};

const INDEX_TTL = 10_000;
const indexes = new Map<string, Index>();

function indexOf(ws: Workspace): Index {
  const version = workspaceFilesVersion();
  const now = Date.now();
  let index = indexes.get(ws.key);
  if (!index || index.version !== version || now - index.at > INDEX_TTL) {
    index = { version, at: now, exists: new Map(), byName: null, complete: false };
    indexes.set(ws.key, index);
  }
  return index;
}

/**
 * Finds the workspace files a reply names, by path or by bare file name, so they can be tapped
 * open. Lookups are cached for the life of the object, which spans one rendering of a reply.
 */
export class FileMentions {
  private found = new Map<string, string | null>();

  constructor(readonly ws: Workspace) {}

  /** The workspace path `text` names, or null. */
  resolve(text: string): string | null {
    let name = text.trim();
    try {
      name = decodeURI(name);
    } catch {
      // Not percent-encoded after all.
    }
    // Web links and other schemes aren't workspace files; file:// paths may be.
    if (!LOOKS_LIKE_FILE.test(name) || name.length > 300 || (/^[a-z][\w+.-]*:/i.test(name) && !name.startsWith('file:'))) return null;
    const hit = this.found.get(name);
    if (hit !== undefined) return hit;
    let path: string | null = null;
    try {
      const rel = this.ws.normalizePath(name);
      if (rel && this.isFile(rel)) path = rel;
      else if (!rel.includes('/')) path = this.names().get(rel.toLowerCase()) ?? null;
    } catch {
      // Paths outside the workspace and unreadable folders just aren't links.
    }
    this.found.set(name, path);
    return path;
  }

  /** Splits prose into text and the file mentions in it. */
  split(text: string): (string | { text: string; path: string })[] {
    const out: (string | { text: string; path: string })[] = [];
    let last = 0;
    for (const m of text.matchAll(MENTION)) {
      const start = m.index ?? 0;
      // Part of a URL or a longer path that didn't resolve.
      if (start > 0 && /[/:\w]/.test(text[start - 1])) continue;
      const path = this.resolve(m[0]);
      if (!path) continue;
      if (start > last) out.push(text.slice(last, start));
      out.push({ text: m[0], path });
      last = start + m[0].length;
    }
    if (!out.length) return [text];
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  /** Whether the workspace path `rel` is a file, asking the file system once per path. */
  private isFile(rel: string) {
    const index = indexOf(this.ws);
    const known = index.exists.get(rel);
    if (known !== undefined) return known;
    // Prose is full of things shaped like file names ("e.g.", "Node.js", "3.14"). Once the
    // workspace has been listed in full, a name no file there has can't be one; names outside
    // ASCII are asked about anyway, as file systems may compare them differently.
    const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
    let exists: boolean;
    if (index.byName && index.complete && /^[\x20-\x7e]*$/.test(base) && !index.byName.has(base)) exists = false;
    else exists = this.ws.fileAt(rel).exists;
    index.exists.set(rel, exists);
    return exists;
  }

  // The model often names a file without its folder; the newest file of that name wins.
  private names() {
    const index = indexOf(this.ws);
    if (!index.byName) {
      const byName = new Map<string, string>();
      const files = this.ws.walk('', WALK_LIMIT).sort((a, b) => a.modified - b.modified);
      for (const f of files) byName.set(f.path.split('/').pop()!.toLowerCase(), f.path);
      index.byName = byName;
      index.complete = files.length < WALK_LIMIT;
    }
    return index.byName;
  }
}
