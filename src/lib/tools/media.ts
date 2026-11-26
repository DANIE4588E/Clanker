import { PluginApiError, pluginFetch, pluginJson } from '../plugins/auth';
import { formatSize } from '../workspace';
import type { Tool } from './index';
import { clip, field, int, list, MAX_TRANSFER_BYTES, opt, readUpload, saveDownload, short, shortDate, str, strings, type ToolLabels } from './pluginUtil';

/**
 * Tools for the Dropbox, Spotify and Weather plugins. Dropbox and Spotify act on the user's real
 * files, library and players through their APIs; Weather uses Open-Meteo, which needs no account.
 */

const DBX_API = 'https://api.dropboxapi.com/2';
const DBX_CONTENT = 'https://content.dropboxapi.com/2';
const SPOTIFY = 'https://api.spotify.com/v1';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

// ---- Dropbox ---------------------------------------------------------------------------------

type DbxMeta = {
  '.tag': 'file' | 'folder' | 'deleted';
  name: string;
  id?: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
  is_downloadable?: boolean;
  export_info?: { export_as?: string };
};

/** A Dropbox error (HTTP 409) with its machine-readable summary, like "path/not_found/..". */
class DropboxError extends Error {
  constructor(
    message: string,
    readonly summary: string,
    readonly body: string
  ) {
    super(message);
  }
}

/** Turns Dropbox's endpoint-specific 409 errors into messages the model can act on. */
function dropboxError(e: unknown, target?: string): unknown {
  if (!(e instanceof PluginApiError) || e.status !== 409) return e;
  let summary = '';
  try {
    summary = String(JSON.parse(e.body).error_summary ?? '');
  } catch {}
  const at = target ? ` at ${target}` : '';
  let message: string;
  if (/not_found/.test(summary)) message = `Nothing found${at} in Dropbox. Check the path with dropbox_search.`;
  else if (/conflict/.test(summary)) message = `Something already exists${at} in Dropbox. Choose another path.`;
  else if (/malformed_path/.test(summary)) message = `"${target ?? ''}" isn't a valid Dropbox path. Paths start with /, like /Documents/report.pdf.`;
  else if (/insufficient_space/.test(summary)) message = 'The Dropbox account is out of space.';
  else if (/no_write_permission/.test(summary)) message = `No permission to write${at}.`;
  else if (/shared_link_is_directory/.test(summary)) message = 'That shared link is a folder; only shared links to files can be downloaded.';
  else if (/shared_link_access_denied|shared_link_not_found/.test(summary)) message = 'The shared link is invalid, expired, or not accessible to this account.';
  else if (/too_many_write_operations/.test(summary)) message = 'Dropbox is busy with other writes to this account; try again in a moment.';
  else message = `Dropbox refused: ${summary || e.message}`;
  return new DropboxError(`${message}${summary ? ` (${summary.replace(/\/\.+$/, '')})` : ''}`, summary, e.body);
}

/** JSON for the Dropbox-API-Arg header, which must be ASCII: other characters become \uXXXX escapes. */
const headerJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const argTarget = (arg: Record<string, unknown>) => (typeof arg.path === 'string' ? arg.path : typeof arg.to_path === 'string' ? arg.to_path : undefined);

/** A Dropbox RPC call (JSON in, JSON out). */
async function dbx<T = any>(route: string, arg: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  try {
    return await pluginJson<T>('dropbox', `${DBX_API}/${route}`, { method: 'POST', json: arg, signal });
  } catch (e) {
    throw dropboxError(e, argTarget(arg));
  }
}

/** A Dropbox content call: the argument goes in the Dropbox-API-Arg header, bytes in the body or response. */
async function dbxContent(route: string, arg: Record<string, unknown>, signal: AbortSignal, body?: Uint8Array<ArrayBuffer>) {
  try {
    return await pluginFetch('dropbox', `${DBX_CONTENT}/${route}`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': headerJson(arg), Accept: '*/*', ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
      ...(body ? { body } : {}),
      signal,
    });
  } catch (e) {
    throw dropboxError(e, argTarget(arg));
  }
}

const isSharedLink = (s: string) => /^(?:https?:\/\/)?(?:www\.)?dropbox\.com\/(?:s|sh|scl|l)\//i.test(s) || /^(?:https?:\/\/)?dl\.dropbox(?:usercontent)?\.com\//i.test(s);

/**
 * A Dropbox path from a path, an id:/rev:/ns: reference, or a dropbox.com/home/... link. "" is the
 * root, allowed only where `root` is set (folder listings).
 */
function dbxPath(value: unknown, name = 'path', root = false): string {
  const raw = (typeof value === 'string' ? value : value == null ? '' : String(value)).trim();
  if (/^(?:id|rev|ns):/.test(raw)) return raw;
  let p = raw;
  const home = raw.match(/dropbox\.com\/home(\/[^?#]*)?(?:\?([^#]*))?/i);
  if (home) {
    p = decodeURIComponent(home[1] ?? '');
    const preview = new URLSearchParams(home[2] ?? '').get('preview');
    if (preview) p = `${p.replace(/\/+$/, '')}/${preview}`;
  } else if (/^https?:\/\//i.test(raw)) {
    throw new Error(`"${raw}" is a link, not a Dropbox path. Pass a path like /Folder/file.pdf${isSharedLink(raw) ? ', or use dropbox_download for shared links' : ''}.`);
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (p && !p.startsWith('/')) p = `/${p}`;
  if (!p && !root) throw new Error(`Missing "${name}": a Dropbox path like /Folder/file.pdf, or an id:… from dropbox_search.`);
  return p;
}

function describeEntry(m: DbxMeta) {
  const bits = [
    m['.tag'],
    m['.tag'] === 'file' && m.size != null ? formatSize(m.size) : '',
    m.server_modified ? `modified ${shortDate(m.server_modified)}` : '',
    m.is_downloadable === false ? `export only${m.export_info?.export_as ? ` as ${m.export_info.export_as}` : ''}` : '',
  ];
  return `${m.path_display ?? m.name} (${bits.filter(Boolean).join(', ')})${m.id ? `\n   ${m.id}` : ''}`;
}

const dropboxSearch: Tool = {
  name: 'dropbox_search',
  description:
    "Find files in the user's Dropbox. With query, searches file and folder names and contents (optionally within folder). " +
    'Without query, lists a folder ("" or omitted = the root; recursive for everything below it). ' +
    'Returns paths, types, sizes, modified dates and ids; pass a path or id to the other dropbox_ tools.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to search for.' },
      folder: { type: 'string', description: 'Folder path to list or search within, like /Documents. Default the root.' },
      filename_only: { type: 'boolean', description: 'Match file names only, not contents. Default false.' },
      recursive: { type: 'boolean', description: 'When listing, include everything in subfolders too. Default false.' },
      count: { type: 'integer', description: 'How many results, 1-100. Default 25.' },
      cursor: { type: 'string', description: 'cursor from a previous result, for the next page.' },
    },
  },
  async run(input, { signal }) {
    const count = int(input.count, 25, 1, 100);
    const cursor = opt(input.cursor);
    let entries: DbxMeta[];
    let next: string | undefined;
    if (cursor) {
      // Our cursors carry which listing they continue.
      const [, kind, raw] = cursor.match(/^(search|list):(.+)$/) ?? [];
      if (!kind) throw new Error('Pass the cursor exactly as a previous dropbox_search returned it.');
      if (kind === 'search') {
        const r = await dbx<{ matches: { metadata: { metadata: DbxMeta } }[]; has_more: boolean; cursor?: string }>('files/search/continue_v2', { cursor: raw }, signal);
        entries = r.matches.map((m) => m.metadata.metadata);
        next = r.has_more && r.cursor ? `search:${r.cursor}` : undefined;
      } else {
        const r = await dbx<{ entries: DbxMeta[]; has_more: boolean; cursor: string }>('files/list_folder/continue', { cursor: raw }, signal);
        entries = r.entries;
        next = r.has_more ? `list:${r.cursor}` : undefined;
      }
    } else if (opt(input.query)) {
      const folder = dbxPath(input.folder, 'folder', true);
      const r = await dbx<{ matches: { metadata: { metadata: DbxMeta } }[]; has_more: boolean; cursor?: string }>(
        'files/search_v2',
        {
          query: opt(input.query)!.slice(0, 1000),
          options: { ...(folder ? { path: folder } : {}), max_results: count, file_status: 'active', filename_only: input.filename_only === true },
        },
        signal
      );
      entries = r.matches.map((m) => m.metadata.metadata);
      next = r.has_more && r.cursor ? `search:${r.cursor}` : undefined;
    } else {
      const folder = dbxPath(input.folder, 'folder', true);
      const r = await dbx<{ entries: DbxMeta[]; has_more: boolean; cursor: string }>(
        'files/list_folder',
        { path: folder, limit: count, recursive: input.recursive === true },
        signal
      );
      entries = r.entries;
      next = r.has_more ? `list:${r.cursor}` : undefined;
    }
    if (!entries.length) return { output: cursor ? 'No more results.' : opt(input.query) ? 'No matching files in Dropbox.' : 'The folder is empty.' };
    const more = next ? `\n\n[More results: pass cursor "${next}".]` : '';
    return { output: clip(entries.map((m, i) => `${i + 1}. ${describeEntry(m)}`).join('\n') + more) };
  },
};

const dropboxDownload: Tool = {
  name: 'dropbox_download',
  description:
    'Download a file from Dropbox into the workspace (under dropbox/ unless save_as is given), to read with read_file or process with a script. ' +
    'Takes a path, an id from dropbox_search, or a dropbox.com shared link to a file. Files Dropbox can only export (like Paper docs) are exported.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Dropbox path (like /Documents/report.pdf), id:…, or shared link.' },
      save_as: { type: 'string', description: 'Workspace path to save to.' },
    },
    required: ['file'],
  },
  async run(input, { conversationId, signal, workspace: ws }) {
    const file = str(input.file, 'file').trim();
    let res: Awaited<ReturnType<typeof pluginFetch>>;
    let name: string;
    let label: string;
    if (isSharedLink(file)) {
      const url = /^https?:\/\//i.test(file) ? file : `https://${file}`;
      res = await dbxContent('sharing/get_shared_link_file', { url }, signal);
      let meta: { name?: string; '.tag'?: string } = {};
      try {
        meta = JSON.parse(res.headers.get('dropbox-api-result') ?? '{}');
      } catch {}
      name = meta.name || 'dropbox-file';
      label = `“${name}” from the shared link`;
    } else {
      const path = dbxPath(file, 'file');
      const meta = await dbx<DbxMeta>('files/get_metadata', { path }, signal);
      if (meta['.tag'] === 'folder') throw new Error(`${meta.path_display ?? path} is a folder. List it with dropbox_search folder="${meta.path_display ?? path}".`);
      if (meta.size != null && meta.size > MAX_TRANSFER_BYTES) {
        throw new Error(`${meta.path_display ?? meta.name} is ${formatSize(meta.size)}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);
      }
      label = meta.path_display ?? meta.name;
      if (meta.is_downloadable === false) {
        res = await dbxContent('files/export', { path: meta.id ?? path }, signal);
        let result: { export_metadata?: { name?: string } } = {};
        try {
          result = JSON.parse(res.headers.get('dropbox-api-result') ?? '{}');
        } catch {}
        name = result.export_metadata?.name || meta.name;
        label += ` (exported as ${name})`;
      } else {
        res = await dbxContent('files/download', { path: meta.id ?? path }, signal);
        name = meta.name;
      }
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const saved = await saveDownload({ ws, conversationId, bytes, name, dir: 'dropbox', saveAs: opt(input.save_as) });
    return { output: `Saved ${label} to ${saved.path} (${formatSize(saved.size)}).`, files: [saved.path] };
  },
};

const dropboxUpload: Tool = {
  name: 'dropbox_upload',
  description:
    "Upload a workspace file to the user's Dropbox. dest is the Dropbox path (default /<file name>; ending in / puts the file in that folder). " +
    'mode "add" (default) never replaces anything: a clashing name gets a number added. mode "overwrite" replaces the file at dest. Returns the path and id.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace path of the file to upload.' },
      dest: { type: 'string', description: 'Dropbox path to save to, like /Photos/trip.jpg or /Photos/.' },
      mode: { type: 'string', enum: ['add', 'overwrite'], description: 'Default add.' },
    },
    required: ['path'],
  },
  async run(input, { signal, workspace: ws }) {
    const up = await readUpload(ws, input.path);
    const destRaw = opt(input.dest) ?? '/';
    let dest: string;
    if (/^(?:id|rev|ns):/.test(destRaw)) dest = destRaw;
    else dest = destRaw.endsWith('/') || destRaw.endsWith('\\') ? `${dbxPath(destRaw, 'dest', true)}/${up.name}` : dbxPath(destRaw, 'dest');
    const mode = opt(input.mode) ?? 'add';
    if (mode !== 'add' && mode !== 'overwrite') throw new Error('mode must be "add" or "overwrite".');
    const arg = mode === 'add' ? { path: dest, mode: 'add', autorename: true } : { path: dest, mode: 'overwrite' };
    const res = await dbxContent('files/upload', arg, signal, up.bytes as Uint8Array<ArrayBuffer>);
    const meta = (await res.json()) as DbxMeta;
    const renamed = meta.path_display && meta.path_lower !== dest.toLowerCase() && !dest.startsWith('id:') ? ` (${dest} was taken, so it was renamed)` : '';
    return { output: `Uploaded ${up.path} to Dropbox${renamed}.\n${describeEntry(meta)}` };
  },
};

type SharedLink = { url: string; name?: string; path_lower?: string; expires?: string; link_permissions?: { resolved_visibility?: { '.tag'?: string } } };

const linkLine = (l: SharedLink) => {
  const vis = l.link_permissions?.resolved_visibility?.['.tag'];
  return `${l.url}${vis ? ` (${vis.replace(/_/g, ' ')})` : ''}${l.expires ? `, expires ${shortDate(l.expires)}` : ''}`;
};

const dropboxManage: Tool = {
  name: 'dropbox_manage',
  description:
    "Organise and share the user's Dropbox: create_folder (path), move or copy (path → to: the full new path; ending to in / keeps the name in that folder), " +
    'delete (path: Dropbox keeps deleted files restorable from its Deleted files page for a while, 30+ days depending on plan), ' +
    'or share_link (path: returns a shared link, reusing an existing one).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create_folder', 'move', 'copy', 'delete', 'share_link'] },
      path: { type: 'string', description: 'Dropbox path or id of the item to act on (the new folder for create_folder).' },
      to: { type: 'string', description: 'Destination path for move and copy.' },
    },
    required: ['action', 'path'],
  },
  async run(input, { signal }) {
    const action = str(input.action, 'action');
    const path = dbxPath(input.path);
    switch (action) {
      case 'create_folder': {
        const r = await dbx<{ metadata: DbxMeta }>('files/create_folder_v2', { path, autorename: false }, signal);
        return { output: `Created folder.\n${describeEntry({ ...r.metadata, '.tag': 'folder' })}` };
      }
      case 'move':
      case 'copy': {
        const toRaw = str(input.to, 'to').trim();
        let to: string;
        if (toRaw.endsWith('/') || toRaw.endsWith('\\')) {
          // Keep the item's name; an id needs a lookup to know it.
          const name = /^(?:id|rev|ns):/.test(path) ? (await dbx<DbxMeta>('files/get_metadata', { path }, signal)).name : baseName(path);
          to = `${dbxPath(toRaw, 'to', true)}/${name}`;
        } else to = dbxPath(toRaw, 'to');
        const r = await dbx<{ metadata: DbxMeta }>(`files/${action}_v2`, { from_path: path, to_path: to, autorename: false }, signal);
        return { output: `${action === 'move' ? 'Moved' : 'Copied'} to ${r.metadata.path_display ?? to}.\n${describeEntry(r.metadata)}` };
      }
      case 'delete': {
        const r = await dbx<{ metadata: DbxMeta }>('files/delete_v2', { path }, signal);
        return {
          output: `Deleted ${r.metadata.path_display ?? path}. It can be restored from Deleted files on dropbox.com for a limited time (30 days or more, depending on the plan).`,
        };
      }
      case 'share_link': {
        try {
          const link = await dbx<SharedLink>('sharing/create_shared_link_with_settings', { path }, signal);
          return { output: `Shared link for ${link.name ?? path}: ${linkLine(link)}` };
        } catch (e) {
          if (!(e instanceof DropboxError) || !e.summary.startsWith('shared_link_already_exists')) throw e;
          // The error usually carries the existing link; otherwise look it up.
          let existing: SharedLink | undefined;
          try {
            existing = JSON.parse(e.body).error?.shared_link_already_exists?.metadata;
          } catch {}
          if (!existing?.url) {
            const r = await dbx<{ links: SharedLink[] }>('sharing/list_shared_links', { path, direct_only: true }, signal);
            existing = r.links[0];
          }
          if (!existing?.url) throw new Error(`${path} already has a shared link, but Dropbox didn’t return it.`);
          return { output: `${path} already had a shared link: ${linkLine(existing)}` };
        }
      }
      default:
        throw new Error(`Unknown action "${action}". Use create_folder, move, copy, delete or share_link.`);
    }
  },
};

// ---- Spotify ---------------------------------------------------------------------------------

type SpUrls = { external_urls?: { spotify?: string } };
type SpArtist = SpUrls & { id: string; name: string; uri: string; genres?: string[] };
type SpAlbum = SpUrls & { id: string; name: string; uri: string; artists?: SpArtist[]; release_date?: string; total_tracks?: number; album_type?: string };
type SpTrack = SpUrls & {
  id?: string;
  name: string;
  uri: string;
  type?: string;
  artists?: SpArtist[];
  album?: SpAlbum;
  duration_ms?: number;
  show?: { name?: string };
  release_date?: string;
};
type SpPlaylist = SpUrls & {
  id: string;
  name: string;
  uri: string;
  public?: boolean | null;
  collaborative?: boolean;
  description?: string | null;
  owner?: { display_name?: string | null; id?: string };
  // Renamed from `tracks` in February 2026; older (extended quota) apps still get `tracks`.
  items?: { total?: number };
  tracks?: { total?: number };
};
type SpPaging<T> = { items: (T | null)[]; next?: string | null; total?: number; offset?: number; limit?: number };
type SpDevice = { id: string | null; name: string; type: string; is_active: boolean; is_restricted?: boolean; volume_percent?: number | null };
type SpPlayer = {
  device?: SpDevice;
  is_playing?: boolean;
  item?: SpTrack | null;
  progress_ms?: number | null;
  shuffle_state?: boolean;
  repeat_state?: string;
  context?: { uri?: string; type?: string } | null;
};

const sp = <T = any>(path: string, init: Parameters<typeof pluginJson>[2] = {}) => pluginJson<T>('spotify', `${SPOTIFY}${path}`, init);

/** Kinds of Spotify item a link or URI can name. */
type SpKind = 'track' | 'album' | 'playlist' | 'artist' | 'episode' | 'show';

/** A Spotify item from an open.spotify.com link or spotify: URI; a bare 22-character id counts as `bare`. */
function spotifyRef(input: string, bare?: SpKind): { kind: SpKind; id: string; uri: string } | null {
  const s = input.trim();
  const m =
    s.match(/^spotify:(?:user:[^:]+:)?(track|album|playlist|artist|episode|show):([A-Za-z0-9]{22})$/i) ??
    s.match(/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]+)?\/)?(?:embed\/)?(?:user\/[^/]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})/i);
  if (m) {
    const kind = m[1].toLowerCase() as SpKind;
    return { kind, id: m[2], uri: `spotify:${kind}:${m[2]}` };
  }
  if (bare && /^[A-Za-z0-9]{22}$/.test(s)) return { kind: bare, id: s, uri: `spotify:${bare}:${s}` };
  if (/spotify\.link\//i.test(s)) throw new Error(`Short spotify.link links can't be resolved; pass the open.spotify.com link or a spotify: URI.`);
  return null;
}

const spUrl = (o: SpUrls) => o.external_urls?.spotify ?? '';
const artistNames = (artists?: SpArtist[]) => (artists ?? []).map((a) => a.name).join(', ');
const year = (date?: string) => (date ? date.slice(0, 4) : '');
const duration = (ms?: number | null) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const refLine = (o: SpUrls & { uri: string }) => `   ${o.uri}${spUrl(o) ? ` · ${spUrl(o)}` : ''}`;

function trackText(t: SpTrack) {
  if (t.type === 'episode') return `${t.name} – ${t.show?.name ?? 'podcast episode'}${t.release_date ? ` (${t.release_date})` : ''}`;
  const album = t.album ? ` (${t.album.name}${year(t.album.release_date) ? `, ${year(t.album.release_date)}` : ''})` : '';
  const len = duration(t.duration_ms);
  return `${t.name} – ${artistNames(t.artists) || 'unknown artist'}${album}${len ? ` · ${len}` : ''}`;
}

const trackEntry = (t: SpTrack) => `${trackText(t)}\n${refLine(t)}`;
const albumEntry = (a: SpAlbum) =>
  `${a.name} – ${artistNames(a.artists)} (${[a.album_type, year(a.release_date), a.total_tracks != null ? `${a.total_tracks} tracks` : ''].filter(Boolean).join(', ')})\n${refLine(a)}`;
const artistEntry = (a: SpArtist) => `${a.name}${a.genres?.length ? ` (${a.genres.slice(0, 4).join(', ')})` : ''}\n${refLine(a)}`;
const playlistTotal = (p: SpPlaylist) => p.items?.total ?? p.tracks?.total;
function playlistEntry(p: SpPlaylist) {
  const total = playlistTotal(p);
  const bits = [
    p.owner?.display_name ? `by ${p.owner.display_name}` : '',
    total != null ? `${total} tracks` : '',
    p.collaborative ? 'collaborative' : p.public === false ? 'private' : p.public ? 'public' : '',
  ].filter(Boolean);
  return `${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}\n   id ${p.id} · ${spUrl(p) || p.uri}`;
}

const SEARCH_TYPES = ['track', 'album', 'artist', 'playlist'];
/** Spotify caps search pages at 10 per type for development-mode apps (February 2026). */
const SEARCH_MAX = 10;

async function searchTop<T>(query: string, kind: string, signal: AbortSignal): Promise<T | undefined> {
  const r = await sp<Record<string, SpPaging<T>>>(`/search?${new URLSearchParams({ q: query, type: kind, limit: '1' })}`, { signal });
  return r[`${kind}s`]?.items.find((x): x is T => x != null);
}

const spotifySearch: Tool = {
  name: 'spotify_search',
  description:
    'Search the Spotify catalog for tracks, albums, artists or playlists. Supports field filters in the query, like artist:Radiohead year:1997 or track:"Paranoid Android". ' +
    'Returns names, artists, albums and years with spotify: URIs and links to pass to spotify_playlist and spotify_playback. At most 10 results per type per call; use offset for more.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' },
      type: { type: 'string', description: 'track (default), album, artist or playlist; several as a comma list like "track,album".' },
      count: { type: 'integer', description: 'Results per type, 1-10. Default 10.' },
      offset: { type: 'integer', description: 'Index of the first result, for the next page. Default 0.' },
    },
    required: ['query'],
  },
  async run(input, { signal }) {
    const query = str(input.query, 'query');
    const types = [...new Set(strings(input.type).map((t) => t.toLowerCase().replace(/s$/, '')))];
    if (!types.length) types.push('track');
    const bad = types.filter((t) => !SEARCH_TYPES.includes(t));
    if (bad.length) throw new Error(`Unknown type "${bad.join(', ')}". Use ${SEARCH_TYPES.join(', ')}.`);
    const limit = int(input.count, SEARCH_MAX, 1, SEARCH_MAX);
    const offset = int(input.offset, 0, 0, 1000);
    const r = await sp<Record<string, SpPaging<any>>>(`/search?${new URLSearchParams({ q: query, type: types.join(','), limit: String(limit), offset: String(offset) })}`, {
      signal,
    });
    const sections: string[] = [];
    let more = false;
    for (const t of types) {
      const page = r[`${t}s`];
      const items = (page?.items ?? []).filter((x) => x != null);
      if (page?.next) more = true;
      const fmt = t === 'track' ? trackEntry : t === 'album' ? albumEntry : t === 'artist' ? artistEntry : playlistEntry;
      const lines = items.map((x, i) => `${offset + i + 1}. ${fmt(x)}`);
      sections.push(`${types.length > 1 ? `${t[0].toUpperCase()}${t.slice(1)}s:\n` : ''}${lines.length ? lines.join('\n') : `No ${t}s found.`}`);
    }
    const tail = more ? `\n\n[More results: pass offset ${offset + limit}.]` : '';
    return { output: clip(sections.join('\n\n') + tail) };
  },
};

const LIBRARY_WHATS = ['top_tracks', 'top_artists', 'recent', 'saved', 'playlists', 'playlist', 'now_playing', 'devices'];

function playerText(p: SpPlayer) {
  if (!p.item && !p.device) return 'Nothing is playing, and no device is active.';
  const what = p.item ? trackText(p.item) : 'nothing';
  const progress = p.item && p.progress_ms != null ? ` [${duration(p.progress_ms)}/${duration(p.item.duration_ms)}]` : '';
  const dev = p.device ? ` on ${p.device.name} (${p.device.type}${p.device.volume_percent != null ? `, volume ${p.device.volume_percent}%` : ''})` : '';
  const modes = `shuffle ${p.shuffle_state ? 'on' : 'off'}, repeat ${p.repeat_state ?? 'off'}`;
  return `${p.is_playing ? 'Playing' : 'Paused'}: ${what}${progress}${dev} · ${modes}${p.item ? `\n${refLine(p.item)}` : ''}`;
}

const deviceLine = (d: SpDevice) =>
  `${d.name} (${d.type}${d.is_active ? ', active' : ''}${d.is_restricted ? ', can’t be controlled' : ''}${d.volume_percent != null ? `, volume ${d.volume_percent}%` : ''})${d.id ? `\n   id ${d.id}` : ''}`;

/** A playlist id from a link, URI or id, or else the name of one of the user's playlists. */
async function playlistId(input: unknown, signal: AbortSignal): Promise<string> {
  const s = str(input, 'playlist').trim();
  const ref = spotifyRef(s, 'playlist');
  if (ref) {
    if (ref.kind !== 'playlist') throw new Error(`"${s}" is a ${ref.kind}, not a playlist.`);
    return ref.id;
  }
  const want = s.toLowerCase();
  let fuzzy: SpPlaylist | undefined;
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await sp<SpPaging<SpPlaylist>>(`/me/playlists?limit=50&offset=${offset}`, { signal });
    const items = page.items.filter((p): p is SpPlaylist => p != null);
    const exact = items.find((p) => p.name.toLowerCase() === want);
    if (exact) return exact.id;
    fuzzy ??= items.find((p) => p.name.toLowerCase().includes(want));
    if (!page.next) break;
  }
  if (fuzzy) return fuzzy.id;
  throw new Error(`No playlist named "${s}" among the user's playlists. Pass a playlist link or id (spotify_library what="playlists" lists them).`);
}

type PlaylistItem = { added_at?: string; item?: SpTrack | null; track?: SpTrack | null };

const forbiddenPlaylist = (e: unknown) =>
  e instanceof PluginApiError && e.status === 403
    ? new Error('Spotify only shows the tracks of playlists the user owns or collaborates on. For other playlists, only the name and owner are available.')
    : e;

const spotifyLibrary: Tool = {
  name: 'spotify_library',
  description:
    "Look at the user's Spotify: top_tracks or top_artists (time_range short_term ≈ 4 weeks, medium_term ≈ 6 months (default), long_term ≈ 1 year), " +
    'recent (recently played), saved (liked songs), playlists (theirs and followed), playlist (the tracks of one playlist they own or collaborate on), ' +
    'now_playing (current playback), or devices (Spotify Connect devices, for spotify_playback).',
  parameters: {
    type: 'object',
    properties: {
      what: { type: 'string', enum: LIBRARY_WHATS },
      playlist: { type: 'string', description: 'For what=playlist: playlist link, URI, id or exact name.' },
      time_range: { type: 'string', enum: ['short_term', 'medium_term', 'long_term'], description: 'For top_tracks and top_artists.' },
      count: { type: 'integer', description: 'How many items, 1-50. Default 20.' },
      offset: { type: 'integer', description: 'Index of the first item, for the next page. Default 0.' },
      cursor: { type: 'string', description: 'For what=recent: cursor from a previous result, for older plays.' },
    },
    required: ['what'],
  },
  async run(input, { signal }) {
    const what = str(input.what, 'what');
    const limit = int(input.count, 20, 1, 50);
    const offset = int(input.offset, 0, 0, 100_000);
    const page = `limit=${limit}&offset=${offset}`;
    const moreAt = (p: { next?: string | null }) => (p.next ? `\n\n[More: pass offset ${offset + limit}.]` : '');
    const numbered = <T>(items: (T | null)[], fmt: (x: T) => string) =>
      items
        .filter((x): x is T => x != null)
        .map((x, i) => `${offset + i + 1}. ${fmt(x)}`)
        .join('\n');

    switch (what) {
      case 'top_tracks':
      case 'top_artists': {
        const range = opt(input.time_range) ?? 'medium_term';
        if (!['short_term', 'medium_term', 'long_term'].includes(range)) throw new Error('time_range must be short_term, medium_term or long_term.');
        const kind = what === 'top_tracks' ? 'tracks' : 'artists';
        const r = await sp<SpPaging<any>>(`/me/top/${kind}?time_range=${range}&${page}`, { signal });
        if (!r.items.length) return { output: `No top ${kind} yet for ${range}.` };
        return { output: clip(numbered<any>(r.items, kind === 'tracks' ? trackEntry : artistEntry) + moreAt(r)) };
      }
      case 'recent': {
        const before = opt(input.cursor);
        if (before && !/^\d+$/.test(before)) throw new Error('Pass the cursor exactly as a previous result returned it.');
        const r = await sp<{ items: { track: SpTrack; played_at: string }[]; cursors?: { before?: string } | null; next?: string | null }>(
          `/me/player/recently-played?limit=${limit}${before ? `&before=${before}` : ''}`,
          { signal }
        );
        if (!r.items.length) return { output: before ? 'No older plays.' : 'Nothing played recently.' };
        const lines = r.items.map((x, i) => `${i + 1}. ${shortDate(x.played_at)} UTC · ${trackEntry(x.track)}`);
        const more = r.next && r.cursors?.before ? `\n\n[Older plays: pass cursor "${r.cursors.before}".]` : '';
        return { output: clip(lines.join('\n') + more) };
      }
      case 'saved': {
        const r = await sp<SpPaging<{ added_at: string; track: SpTrack }>>(`/me/tracks?${page}`, { signal });
        if (!r.items.length) return { output: 'No liked songs.' };
        const total = r.total != null ? `${r.total} liked songs.\n` : '';
        return { output: clip(total + numbered(r.items, (x) => `${trackEntry(x.track)} (liked ${x.added_at.slice(0, 10)})`) + moreAt(r)) };
      }
      case 'playlists': {
        const r = await sp<SpPaging<SpPlaylist>>(`/me/playlists?${page}`, { signal });
        if (!r.items.length) return { output: 'No playlists.' };
        return { output: clip(numbered(r.items, playlistEntry) + moreAt(r)) };
      }
      case 'playlist': {
        const id = await playlistId(input.playlist, signal);
        const [meta, items] = await Promise.all([
          sp<SpPlaylist>(`/playlists/${id}?fields=${encodeURIComponent('id,name,uri,public,collaborative,owner(display_name),external_urls')}`, { signal }),
          sp<SpPaging<PlaylistItem>>(`/playlists/${id}/items?${page}`, { signal }).catch((e) => {
            throw forbiddenPlaylist(e);
          }),
        ]);
        const head = `${meta.name}${meta.owner?.display_name ? ` by ${meta.owner.display_name}` : ''}${items.total != null ? `, ${items.total} tracks` : ''} · ${spUrl(meta) || meta.uri}`;
        const lines = numbered(items.items, (x) => {
          const t = x.item ?? x.track;
          return t ? trackEntry(t) : '(unavailable item)';
        });
        return { output: clip(`${head}\n${lines || 'No tracks here.'}${moreAt(items)}`) };
      }
      case 'now_playing': {
        const p = await sp<SpPlayer>('/me/player', { signal });
        return { output: playerText(p) };
      }
      case 'devices': {
        const r = await sp<{ devices: SpDevice[] }>('/me/player/devices', { signal });
        if (!r.devices.length) return { output: 'No Spotify devices are online. Ask the user to open Spotify on a phone, computer or speaker.' };
        return { output: r.devices.map((d, i) => `${i + 1}. ${deviceLine(d)}`).join('\n') };
      }
      default:
        throw new Error(`Unknown what "${what}". Use one of: ${LIBRARY_WHATS.join(', ')}.`);
    }
  },
};

/** Track entries from an array, a JSON array string, or lines; commas split only lists of links/URIs/ids. */
function trackEntries(value: unknown): string[] {
  const items = list(value).map((v) => (typeof v === 'string' ? v : v == null ? '' : String(v)));
  const out = items.flatMap((s) => {
    const lines = s.split(/\r?\n/);
    return lines.flatMap((line) => {
      const parts = line.split(',').map((p) => p.trim());
      return parts.length > 1 && parts.every((p) => !p || spotifyRef(p, 'track')) ? parts : [line];
    });
  });
  // Drop list bullets, but not leading digits: titles like "7 Rings" start with them.
  return out.map((s) => s.trim().replace(/^[-*•]\s+/, '')).filter(Boolean);
}

type Resolved = { uris: string[]; matched: string[]; missed: string[] };

/** Turns links, URIs, ids and "Song – Artist" text into track URIs; text takes the top search hit. Albums expand to their tracks. */
async function resolveTracks(entries: string[], signal: AbortSignal): Promise<Resolved> {
  const text = entries.filter((e) => !spotifyRef(e, 'track'));
  if (text.length > 100) throw new Error(`Too many tracks to look up by name at once (${text.length}); pass at most 100, or use links/URIs.`);
  const results = await mapLimit(entries, 4, async (entry): Promise<{ uris: string[]; matched?: string; missed?: string }> => {
    const ref = spotifyRef(entry, 'track');
    if (ref) {
      if (ref.kind === 'track' || ref.kind === 'episode') return { uris: [ref.uri] };
      if (ref.kind === 'album') {
        const album = await sp<SpPaging<SpTrack>>(`/albums/${ref.id}/tracks?limit=50`, { signal });
        const uris = album.items.filter((t): t is SpTrack => t != null).map((t) => t.uri);
        return { uris, matched: `${entry} → ${uris.length} album tracks` };
      }
      throw new Error(`"${entry}" is a${ref.kind === 'artist' ? 'n' : ''} ${ref.kind}; pass tracks (or albums).`);
    }
    // "Song – Artist" searches better without the dash.
    const hit = await searchTop<SpTrack>(entry.replace(/\s+[–—-]\s+/g, ' '), 'track', signal);
    return hit ? { uris: [hit.uri], matched: `“${entry}” → ${trackText(hit)} (${hit.uri})` } : { uris: [], missed: entry };
  });
  return {
    uris: results.flatMap((r) => r.uris),
    matched: results.flatMap((r) => (r.matched ? [r.matched] : [])),
    missed: results.flatMap((r) => (r.missed ? [r.missed] : [])),
  };
}

async function addToPlaylist(id: string, uris: string[], signal: AbortSignal) {
  for (const batch of chunks(uris, 100)) await sp(`/playlists/${id}/items`, { method: 'POST', json: { uris: batch }, signal });
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The URIs in a playlist matching "Song – Artist" text (or links), for removal. */
async function matchInPlaylist(id: string, entries: string[], signal: AbortSignal): Promise<Resolved> {
  const uris: string[] = [];
  const matched: string[] = [];
  const missed: string[] = [];
  const text = entries.filter((e) => {
    const ref = spotifyRef(e, 'track');
    if (ref) uris.push(ref.uri);
    return !ref;
  });
  if (!text.length) return { uris, matched, missed };
  const tracks: SpTrack[] = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const page = await sp<SpPaging<PlaylistItem>>(`/playlists/${id}/items?limit=50&offset=${offset}`, { signal }).catch((e) => {
      throw forbiddenPlaylist(e);
    });
    for (const x of page.items) {
      const t = x?.item ?? x?.track;
      if (t?.uri) tracks.push(t);
    }
    if (!page.next) break;
  }
  for (const entry of text) {
    const [title, artist] = entry.split(/\s+[–—-]\s+|\s+by\s+/i).map(norm);
    const byArtist = (t: SpTrack) => !artist || norm(artistNames(t.artists)).includes(artist);
    const hit =
      tracks.find((t) => norm(t.name) === title && byArtist(t)) ??
      tracks.find((t) => (norm(t.name).includes(title) || title.includes(norm(t.name))) && byArtist(t));
    if (hit) {
      uris.push(hit.uri);
      matched.push(`“${entry}” → ${trackText(hit)}`);
    } else missed.push(entry);
  }
  return { uris, matched, missed };
}

const report = (r: Resolved) =>
  [r.matched.length ? `Matched:\n${r.matched.map((m) => `- ${m}`).join('\n')}` : '', r.missed.length ? `Not found: ${r.missed.map((m) => `“${m}”`).join(', ')}` : '']
    .filter(Boolean)
    .join('\n');

const spotifyPlaylist: Tool = {
  name: 'spotify_playlist',
  description:
    "Edit the user's Spotify playlists. create (name, optional description, public (default false), optional tracks to add); " +
    'add (playlist, tracks); remove (playlist, tracks: removes every occurrence). tracks are spotify: URIs, open.spotify.com links or ids, ' +
    'or "Song – Artist" text: for add, text takes the top search hit; for remove, it matches tracks already in the playlist. The result lists what each text matched. Returns the playlist link.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'add', 'remove'] },
      playlist: { type: 'string', description: 'For add and remove: playlist link, URI, id or exact name.' },
      name: { type: 'string', description: 'For create: the new playlist’s name.' },
      description: { type: 'string', description: 'For create: the playlist description.' },
      public: { type: 'boolean', description: 'For create: show it on the user’s profile. Default false.' },
      tracks: { type: 'array', items: { type: 'string' }, description: 'Tracks: URIs, links, ids, or "Song – Artist" text.' },
    },
    required: ['action'],
  },
  async run(input, { signal }) {
    const action = str(input.action, 'action');
    const entries = trackEntries(input.tracks);
    switch (action) {
      case 'create': {
        const name = str(input.name, 'name').trim();
        const resolved = entries.length ? await resolveTracks(entries, signal) : undefined;
        const p = await sp<SpPlaylist>('/me/playlists', {
          method: 'POST',
          json: { name, public: input.public === true, ...(opt(input.description) ? { description: opt(input.description) } : {}) },
          signal,
        });
        if (resolved?.uris.length) await addToPlaylist(p.id, resolved.uris, signal);
        const added = resolved ? ` with ${resolved.uris.length} track${resolved.uris.length === 1 ? '' : 's'}` : '';
        const details = resolved ? report(resolved) : '';
        return {
          output: `Created ${input.public === true ? 'public' : 'private'} playlist “${p.name}”${added}.\n   id ${p.id} · ${spUrl(p) || p.uri}${details ? `\n${details}` : ''}`,
        };
      }
      case 'add':
      case 'remove': {
        if (!entries.length) throw new Error('Pass the tracks.');
        const id = await playlistId(input.playlist, signal);
        const resolved = action === 'add' ? await resolveTracks(entries, signal) : await matchInPlaylist(id, entries, signal);
        const uris = action === 'remove' ? [...new Set(resolved.uris)] : resolved.uris;
        if (uris.length) {
          if (action === 'add') await addToPlaylist(id, uris, signal);
          else for (const batch of chunks(uris, 100)) await sp(`/playlists/${id}/items`, { method: 'DELETE', json: { items: batch.map((uri) => ({ uri })) }, signal });
        }
        const meta = await sp<SpPlaylist>(`/playlists/${id}?fields=${encodeURIComponent('id,name,uri,external_urls')}`, { signal });
        const verb = action === 'add' ? `Added ${uris.length} track${uris.length === 1 ? '' : 's'} to` : `Removed ${uris.length} track${uris.length === 1 ? '' : 's'} from`;
        const details = report(resolved);
        return { output: `${verb} “${meta.name}”.\n   ${spUrl(meta) || meta.uri}${details ? `\n${details}` : ''}`, isError: !uris.length };
      }
      default:
        throw new Error(`Unknown action "${action}". Use create, add or remove.`);
    }
  },
};

const PLAYBACK_ACTIONS = ['play', 'pause', 'next', 'previous', 'queue', 'volume', 'shuffle', 'transfer'];

/** Player errors in terms the model can act on: no active device, or no Premium. */
function playbackError(e: unknown): unknown {
  if (!(e instanceof PluginApiError)) return e;
  let reason = '';
  let message = '';
  try {
    const j = JSON.parse(e.body);
    reason = String(j.error?.reason ?? '');
    message = String(j.error?.message ?? '');
  } catch {}
  if (reason === 'NO_ACTIVE_DEVICE' || (e.status === 404 && /device/i.test(message || e.message))) {
    return new Error(
      'No active Spotify device. Ask the user to open Spotify on their phone, computer or speaker (playing something briefly wakes it), then try again; spotify_library what="devices" lists devices.'
    );
  }
  if (e.status === 403) {
    if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message)) return new Error('Controlling playback needs Spotify Premium; this account doesn’t have it.');
    if (/restrict/i.test(message) || reason === 'UNKNOWN') {
      return new Error(`Spotify refused: ${message || 'not allowed right now'}. The device or content may not allow this action (some devices and ads block it).`);
    }
    return new Error(`Spotify refused: ${message || e.message}. Playback control needs Spotify Premium.`);
  }
  return e;
}

async function findDevice(value: string, signal: AbortSignal): Promise<SpDevice & { id: string }> {
  const r = await sp<{ devices: SpDevice[] }>('/me/player/devices', { signal });
  const want = value.toLowerCase();
  const hit = r.devices.find((d) => d.id === value) ?? r.devices.find((d) => d.name.toLowerCase() === want) ?? r.devices.find((d) => d.name.toLowerCase().includes(want));
  if (!hit) {
    throw new Error(
      r.devices.length
        ? `No device "${value}". Online devices: ${r.devices.map((d) => d.name).join(', ')}.`
        : 'No Spotify devices are online. Ask the user to open Spotify on a phone, computer or speaker.'
    );
  }
  if (!hit.id || hit.is_restricted) throw new Error(`${hit.name} can’t be controlled through the Spotify API.`);
  return hit as SpDevice & { id: string };
}

const spotifyPlayback: Tool = {
  name: 'spotify_playback',
  description:
    "Control the user's Spotify playback (needs Premium and an open Spotify app on some device). " +
    'play (item: a track/album/playlist/artist link or URI, or search text, searched as kind (default track); without item, resumes), pause, next, previous, ' +
    'queue (item: a track), volume (volume 0-100), shuffle (state), transfer (device: move playback there). device (id or name) targets a device; ' +
    'spotify_library what="devices" lists them. Returns what’s playing afterwards.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: PLAYBACK_ACTIONS },
      item: { type: 'string', description: 'For play and queue: link, URI or search text.' },
      kind: { type: 'string', enum: ['track', 'album', 'playlist', 'artist'], description: 'What to search for when item is text. Default track.' },
      device: { type: 'string', description: 'Device id or name.' },
      volume: { type: 'integer', description: 'For volume: 0-100.' },
      state: { type: 'boolean', description: 'For shuffle: on (true) or off (false).' },
    },
    required: ['action'],
  },
  async run(input, { signal }) {
    const action = str(input.action, 'action');
    if (!PLAYBACK_ACTIONS.includes(action)) throw new Error(`Unknown action "${action}". Use one of: ${PLAYBACK_ACTIONS.join(', ')}.`);
    try {
      const device = opt(input.device) ? await findDevice(opt(input.device)!, signal) : undefined;
      const dq = device ? `device_id=${encodeURIComponent(device.id)}` : '';
      const withDevice = (path: string, query = '') => `${path}${query || dq ? `?${[query, dq].filter(Boolean).join('&')}` : ''}`;
      let note = '';
      switch (action) {
        case 'play': {
          const item = opt(input.item);
          let body: Record<string, unknown> | undefined;
          if (item) {
            const kind = opt(input.kind) ?? 'track';
            if (!['track', 'album', 'playlist', 'artist'].includes(kind)) throw new Error('kind must be track, album, playlist or artist.');
            let ref = spotifyRef(item, kind as SpKind);
            if (!ref) {
              const hit = await searchTop<SpTrack & SpAlbum & SpPlaylist & SpArtist>(item, kind, signal);
              if (!hit) throw new Error(`Nothing on Spotify matches "${item}" (${kind}).`);
              ref = spotifyRef(hit.uri);
              note = `Found ${kind} for “${item}”: ${kind === 'track' ? trackText(hit) : kind === 'album' ? `${hit.name} – ${artistNames(hit.artists)}` : hit.name}.\n`;
            }
            if (!ref) throw new Error(`Couldn't play "${item}".`);
            body = ref.kind === 'track' || ref.kind === 'episode' ? { uris: [ref.uri] } : { context_uri: ref.uri };
          }
          await sp(withDevice('/me/player/play'), { method: 'PUT', ...(body ? { json: body } : {}), signal });
          break;
        }
        case 'pause':
          await sp(withDevice('/me/player/pause'), { method: 'PUT', signal });
          break;
        case 'next':
        case 'previous':
          await sp(withDevice(`/me/player/${action}`), { method: 'POST', signal });
          break;
        case 'queue': {
          const item = str(input.item, 'item');
          let ref = spotifyRef(item, 'track');
          if (!ref) {
            const hit = await searchTop<SpTrack>(item, 'track', signal);
            if (!hit) throw new Error(`No track on Spotify matches "${item}".`);
            ref = spotifyRef(hit.uri);
            note = `Found “${trackText(hit)}”.\n`;
          }
          if (!ref || (ref.kind !== 'track' && ref.kind !== 'episode')) throw new Error('Only tracks and episodes can be queued.');
          await sp(withDevice('/me/player/queue', `uri=${encodeURIComponent(ref.uri)}`), { method: 'POST', signal });
          note += `Queued ${ref.uri}.\n`;
          break;
        }
        case 'volume': {
          if (input.volume == null || input.volume === '') throw new Error('Pass volume, 0-100.');
          const v = int(input.volume, 50, 0, 100);
          await sp(withDevice('/me/player/volume', `volume_percent=${v}`), { method: 'PUT', signal });
          break;
        }
        case 'shuffle': {
          const on = input.state === true || input.state === 'true';
          await sp(withDevice('/me/player/shuffle', `state=${on}`), { method: 'PUT', signal });
          break;
        }
        case 'transfer': {
          if (!device) throw new Error('Pass the device (id or name) to move playback to.');
          await sp('/me/player', { method: 'PUT', json: { device_ids: [device.id], play: true }, signal });
          break;
        }
      }
      // Player commands apply asynchronously; give the state a moment to catch up before reading it.
      await sleep(action === 'queue' || action === 'volume' || action === 'shuffle' ? 300 : 700, signal);
      const state = await sp<SpPlayer>('/me/player', { signal }).catch(() => null);
      return { output: `${note}Done.${state ? `\n${playerText(state)}` : ''}` };
    } catch (e) {
      throw playbackError(e);
    }
  },
};

// ---- Weather (Open-Meteo) --------------------------------------------------------------------

/** WMO weather interpretation codes, as Open-Meteo documents them. */
const WMO: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Light snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, light hail',
  99: 'Thunderstorm, heavy hail',
};
const wmo = (code: number | null | undefined) => (code == null ? '–' : (WMO[code] ?? `code ${code}`));

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg: number | null | undefined) => (deg == null ? '' : COMPASS[Math.round(deg / 22.5) % 16]);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? '';

type Place = { name: string; latitude: number; longitude: number; country?: string; country_code?: string; admin1?: string; admin2?: string; timezone?: string; population?: number };

/** Open-Meteo requests; their errors carry a `reason`. */
async function meteo<T>(url: string, signal: AbortSignal): Promise<T> {
  try {
    return await pluginJson<T>('none', url, { signal });
  } catch (e) {
    if (e instanceof PluginApiError) {
      let reason = '';
      try {
        reason = JSON.parse(e.body).reason ?? '';
      } catch {}
      throw new Error(`Open-Meteo: ${reason || `error ${e.status}`}`);
    }
    throw e;
  }
}

const placeName = (p: Place) => [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : '', p.country].filter(Boolean).join(', ');

async function geocode(query: string, signal: AbortSignal): Promise<{ place: Place; others: Place[] }> {
  const search = async (name: string, count: number) =>
    (await meteo<{ results?: Place[] }>(`${GEOCODE}?${new URLSearchParams({ name, count: String(count), language: 'en', format: 'json' })}`, signal)).results ?? [];
  let results = await search(query, 5);
  if (!results.length && query.includes(',')) {
    // "Springfield, Illinois": search the name, then prefer the region or country given.
    const [head, ...rest] = query.split(',');
    const qualifier = norm(rest.join(' '));
    const candidates = await search(head.trim(), 20);
    const fits = candidates.filter((c) => [c.country, c.country_code, c.admin1, c.admin2].some((v) => v && norm(v).startsWith(qualifier)));
    results = fits.length ? fits : candidates;
  }
  if (!results.length) throw new Error(`Couldn't find a place called "${query}". Try a city or town name (optionally ", country"), or pass latitude and longitude.`);
  return { place: results[0], others: results.slice(1, 4) };
}

type Series = Record<string, (number | string | null)[]>;
type Forecast = {
  latitude: number;
  longitude: number;
  timezone?: string;
  timezone_abbreviation?: string;
  elevation?: number;
  current?: Record<string, number | string | null>;
  hourly?: Series;
  daily?: Series;
};

const num = (v: unknown, digits = 0) => (typeof v === 'number' ? v.toFixed(digits).replace(/^-0(\.0+)?$/, '0') : '–');

const weatherForecast: Tool = {
  name: 'weather_forecast',
  description:
    'Weather for any place from Open-Meteo: current conditions and a daily forecast (up to 16 days) with highs/lows, chance and amount of precipitation, ' +
    'max wind and sunrise/sunset, in local time. Set hourly for hour-by-hour rows (the next `hours` hours, or all of `date`). ' +
    'Takes a place name (the result says which place matched) or latitude/longitude.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'Place name, like "Tokyo" or "Springfield, Illinois".' },
      latitude: { type: 'number', description: 'Latitude, instead of location.' },
      longitude: { type: 'number', description: 'Longitude, instead of location.' },
      days: { type: 'integer', description: 'Days of daily forecast, 1-16. Default 7.' },
      hourly: { type: 'boolean', description: 'Include hourly rows. Default false.' },
      hours: { type: 'integer', description: 'With hourly and no date: how many hours ahead, 1-48. Default 24.' },
      date: { type: 'string', description: 'A local date (YYYY-MM-DD) within the next 16 days to show hour by hour.' },
      units: { type: 'string', enum: ['metric', 'imperial'], description: 'metric (°C, km/h, mm; default) or imperial (°F, mph, inches).' },
    },
  },
  async run(input, { signal }) {
    const imperial = opt(input.units) === 'imperial';
    const days = int(input.days, 7, 1, 16);
    const date = opt(input.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must look like 2026-11-28.');
    const hourly = !!date || input.hourly === true || input.hourly === 'true';
    const hours = int(input.hours, 24, 1, 48);

    let lat: number;
    let lon: number;
    let where: string;
    let also = '';
    const hasCoords = input.latitude != null && input.latitude !== '' && input.longitude != null && input.longitude !== '';
    if (hasCoords) {
      lat = Number(input.latitude);
      lon = Number(input.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('latitude must be -90..90 and longitude -180..180.');
      where = opt(input.location) ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    } else {
      const { place, others } = await geocode(str(input.location, 'location').trim(), signal);
      lat = place.latitude;
      lon = place.longitude;
      where = placeName(place);
      if (others.length) also = `\n(Other matches: ${others.map(placeName).join('; ')}. Pass a more specific location if needed.)`;
    }

    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      timezone: 'auto',
      // For a date, fetch the whole range and pick the date's hours locally (start_hour can't be combined with forecast_days).
      forecast_days: String(date ? 16 : days),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset',
    });
    if (hourly) {
      params.set('hourly', 'temperature_2m,apparent_temperature,weather_code,precipitation_probability,precipitation,wind_speed_10m');
      if (!date) params.set('forecast_hours', String(hours));
    }
    if (imperial) {
      params.set('temperature_unit', 'fahrenheit');
      params.set('wind_speed_unit', 'mph');
      params.set('precipitation_unit', 'inch');
    }
    const f = await meteo<Forecast>(`${FORECAST}?${params}`, signal);
    const T = imperial ? '°F' : '°C';
    const W = imperial ? 'mph' : 'km/h';
    const P = imperial ? 'in' : 'mm';
    const pd = imperial ? 2 : 1;

    const out: string[] = [
      `${where} (${num(f.latitude, 2)}, ${num(f.longitude, 2)}${f.elevation != null ? `, ${Math.round(f.elevation)} m` : ''}) · times in ${f.timezone ?? 'local time'}${
        f.timezone_abbreviation ? ` (${f.timezone_abbreviation})` : ''
      }${also}`,
    ];

    const c = f.current;
    if (c) {
      out.push(
        `\nNow (${String(c.time ?? '').slice(11, 16)}): ${wmo(c.weather_code as number)}, ${num(c.temperature_2m)}${T} (feels ${num(c.apparent_temperature)}${T}), ` +
          `humidity ${num(c.relative_humidity_2m)}%, wind ${num(c.wind_speed_10m)} ${W} ${compass(c.wind_direction_10m as number)}` +
          `${typeof c.wind_gusts_10m === 'number' ? ` (gusts ${num(c.wind_gusts_10m)})` : ''}, precipitation ${num(c.precipitation, pd)} ${P}`
      );
    }

    const d = f.daily;
    if (d?.time?.length) {
      const idx = d.time.map((_, i) => i).filter((i) => i < days || (date && d.time[i] === date));
      const rows = idx.map((i) => {
        const day = String(d.time[i]);
        return `${weekday(day)} ${day.slice(5)} | ${wmo(d.weather_code?.[i] as number)} | ${num(d.temperature_2m_max?.[i])}/${num(d.temperature_2m_min?.[i])}${T} | ${num(
          d.precipitation_probability_max?.[i]
        )}% | ${num(d.precipitation_sum?.[i], pd)} ${P} | ${num(d.wind_speed_10m_max?.[i])} ${W} | ${String(d.sunrise?.[i] ?? '').slice(11, 16)}–${String(d.sunset?.[i] ?? '').slice(11, 16)}`;
      });
      out.push(`\nDaily: day | weather | high/low | rain chance | precipitation | max wind | sunrise–sunset\n${rows.join('\n')}`);
    }

    const h = f.hourly;
    if (hourly && h?.time?.length) {
      const idx = h.time.map((_, i) => i).filter((i) => !date || String(h.time[i]).startsWith(date));
      if (!idx.length) {
        out.push(`\nNo hourly forecast for ${date}: it must be within the next 16 days (local dates ${String(h.time[0]).slice(0, 10)} to ${String(h.time[h.time.length - 1]).slice(0, 10)}).`);
      } else {
        const rows = idx.map((i) => {
          const t = String(h.time[i]);
          return `${date ? '' : `${weekday(t.slice(0, 10))} `}${t.slice(11, 16)} | ${wmo(h.weather_code?.[i] as number)} | ${num(h.temperature_2m?.[i])}${T} (feels ${num(
            h.apparent_temperature?.[i]
          )}) | ${num(h.precipitation_probability?.[i])}% | ${num(h.precipitation?.[i], pd)} ${P} | ${num(h.wind_speed_10m?.[i])} ${W}`;
        });
        out.push(`\nHourly${date ? ` on ${weekday(date)} ${date}` : ''}: time | weather | temp | rain chance | precipitation | wind\n${rows.join('\n')}`);
      }
    }
    return { output: clip(out.join('\n')) };
  },
};

export const MEDIA_TOOLS: Tool[] = [
  dropboxSearch,
  dropboxDownload,
  dropboxUpload,
  dropboxManage,
  spotifySearch,
  spotifyLibrary,
  spotifyPlaylist,
  spotifyPlayback,
  weatherForecast,
];

// ---- Labels ----------------------------------------------------------------------------------

const lastPart = (s: string) => short(baseName(s.split('?')[0]) || s, 40);

export const MEDIA_LABELS: ToolLabels = {
  dropbox_search: (i) =>
    field(i, 'cursor') ? 'More Dropbox results' : field(i, 'query') ? `Search Dropbox “${short(field(i, 'query'))}”` : `List Dropbox ${field(i, 'folder') || '/'}`,
  dropbox_download: (i) => `Download ${isSharedLink(field(i, 'file')) ? 'a shared file' : lastPart(field(i, 'file')) || 'a file'} from Dropbox`,
  dropbox_upload: (i) => `Upload ${lastPart(field(i, 'path')) || 'a file'} to Dropbox`,
  dropbox_manage: (i) => {
    const item = lastPart(field(i, 'path')) || 'an item';
    return (
      {
        create_folder: `Create Dropbox folder ${short(field(i, 'path'), 40)}`,
        move: `Move ${item} in Dropbox`,
        copy: `Copy ${item} in Dropbox`,
        delete: `Delete ${item} from Dropbox`,
        share_link: `Share link to ${item}`,
      }[field(i, 'action')] ?? 'Update Dropbox'
    );
  },
  spotify_search: (i) => `Search Spotify “${short(field(i, 'query'))}”`,
  spotify_library: (i) =>
    ({
      top_tracks: 'Your top Spotify tracks',
      top_artists: 'Your top Spotify artists',
      recent: 'Recently played on Spotify',
      saved: 'Your liked songs',
      playlists: 'Your Spotify playlists',
      playlist: 'Read a Spotify playlist',
      now_playing: 'What’s playing on Spotify',
      devices: 'List Spotify devices',
    })[field(i, 'what')] ?? 'Look at Spotify',
  spotify_playlist: (i) =>
    ({
      create: `Create playlist “${short(field(i, 'name'), 40)}”`,
      add: 'Add tracks to a Spotify playlist',
      remove: 'Remove tracks from a Spotify playlist',
    })[field(i, 'action')] ?? 'Edit a Spotify playlist',
  spotify_playback: (i) => {
    const item = field(i, 'item');
    const named = item && !/^(spotify:|https?:)/i.test(item) ? ` “${short(item, 40)}”` : '';
    return (
      {
        play: item ? `Play${named || ' on Spotify'}` : 'Resume Spotify',
        pause: 'Pause Spotify',
        next: 'Skip to the next track',
        previous: 'Back to the previous track',
        queue: `Queue${named || ' a track'}`,
        volume: `Set Spotify volume to ${i.volume ?? '?'}%`,
        shuffle: `Turn shuffle ${i.state === true || i.state === 'true' ? 'on' : 'off'}`,
        transfer: `Play on ${short(field(i, 'device'), 30) || 'another device'}`,
      }[field(i, 'action')] ?? 'Control Spotify'
    );
  },
  weather_forecast: (i) => {
    const where = field(i, 'location') || (i.latitude != null && i.longitude != null ? `${i.latitude}, ${i.longitude}` : 'a place');
    return field(i, 'date') ? `Weather in ${short(where, 40)} on ${field(i, 'date')}` : `Weather in ${short(where, 40)}`;
  },
};
