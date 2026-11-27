import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { strFromU8 } from 'fflate';
import { fetch } from '../net';
import { unzipBounded, ZipLimitError } from '../zip';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, parseSkillMd, saveSkill, SKILL_FILE, SkillError, slugify } from './index';

/**
 * Finding and installing skills from elsewhere: a GitHub repository or folder (one skill or a
 * collection, like anthropics/skills), a link to a .zip, .skill or SKILL.md, or a file on the phone.
 */

/** A skill found in a source, ready to install. */
export type SkillPackage = {
  name: string;
  description: string;
  /** Where it was found, shown to the user and kept on the skill. */
  origin: string;
  /** Its SKILL.md and other files, read when it is installed. */
  load: () => Promise<{ skillMd: string; files: Record<string, Uint8Array> }>;
};

const MAX_CANDIDATES = 80;
const isSkillMd = (path: string) => /(^|\/)skill\.md$/i.test(path);
const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');

function describe(skillMd: string, dir: string, origin: string, load: SkillPackage['load']): SkillPackage {
  const parsed = parseSkillMd(skillMd);
  const name = slugify(parsed.name || dir.split('/').pop() || '');
  if (!name) throw new SkillError(`The skill at ${origin} has no name.`);
  return { name, description: parsed.description, origin, load };
}

async function get(url: string, accept?: string) {
  const res = await fetch(url, { headers: accept ? { Accept: accept } : undefined });
  if (!res.ok) {
    const limited = res.status === 403 && url.includes('api.github.com');
    throw new SkillError(limited ? 'GitHub is limiting requests from this network. Try again in a while.' : `${url} answered ${res.status}.`);
  }
  return res;
}

// Largest archive or SKILL.md downloaded from a link (the same limit as a file picked on the phone).
const MAX_DOWNLOAD_BYTES = MAX_SKILL_BYTES * 2;

/** A response's body, refusing to read past `maxBytes` (a server can lie about, or omit, its length). */
async function readCapped(res: Awaited<ReturnType<typeof fetch>>, maxBytes = MAX_DOWNLOAD_BYTES): Promise<Uint8Array> {
  const tooLarge = () => new SkillError(`That download is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, too large for a skill.`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw tooLarge();
    return bytes;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

// ---- GitHub --------------------------------------------------------------------------------

type GitHubRef = { owner: string; repo: string; ref?: string; path: string };

/** owner/repo[/path], or a github.com link to a repository, folder or file. */
function parseGitHub(input: string): GitHubRef | null {
  const text = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const url = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/([^?#]*))?)?/i);
  if (url) return { owner: url[1], repo: url[2], ref: url[3], path: decodeURIComponent(url[4] ?? '') };
  const raw = text.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/i);
  if (raw) return { owner: raw[1], repo: raw[2], ref: raw[3], path: decodeURIComponent(raw[4]) };
  const short = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^/]+)*)$/);
  if (short && !text.includes(':')) return { owner: short[1], repo: short[2], path: short[3].replace(/^\//, '') };
  return null;
}

async function fromGitHub({ owner, repo, ref, path }: GitHubRef): Promise<SkillPackage[]> {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const branch = ref ?? ((await (await get(api, 'application/vnd.github+json')).json()) as { default_branch: string }).default_branch;
  const tree = (await (await get(`${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`, 'application/vnd.github+json')).json()) as {
    tree: { path: string; type: string; size?: number }[];
  };
  // A link to a SKILL.md means its folder.
  const root = isSkillMd(path) ? dirOf(path) : path;
  const inRoot = (p: string) => !root || p === root || p.startsWith(`${root}/`);
  const blobs = tree.tree.filter((e) => e.type === 'blob' && inRoot(e.path));
  const dirs = blobs.filter((b) => isSkillMd(b.path)).map((b) => dirOf(b.path));
  if (!dirs.length) throw new SkillError(`No ${SKILL_FILE} found in ${owner}/${repo}${root ? `/${root}` : ''}.`);
  const raw = (p: string) =>
    `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${p.split('/').map(encodeURIComponent).join('/')}`;

  const found = await Promise.all(
    dirs.slice(0, MAX_CANDIDATES).map(async (dir) => {
      const mdPath = blobs.find((b) => isSkillMd(b.path) && dirOf(b.path) === dir)!.path;
      try {
        const skillMd = await (await get(raw(mdPath))).text();
        // A skill's files are everything under its folder that isn't inside a nested skill.
        const nested = dirs.filter((d) => d !== dir && (!dir || d.startsWith(`${dir}/`)));
        const own = blobs.filter(
          (b) => b.path !== mdPath && (!dir || b.path.startsWith(`${dir}/`)) && !nested.some((d) => b.path.startsWith(`${d}/`))
        );
        const origin = `https://github.com/${owner}/${repo}/tree/${branch}${dir ? `/${dir}` : ''}`;
        return describe(skillMd, dir || repo, origin, async () => {
          if (own.length > MAX_SKILL_FILES) throw new SkillError(`This skill has more than ${MAX_SKILL_FILES} files.`);
          const size = own.reduce((n, b) => n + (b.size ?? 0), 0);
          if (size > MAX_SKILL_BYTES) throw new SkillError(`This skill is larger than ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
          const files: Record<string, Uint8Array> = {};
          await Promise.all(
            own.map(async (b) => {
              files[dir ? b.path.slice(dir.length + 1) : b.path] = new Uint8Array(await (await get(raw(b.path))).arrayBuffer());
            })
          );
          return { skillMd, files };
        });
      } catch {
        return null;
      }
    })
  );
  const packages = found.filter((p): p is SkillPackage => !!p);
  if (!packages.length) throw new SkillError(`Couldn't read the skills in ${owner}/${repo}.`);
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- archives and single files -------------------------------------------------------------

/** The skills in a .zip or .skill archive. */
export function fromZip(bytes: Uint8Array, origin: string, nameHint = ''): SkillPackage[] {
  let entries: Record<string, Uint8Array>;
  try {
    // Capped, so a small archive that expands to gigabytes is refused instead of exhausting memory.
    entries = unzipBounded(bytes, { filter: (f) => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(f.name) });
  } catch (e) {
    if (e instanceof ZipLimitError) throw new SkillError(`${e.message.replace(/\.$/, '')}, too large for a skill.`);
    throw new SkillError("That file isn't a zip archive.");
  }
  const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(p));
  const dirs = paths.filter(isSkillMd).map(dirOf);
  if (!dirs.length) throw new SkillError(`No ${SKILL_FILE} found in the archive.`);
  return dirs.slice(0, MAX_CANDIDATES).map((dir) => {
    const mdPath = paths.find((p) => isSkillMd(p) && dirOf(p) === dir)!;
    const skillMd = strFromU8(entries[mdPath]);
    const nested = dirs.filter((d) => d !== dir && (!dir || d.startsWith(`${dir}/`)));
    const files: Record<string, Uint8Array> = {};
    for (const p of paths) {
      if (p === mdPath || (dir && !p.startsWith(`${dir}/`)) || nested.some((d) => p.startsWith(`${d}/`))) continue;
      files[dir ? p.slice(dir.length + 1) : p] = entries[p];
    }
    return describe(skillMd, dir || nameHint, origin, async () => ({ skillMd, files }));
  });
}

function fromSkillMd(skillMd: string, origin: string, nameHint = ''): SkillPackage[] {
  const parsed = parseSkillMd(skillMd);
  if (!parsed.hasFrontmatter) throw new SkillError(`That isn't a ${SKILL_FILE}: it has no frontmatter with a name and description.`);
  return [describe(skillMd, nameHint, origin, async () => ({ skillMd, files: {} }))];
}

/** The skills at a GitHub location or a link. */
export async function findSkills(input: string): Promise<SkillPackage[]> {
  const text = input.trim();
  if (!text) throw new SkillError('Enter a GitHub repository or a link.');
  const gh = parseGitHub(text);
  // A raw file link to a SKILL.md is fetched as it is; anything else on GitHub goes through its tree.
  if (gh && !(text.includes('raw.githubusercontent.com') && isSkillMd(gh.path))) return fromGitHub(gh);
  const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  const res = await get(url);
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  const type = res.headers.get('content-type') ?? '';
  if (/\.(zip|skill)$/i.test(name) || /zip|octet-stream/.test(type)) {
    return fromZip(await readCapped(res), url, name.replace(/\.(zip|skill)$/i, ''));
  }
  return fromSkillMd(strFromU8(await readCapped(res)), url, dirOf(new URL(url).pathname).split('/').pop());
}

/** The skills in a file the user picks: a .zip or .skill archive, or a SKILL.md. Empty when cancelled. */
export async function pickSkillFile(): Promise<SkillPackage[]> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false });
  if (result.canceled) return [];
  const asset = result.assets[0];
  const name = asset.name || 'skill';
  if (asset.size && asset.size > MAX_DOWNLOAD_BYTES) throw new SkillError('That file is too large for a skill.');
  const file = new File(asset.uri);
  if (/\.(md|markdown|txt)$/i.test(name)) return fromSkillMd(await file.text(), name, name.replace(/\.[^.]+$/, ''));
  return fromZip(await file.bytes(), name, name.replace(/\.[^.]+$/, ''));
}

/** Installs a found skill, replacing one of the same name when `replace` is set. */
export async function installPackage(pkg: SkillPackage, replace = false) {
  const { skillMd, files } = await pkg.load();
  return saveSkill({ skillMd, files, name: pkg.name, source: 'installed', origin: pkg.origin, replace });
}
