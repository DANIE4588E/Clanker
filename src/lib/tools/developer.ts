import { fetch } from '@/lib/net';
import { PluginApiError, pluginFetch, pluginJson } from '../plugins/auth';
import { formatSize } from '../workspace';
import type { Tool } from './index';
import {
  clip,
  extOf,
  field,
  fromBase64,
  int,
  list,
  MAX_TRANSFER_BYTES,
  opt,
  readUpload,
  safeName,
  saveDownload,
  short,
  shortDate,
  str,
  strings,
  toBase64,
  type ToolLabels,
} from './pluginUtil';

/**
 * Tools for the GitHub, Linear and Figma plugins. They act on the user's real repositories,
 * issues and design files through each service's API; the plugin catalog decides which are offered.
 */

const GH = 'https://api.github.com';
const FIGMA = 'https://api.figma.com/v1';

const notFound = (e: unknown) => e instanceof PluginApiError && e.status === 404;

/** Lines numbered like read_file's, from `offset` (1-based), at most `limit` of them. */
function numbered(text: string, offset: number, limit: number) {
  const lines = text.split(/\r?\n/);
  const end = Math.min(lines.length, offset - 1 + limit);
  const width = String(end).length;
  const body = lines
    .slice(offset - 1, end)
    .map((l, i) => `${String(offset + i).padStart(width)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`)
    .join('\n');
  return { body, total: lines.length, end };
}

const BINARY_EXT = new Set(
  'png jpg jpeg gif webp bmp ico heic tiff psd pdf zip gz tgz 7z rar jar apk ipa dex so dll exe bin class o a woff woff2 ttf otf eot mp3 mp4 m4a wav ogg mov avi webm sqlite db docx xlsx pptx key'.split(' ')
);

/** Whether bytes look binary: a known binary extension, or a NUL byte near the start. */
const looksBinary = (name: string, bytes: Uint8Array) => BINARY_EXT.has(extOf(name)) || bytes.subarray(0, 8000).includes(0);

// ---- GitHub ----------------------------------------------------------------------------------

const gh = <T = any>(path: string, init: Parameters<typeof pluginJson>[2] = {}) => pluginJson<T>('github', `${GH}${path}`, init);

type RepoRef = { owner: string; repo: string; number?: number; ref?: string; path?: string };

/**
 * A repo from "owner/name", "owner/name#12" or a github.com link, with what else the link names:
 * an issue or PR number (/issues/12, /pull/12), or a ref and path (/blob/main/src/a.ts, /tree/dev).
 */
function repoOf(input: unknown, name = 'repo'): RepoRef {
  const s = str(input, name).trim();
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/([^?#]*))?/i);
  if (url) {
    const [, owner, rawRepo, rest = ''] = url;
    const repo = rawRepo.replace(/\.git$/, '');
    const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
    if ((parts[0] === 'issues' || parts[0] === 'pull' || parts[0] === 'pulls') && /^\d+$/.test(parts[1] ?? '')) {
      return { owner, repo, number: Number(parts[1]) };
    }
    if ((parts[0] === 'blob' || parts[0] === 'tree') && parts[1]) return { owner, repo, ref: parts[1], path: parts.slice(2).join('/') };
    return { owner, repo };
  }
  const plain = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(\d+))?$/);
  if (!plain) throw new Error(`"${s}" is not a GitHub repo. Use owner/name (like facebook/react) or a github.com link.`);
  return { owner: plain[1], repo: plain[2], ...(plain[3] ? { number: Number(plain[3]) } : {}) };
}

const repoPath = (r: RepoRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
const encodePath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const cleanPath = (p: string | undefined) => (p ?? '').replace(/^\/+|\/+$/g, '');

/** An issue or PR number from a number, "#12" or a link. */
function numberOf(input: unknown, fallback?: number): number {
  if (input == null || input === '') {
    if (fallback) return fallback;
    throw new Error('Missing required argument "number".');
  }
  const s = String(input).trim();
  const m = s.match(/(?:issues|pull)\/(\d+)/) ?? s.match(/^#?(\d+)$/);
  if (!m) throw new Error(`"${s}" is not an issue or pull request number.`);
  return Number(m[1]);
}

let ghLogin: string | undefined;
/** The signed-in user's login, for "me". */
async function myLogin(signal: AbortSignal) {
  ghLogin ??= (await gh<{ login: string }>('/user', { signal })).login;
  return ghLogin;
}

const people = async (values: unknown, signal: AbortSignal) =>
  Promise.all(strings(values).map(async (v) => (v.toLowerCase() === 'me' ? myLogin(signal) : v.replace(/^@/, ''))));

type GhUser = { login: string };
type GhLabel = { name: string } | string;
type GhIssue = {
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  html_url: string;
  body?: string | null;
  user?: GhUser | null;
  labels?: GhLabel[];
  assignees?: GhUser[];
  comments?: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  milestone?: { title: string } | null;
  pull_request?: { merged_at?: string | null };
  draft?: boolean;
  repository_url?: string;
};

const labelNames = (labels: GhLabel[] | undefined) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

function issueLine(i: GhIssue, withRepo = false) {
  const state = i.pull_request?.merged_at ? 'merged' : i.draft ? `${i.state}, draft` : i.state;
  const repo = withRepo && i.repository_url ? ` ${i.repository_url.split('/repos/')[1]}` : '';
  const bits = [
    i.user && `by @${i.user.login}`,
    labelNames(i.labels).length && `labels: ${labelNames(i.labels).join(', ')}`,
    i.assignees?.length && `assigned: ${i.assignees.map((a) => `@${a.login}`).join(', ')}`,
    i.comments && `${i.comments} comment${i.comments === 1 ? '' : 's'}`,
    `updated ${shortDate(i.updated_at)}`,
  ].filter(Boolean);
  return `#${i.number} ${i.title} [${state}]${repo} · ${bits.join(' · ')}\n   ${i.html_url}`;
}

const SEARCH_KINDS = ['repos', 'issues', 'prs', 'code'] as const;

const githubSearch: Tool = {
  name: 'github_search',
  description:
    'Search GitHub: repositories (default), issues, pull requests or code. The query takes GitHub search qualifiers ' +
    '(e.g. "language:ts stars:>100", "is:open label:bug author:me", "filename:package.json react"). Give repo to search inside one repository. ' +
    'Code search matches the default branch only. Returns names, numbers and links for github_read / github_issues.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...SEARCH_KINDS], description: 'What to search. Default repos.' },
      query: { type: 'string', description: 'Search words and GitHub qualifiers.' },
      repo: { type: 'string', description: 'owner/name to search within.' },
      count: { type: 'integer', description: 'Results per page, 1-50. Default 15.' },
      page: { type: 'integer', description: 'Page of results, from 1.' },
    },
    required: ['query'],
  },
  async run(input, { signal }) {
    const kind = (opt(input.kind) ?? 'repos') as (typeof SEARCH_KINDS)[number];
    if (!SEARCH_KINDS.includes(kind)) throw new Error(`Unknown kind "${input.kind}". Use one of: ${SEARCH_KINDS.join(', ')}.`);
    let q = str(input.query, 'query').trim();
    if (opt(input.repo)) {
      const r = repoOf(input.repo);
      q += ` repo:${r.owner}/${r.repo}`;
    }
    // The issues search requires is:issue or is:pull-request in the query.
    if (kind === 'issues' && !/\b(is|type):(issue|pr|pull-request)\b/i.test(q)) q += ' is:issue';
    if (kind === 'prs' && !/\b(is|type):(pr|pull-request)\b/i.test(q)) q += ' is:pr';
    q = q.replace(/\b(author|assignee|mentions|involves|user|owner|commenter|review-requested):me\b/gi, (_, k) => `${k}:@me`);
    const count = int(input.count, 15, 1, 50);
    const page = int(input.page, 1, 1, 100);
    const endpoint = { repos: 'repositories', issues: 'issues', prs: 'issues', code: 'code' }[kind];
    const params = new URLSearchParams({ q, per_page: String(count), page: String(page) });
    const data = await gh<{ total_count: number; incomplete_results?: boolean; items: any[] }>(`/search/${endpoint}?${params}`, {
      signal,
      // text-match adds the matching fragments to code results.
      ...(kind === 'code' ? { headers: { Accept: 'application/vnd.github.text-match+json' } } : {}),
    });
    const items = data.items ?? [];
    if (!items.length) return { output: `No ${kind === 'repos' ? 'repositories' : kind === 'prs' ? 'pull requests' : kind} found for: ${q}` };
    let lines: string[];
    if (kind === 'repos') {
      lines = items.map(
        (r) =>
          `${r.full_name} ★${r.stargazers_count}${r.language ? ` · ${r.language}` : ''}${r.archived ? ' · archived' : ''} – ${short(r.description ?? '', 160) || 'no description'}\n   ${r.html_url}`
      );
    } else if (kind === 'code') {
      lines = items.map((c) => {
        const frag = (c.text_matches?.[0]?.fragment ?? '').trim().replace(/\s*\n\s*/g, ' ⏎ ');
        return `${c.path} in ${c.repository?.full_name}\n   ${c.html_url}${frag ? `\n   … ${short(frag, 200)}` : ''}`;
      });
    } else lines = items.map((i: GhIssue) => issueLine(i, true));
    const shown = (page - 1) * count + items.length;
    const reachable = Math.min(data.total_count, 1000);
    const more = shown < reachable ? `\n\n[${data.total_count} results; pass page ${page + 1} for more.]` : '';
    return { output: clip(`${lines.map((l, i) => `${(page - 1) * count + i + 1}. ${l}`).join('\n')}${more}`) };
  },
};

type GhContent = {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  size: number;
  sha: string;
  html_url?: string;
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
};

async function repoOverview(r: RepoRef, ref: string | undefined, signal: AbortSignal) {
  const repo = await gh<any>(repoPath(r), { signal });
  const at = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const [readme, root] = await Promise.all([
    pluginFetch('github', `${GH}${repoPath(r)}/readme${at}`, { signal, headers: { Accept: 'application/vnd.github.raw+json' } })
      .then((res) => res.text())
      .catch((e) => (notFound(e) ? '' : Promise.reject(e))),
    gh<GhContent[]>(`${repoPath(r)}/contents${at}`, { signal }).catch(() => [] as GhContent[]),
  ]);
  const facts = [
    repo.private ? 'private' : 'public',
    repo.fork && 'fork',
    repo.archived && 'archived',
    repo.language,
    `★${repo.stargazers_count}`,
    `${repo.forks_count} forks`,
    `${repo.open_issues_count} open issues + PRs`,
    repo.license?.spdx_id,
    `default branch ${repo.default_branch}`,
    repo.pushed_at && `last push ${shortDate(repo.pushed_at)}`,
  ].filter(Boolean);
  const out = [
    `${repo.full_name} – ${repo.description ?? 'no description'}`,
    repo.html_url,
    facts.join(' · '),
    repo.homepage ? `Homepage: ${repo.homepage}` : '',
    repo.topics?.length ? `Topics: ${repo.topics.join(', ')}` : '',
    Array.isArray(root) && root.length
      ? `\nTop level${ref ? ` at ${ref}` : ''}: ${root.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).join('  ')}`
      : '',
    readme ? `\nREADME:\n${clip(readme, 6000)}` : '\nNo README.',
  ];
  return out.filter(Boolean).join('\n');
}

const githubRead: Tool = {
  name: 'github_read',
  description:
    'Read a GitHub repository. With no path, gives an overview: description, default branch, stars, open issues, topics, top-level files and the README. ' +
    'A folder path lists its entries; a file path returns text with line numbers (use offset/limit for long files). ' +
    'Binary files, or any file with save: true, are saved into the workspace (under github/) to open with read_file or scripts. ' +
    'repo can be a github.com link to a file or folder (…/blob/main/src/app.ts).',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name or a github.com link.' },
      path: { type: 'string', description: 'File or folder path in the repo. Empty for the overview.' },
      ref: { type: 'string', description: 'Branch, tag or commit SHA. Default the default branch.' },
      offset: { type: 'integer', description: 'First line to show (1-based) for text files.' },
      limit: { type: 'integer', description: 'How many lines to show, up to 5000. Default 2000.' },
      save: { type: 'boolean', description: 'Save the file into the workspace instead of showing it.' },
      save_as: { type: 'string', description: 'Workspace path to save the file to.' },
    },
    required: ['repo'],
  },
  async run(input, { signal, conversationId, workspace: ws }) {
    const r = repoOf(input.repo);
    const path = cleanPath(opt(input.path) ?? r.path);
    const ref = opt(input.ref) ?? r.ref;
    if (!path) return { output: clip(await repoOverview(r, ref, signal)) };

    const at = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const url = `${GH}${repoPath(r)}/contents/${encodePath(path)}${at}`;
    const data = await pluginJson<GhContent | GhContent[]>('github', url, { signal });
    const where = `${r.owner}/${r.repo}/${path}${ref ? ` @ ${ref}` : ''}`;

    if (Array.isArray(data)) {
      if (!data.length) return { output: `${where} is an empty folder.` };
      const sorted = [...data].sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
      const rows = sorted.map((e) =>
        e.type === 'dir' ? `${e.name}/` : e.type === 'submodule' ? `${e.name} (submodule)` : e.type === 'symlink' ? `${e.name} (symlink)` : `${e.name} (${formatSize(e.size)})`
      );
      return { output: clip(`${where}/ — ${data.length} entries\n${rows.join('\n')}`) };
    }
    if (data.type === 'submodule') return { output: `${where} is a submodule of ${data.submodule_git_url ?? 'another repository'}.` };
    if (data.type === 'symlink' && data.target) return { output: `${where} is a symlink to ${data.target}.` };
    if (data.size > MAX_TRANSFER_BYTES) throw new Error(`${where} is ${formatSize(data.size)}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);

    // Files over 1 MB come back without content; the raw media type returns them whole.
    let bytes: Uint8Array;
    if (data.encoding === 'base64' && data.content) bytes = fromBase64(data.content);
    else {
      const res = await pluginFetch('github', url, { signal, headers: { Accept: 'application/vnd.github.raw+json' } });
      bytes = new Uint8Array(await res.arrayBuffer());
    }

    if (input.save || opt(input.save_as) || looksBinary(data.name, bytes)) {
      const saved = await saveDownload({ ws, conversationId, bytes, name: data.name, dir: 'github', saveAs: opt(input.save_as) });
      const image = /^(png|jpe?g|gif|webp)$/.test(extOf(data.name)) ? ' Look at it with read_file.' : '';
      return { output: `Saved ${where} to ${saved.path} (${formatSize(saved.size)}).${image}`, files: [saved.path] };
    }

    const text = new TextDecoder().decode(bytes);
    const offset = int(input.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const { body, total, end } = numbered(text, offset, int(input.limit, 2000, 1, 5000));
    if (offset > total) throw new Error(`${where} has only ${total} lines.`);
    const more = end < total ? `\n\n[Lines ${offset}-${end} of ${total}; pass offset ${end + 1} for more.]` : '';
    return { output: clip(`${where} (${total} lines, ${formatSize(bytes.length)})\n${data.html_url ?? ''}\n\n${body}${more}`) };
  },
};

async function readIssue(r: RepoRef, n: number, input: any, signal: AbortSignal) {
  const base = `${repoPath(r)}`;
  const issue = await gh<GhIssue>(`${base}/issues/${n}`, { signal });
  const isPr = !!issue.pull_request;
  const page = int(input.page, 1, 1, 100);
  const [comments, pr, files, reviews] = await Promise.all([
    issue.comments ? gh<any[]>(`${base}/issues/${n}/comments?per_page=50&page=${page}`, { signal }) : Promise.resolve([]),
    isPr ? gh<any>(`${base}/pulls/${n}`, { signal }) : null,
    isPr ? gh<any[]>(`${base}/pulls/${n}/files?per_page=100`, { signal }) : null,
    isPr ? gh<any[]>(`${base}/pulls/${n}/reviews?per_page=100`, { signal }) : null,
  ]);

  const out: string[] = [];
  const state = pr?.merged ? 'merged' : `${issue.state}${issue.state_reason && issue.state === 'closed' ? ` (${issue.state_reason})` : ''}${pr?.draft ? ', draft' : ''}`;
  out.push(`${isPr ? 'PR' : 'Issue'} #${issue.number}: ${issue.title} [${state}]`, issue.html_url);
  out.push(
    [
      issue.user && `opened by @${issue.user.login} ${shortDate(issue.created_at)}`,
      issue.closed_at && `closed ${shortDate(issue.closed_at)}`,
      labelNames(issue.labels).length && `labels: ${labelNames(issue.labels).join(', ')}`,
      issue.assignees?.length && `assigned: ${issue.assignees.map((a) => `@${a.login}`).join(', ')}`,
      issue.milestone && `milestone: ${issue.milestone.title}`,
    ]
      .filter(Boolean)
      .join(' · ')
  );
  if (pr) {
    out.push(
      [
        `${pr.head?.label ?? pr.head?.ref} → ${pr.base?.ref}`,
        `${pr.commits} commit${pr.commits === 1 ? '' : 's'}`,
        `${pr.changed_files} files +${pr.additions} −${pr.deletions}`,
        !pr.merged && pr.state === 'open' && pr.mergeable_state && `mergeable: ${pr.mergeable_state}`,
        pr.merged_by && `merged by @${pr.merged_by.login} ${shortDate(pr.merged_at)}`,
        pr.requested_reviewers?.length && `review requested from ${pr.requested_reviewers.map((u: GhUser) => `@${u.login}`).join(', ')}`,
        pr.requested_teams?.length && `and teams ${pr.requested_teams.map((t: { slug: string }) => t.slug).join(', ')}`,
        pr.review_comments && `${pr.review_comments} review comments on code`,
      ]
        .filter(Boolean)
        .join(' · ')
    );
    // The latest review state from each reviewer.
    const latest = new Map<string, string>();
    for (const rv of reviews ?? []) if (rv.user && rv.state !== 'COMMENTED') latest.set(rv.user.login, rv.state);
    if (latest.size) out.push(`Reviews: ${[...latest].map(([u, s]) => `@${u} ${s.toLowerCase().replace(/_/g, ' ')}`).join(', ')}`);
  }
  out.push('', issue.body?.trim() ? clip(issue.body.trim(), 8000) : '(no description)');

  if (files?.length) {
    out.push('', `Files changed${pr.changed_files > files.length ? ` (first ${files.length} of ${pr.changed_files})` : ''}:`);
    for (const f of files) out.push(`  ${f.status} ${f.filename}${f.previous_filename ? ` (from ${f.previous_filename})` : ''} +${f.additions} −${f.deletions}`);
  }
  if (comments.length) {
    out.push('', `Comments${issue.comments! > 50 ? ` (page ${page}, 50 per page, ${issue.comments} in all)` : ''}:`);
    for (const c of comments) out.push(`— @${c.user?.login ?? 'ghost'}, ${shortDate(c.created_at)}:\n${clip((c.body ?? '').trim(), 3000)}`);
    if (page * 50 < issue.comments!) out.push(`[More comments: pass page ${page + 1}.]`);
  }
  if (isPr && input.diff) {
    const res = await pluginFetch('github', `${GH}${base}/pulls/${n}`, { signal, headers: { Accept: 'application/vnd.github.diff' } });
    out.push('', 'Diff:', clip(await res.text(), 20_000));
  }
  return clip(out.join('\n'));
}

const ISSUE_STATES = ['open', 'closed', 'all'];

const githubIssues: Tool = {
  name: 'github_issues',
  description:
    'List or read issues and pull requests in a GitHub repository. Without number, lists them (filter by state, labels, assignee; "me" is the user). ' +
    'With number, reads that issue or PR with its description and comments; PRs also show branches, reviews and files changed with +/- counts, ' +
    'and diff: true adds the diff. repo can be a link to the issue or PR.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name or a github.com link (an issue or PR link sets number).' },
      kind: { type: 'string', enum: ['issues', 'prs'], description: 'Issues (default) or pull requests, when listing.' },
      number: { type: 'integer', description: 'Issue or PR number to read.' },
      state: { type: 'string', enum: ISSUE_STATES, description: 'When listing. Default open.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Only items with all these labels.' },
      assignee: { type: 'string', description: 'Only items assigned to this login, "me", "none" or "*".' },
      diff: { type: 'boolean', description: 'With a PR number: include the diff (clipped).' },
      count: { type: 'integer', description: 'How many to list, 1-100. Default 20.' },
      page: { type: 'integer', description: 'Page of the list, or of comments when reading one.' },
    },
    required: ['repo'],
  },
  async run(input, { signal }) {
    const r = repoOf(input.repo);
    const n = input.number != null && input.number !== '' ? numberOf(input.number) : r.number;
    if (n) return { output: await readIssue(r, n, input, signal) };

    const prs = opt(input.kind) === 'prs' || opt(input.kind) === 'pulls';
    const state = opt(input.state) ?? 'open';
    if (!ISSUE_STATES.includes(state)) throw new Error(`state must be one of: ${ISSUE_STATES.join(', ')}.`);
    const count = int(input.count, 20, 1, 100);
    const page = int(input.page, 1, 1, 1000);
    const labels = strings(input.labels);
    let assignee = opt(input.assignee);
    if (assignee?.toLowerCase() === 'me') assignee = await myLogin(signal);
    assignee = assignee?.replace(/^@/, '');

    let items: GhIssue[];
    if (prs && !labels.length && !assignee) {
      // The pulls list shows draft status; the issues list can't.
      const params = new URLSearchParams({ state, per_page: String(count), page: String(page), sort: 'updated', direction: 'desc' });
      items = (await gh<any[]>(`${repoPath(r)}/pulls?${params}`, { signal })).map((p) => ({ ...p, pull_request: { merged_at: p.merged_at } }));
    } else {
      // The issues list also returns pull requests; keep the kind asked for.
      const params = new URLSearchParams({ state, per_page: String(count), page: String(page), sort: 'updated', direction: 'desc' });
      if (labels.length) params.set('labels', labels.join(','));
      if (assignee) params.set('assignee', assignee);
      const all = await gh<GhIssue[]>(`${repoPath(r)}/issues?${params}`, { signal });
      items = all.filter((i) => !!i.pull_request === prs);
      if (!items.length && all.length === count) {
        return { output: `No ${prs ? 'pull requests' : 'issues'} on page ${page} (it held only ${prs ? 'issues' : 'pull requests'}); pass page ${page + 1} for more.` };
      }
      const more = all.length === count ? `\n\n[Pass page ${page + 1} for more.]` : '';
      if (!items.length) return { output: `No ${state === 'all' ? '' : `${state} `}${prs ? 'pull requests' : 'issues'} in ${r.owner}/${r.repo} match.` };
      return { output: clip(items.map((i) => issueLine(i)).join('\n') + more) };
    }
    if (!items.length) return { output: `No ${state === 'all' ? '' : `${state} `}pull requests in ${r.owner}/${r.repo}.` };
    const more = items.length === count ? `\n\n[Pass page ${page + 1} for more.]` : '';
    return { output: clip(items.map((i) => issueLine(i)).join('\n') + more) };
  },
};

const WRITE_ACTIONS = ['create_issue', 'comment', 'close', 'reopen', 'label', 'assign', 'edit'];

const githubWrite: Tool = {
  name: 'github_write',
  description:
    'Change GitHub issues and pull requests: create_issue (title, body, labels, assignees), comment (body, markdown), close (optional reason completed/not_planned), ' +
    'reopen, label (adds labels), assign (adds assignees; "me" is the user) or edit (title and/or body). Works on PRs by number too. Returns the link.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: WRITE_ACTIONS },
      repo: { type: 'string', description: 'owner/name or a github.com link (an issue or PR link sets number).' },
      number: { type: 'integer', description: 'Issue or PR number (all actions except create_issue).' },
      title: { type: 'string' },
      body: { type: 'string', description: 'Markdown: the issue description or the comment.' },
      labels: { type: 'array', items: { type: 'string' } },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Logins, or "me".' },
      reason: { type: 'string', enum: ['completed', 'not_planned'], description: 'For close.' },
    },
    required: ['action', 'repo'],
  },
  async run(input, { signal }) {
    const action = str(input.action, 'action');
    if (!WRITE_ACTIONS.includes(action)) throw new Error(`Unknown action "${action}". Use one of: ${WRITE_ACTIONS.join(', ')}.`);
    const r = repoOf(input.repo);
    const base = repoPath(r);
    const name = `${r.owner}/${r.repo}`;

    if (action === 'create_issue') {
      const labels = strings(input.labels);
      const assignees = await people(input.assignees, signal);
      const issue = await gh<GhIssue>(`${base}/issues`, {
        method: 'POST',
        json: { title: str(input.title, 'title'), body: opt(input.body), ...(labels.length ? { labels } : {}), ...(assignees.length ? { assignees } : {}) },
        signal,
      });
      return { output: `Opened issue #${issue.number} “${issue.title}” in ${name}: ${issue.html_url}` };
    }

    const n = numberOf(input.number, r.number);
    switch (action) {
      case 'comment': {
        const c = await gh<{ html_url: string }>(`${base}/issues/${n}/comments`, { method: 'POST', json: { body: str(input.body, 'body') }, signal });
        return { output: `Commented on ${name}#${n}: ${c.html_url}` };
      }
      case 'close':
      case 'reopen': {
        const reason = opt(input.reason);
        const json = action === 'close' ? { state: 'closed', ...(reason ? { state_reason: reason } : {}) } : { state: 'open' };
        const i = await gh<GhIssue>(`${base}/issues/${n}`, { method: 'PATCH', json, signal });
        return { output: `${action === 'close' ? 'Closed' : 'Reopened'} ${name}#${n} “${i.title}”: ${i.html_url}` };
      }
      case 'label': {
        const labels = strings(input.labels);
        if (!labels.length) throw new Error('Give the labels to add.');
        const now = await gh<{ name: string }[]>(`${base}/issues/${n}/labels`, { method: 'POST', json: { labels }, signal });
        return { output: `Labels on ${name}#${n} are now: ${now.map((l) => l.name).join(', ')}. https://github.com/${name}/issues/${n}` };
      }
      case 'assign': {
        const assignees = await people(input.assignees, signal);
        if (!assignees.length) throw new Error('Give the assignees to add.');
        const i = await gh<GhIssue>(`${base}/issues/${n}/assignees`, { method: 'POST', json: { assignees }, signal });
        const got = (i.assignees ?? []).map((a) => a.login);
        const missed = assignees.filter((a) => !got.some((g) => g.toLowerCase() === a.toLowerCase()));
        // GitHub silently skips people who can't be assigned in the repo.
        const note = missed.length ? ` Not assigned (no access to the repo?): ${missed.join(', ')}.` : '';
        return { output: `Assignees on ${name}#${n}: ${got.map((a) => `@${a}`).join(', ') || 'none'}.${note} ${i.html_url}` };
      }
      case 'edit': {
        const json: Record<string, string> = {};
        if (opt(input.title)) json.title = input.title.trim();
        if (typeof input.body === 'string') json.body = input.body;
        if (!Object.keys(json).length) throw new Error('Give a new title and/or body to edit.');
        const i = await gh<GhIssue>(`${base}/issues/${n}`, { method: 'PATCH', json, signal });
        return { output: `Edited ${name}#${n} “${i.title}”: ${i.html_url}` };
      }
    }
    throw new Error(`Unknown action "${action}".`);
  },
};

const githubCommit: Tool = {
  name: 'github_commit',
  description:
    'Create or update one file in a GitHub repository as a commit. Give the text as content, or from_path to upload a workspace file (binary is fine). ' +
    'Commits to branch (default the default branch); with create_branch: true a missing branch is made from the default branch, ' +
    'and the result links to open a pull request.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name or a github.com link.' },
      path: { type: 'string', description: 'File path in the repo.' },
      content: { type: 'string', description: 'The whole new file text.' },
      from_path: { type: 'string', description: 'Workspace file to commit instead of content.' },
      message: { type: 'string', description: 'Commit message.' },
      branch: { type: 'string', description: 'Branch to commit to. Default the default branch.' },
      create_branch: { type: 'boolean', description: 'Create the branch from the default branch if it does not exist.' },
    },
    required: ['repo', 'path', 'message'],
  },
  async run(input, { signal, workspace: ws }) {
    const r = repoOf(input.repo);
    const path = cleanPath(str(input.path, 'path'));
    if (!path) throw new Error('Give the file path in the repo.');
    const message = str(input.message, 'message');
    let bytes: Uint8Array;
    if (opt(input.from_path)) bytes = (await readUpload(ws, input.from_path)).bytes;
    else if (typeof input.content === 'string') bytes = new TextEncoder().encode(input.content);
    else throw new Error('Give the file text as content, or a workspace file as from_path.');

    const base = repoPath(r);
    const repo = await gh<{ default_branch: string; html_url: string }>(base, { signal });
    const branch = opt(input.branch) ?? repo.default_branch;
    let created = false;
    if (branch !== repo.default_branch) {
      try {
        await gh(`${base}/git/ref/heads/${encodePath(branch)}`, { signal });
      } catch (e) {
        if (!notFound(e)) throw e;
        if (!input.create_branch) throw new Error(`There is no branch "${branch}" in ${r.owner}/${r.repo}. Pass create_branch: true to make it from ${repo.default_branch}.`);
        const head = await gh<{ object: { sha: string } }>(`${base}/git/ref/heads/${encodePath(repo.default_branch)}`, { signal });
        await gh(`${base}/git/refs`, { method: 'POST', json: { ref: `refs/heads/${branch}`, sha: head.object.sha }, signal });
        created = true;
      }
    }

    // Updating a file needs the SHA of the version it replaces.
    let sha: string | undefined;
    try {
      const existing = await gh<GhContent | GhContent[]>(`${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, { signal });
      if (Array.isArray(existing) || existing.type === 'dir') throw new Error(`"${path}" is a folder in ${r.owner}/${r.repo}.`);
      sha = existing.sha;
    } catch (e) {
      if (!notFound(e)) throw e;
    }

    const res = await gh<{ content: { html_url: string }; commit: { sha: string; html_url: string } }>(`${base}/contents/${encodePath(path)}`, {
      method: 'PUT',
      json: { message, content: toBase64(bytes), branch, ...(sha ? { sha } : {}) },
      signal,
    });
    const lines = [
      `${sha ? 'Updated' : 'Created'} ${path} on ${branch}${created ? ` (new branch from ${repo.default_branch})` : ''} in commit ${res.commit.sha.slice(0, 7)}.`,
      `Commit: ${res.commit.html_url}`,
      `File: ${res.content.html_url}`,
    ];
    if (branch !== repo.default_branch) lines.push(`Open a pull request: ${repo.html_url}/compare/${repo.default_branch}...${encodePath(branch)}?expand=1`);
    return { output: lines.join('\n') };
  },
};

// ---- Figma -----------------------------------------------------------------------------------

const figma = <T = any>(path: string, signal: AbortSignal, init: Parameters<typeof pluginJson>[2] = {}) =>
  pluginJson<T>('figma', `${FIGMA}${path}`, { ...init, signal });

/** A file key, and a node ID when the link has one (node-id=1-2 → "1:2"). Branch links give the branch's key. */
function figmaOf(input: unknown): { key: string; node?: string } {
  const s = str(input, 'file').trim();
  const m = s.match(/figma\.com\/(?:file|design|proto|board|slides|deck|make|buzz|site)\/([A-Za-z0-9]+)(?:\/[^/?#]*)?(?:\/branch\/([A-Za-z0-9]+))?/i);
  if (m) {
    const branch = s.match(/\/branch\/([A-Za-z0-9]+)/)?.[1];
    const nodeParam = s.match(/[?&]node-id=([^&#]+)/)?.[1];
    return { key: branch ?? m[1], ...(nodeParam ? { node: nodeIdOf(decodeURIComponent(nodeParam)) } : {}) };
  }
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return { key: s };
  throw new Error(`"${s}" is not a Figma file key or link.`);
}

/** Node IDs use ":" in the API and "-" in links. */
const nodeIdOf = (id: string) => id.trim().replace(/-/g, ':');

type FNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  characters?: string;
  fills?: { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; opacity?: number }[];
  strokes?: { type: string; color?: { r: number; g: number; b: number; a: number } }[];
  strokeWeight?: number;
  cornerRadius?: number;
  layoutMode?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  opacity?: number;
  style?: { fontFamily?: string; fontWeight?: number; fontSize?: number; lineHeightPx?: number; letterSpacing?: number; textAlignHorizontal?: string };
  effects?: { type: string; visible?: boolean }[];
  componentId?: string;
};

const hex = (c: { r: number; g: number; b: number; a: number }, opacity = 1) => {
  const h = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  const a = c.a * opacity;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 1 ? h(a) : ''}`;
};

const paints = (list: FNode['fills']) =>
  (list ?? [])
    .filter((p) => p.visible !== false)
    .map((p) => (p.type === 'SOLID' && p.color ? hex(p.color, p.opacity ?? 1) : p.type.toLowerCase().replace(/_/g, ' ')))
    .join(', ');

const size = (n: FNode) => (n.absoluteBoundingBox ? `${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : '');

/** One line describing a node, with the style details useful for writing UI code. */
function nodeLine(n: FNode) {
  const bits: string[] = [`${n.type} “${n.name}” ${n.id}`];
  if (size(n)) bits.push(size(n));
  if (n.visible === false) bits.push('hidden');
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((p) => p ?? 0);
    bits.push(`auto-layout ${n.layoutMode.toLowerCase()} gap ${n.itemSpacing ?? 0} padding ${pad.join(' ')}`);
  }
  const fill = paints(n.fills);
  if (fill) bits.push(`fill ${fill}`);
  const stroke = paints(n.strokes);
  if (stroke) bits.push(`stroke ${stroke}${n.strokeWeight ? ` ${n.strokeWeight}px` : ''}`);
  if (n.cornerRadius) bits.push(`radius ${n.cornerRadius}`);
  if (n.opacity != null && n.opacity < 1) bits.push(`opacity ${Math.round(n.opacity * 100) / 100}`);
  const fx = (n.effects ?? []).filter((e) => e.visible !== false).map((e) => e.type.toLowerCase().replace(/_/g, ' '));
  if (fx.length) bits.push(fx.join(', '));
  if (n.style?.fontFamily) {
    const s = n.style;
    bits.push(`${s.fontFamily} ${s.fontWeight ?? ''} ${s.fontSize ?? ''}px${s.lineHeightPx ? `/${Math.round(s.lineHeightPx)}px` : ''}`.replace(/\s+/g, ' '));
  }
  if (n.characters) bits.push(`text “${short(n.characters.replace(/\s+/g, ' '), 200)}”`);
  return bits.join(' · ');
}

function outline(n: FNode, depth: number, maxDepth: number, out: string[]) {
  if (out.length > 1500) return;
  out.push(`${'  '.repeat(depth)}${nodeLine(n)}`);
  if (!n.children?.length) return;
  if (depth >= maxDepth) {
    out.push(`${'  '.repeat(depth + 1)}(${n.children.length} children; read node ${n.id} for more)`);
    return;
  }
  for (const c of n.children) outline(c, depth + 1, maxDepth, out);
}

type FFile = {
  name: string;
  lastModified: string;
  version?: string;
  document: FNode;
  components?: Record<string, { name: string; description?: string; componentSetId?: string }>;
  componentSets?: Record<string, { name: string }>;
  styles?: Record<string, { name: string; styleType: string }>;
};

const fileLink = (key: string, node?: string) => `https://www.figma.com/design/${key}${node ? `?node-id=${encodeURIComponent(node.replace(/:/g, '-'))}` : ''}`;

const figmaRead: Tool = {
  name: 'figma_read',
  description:
    'Read a Figma file. Without node, lists pages and their top-level frames with node IDs and sizes, plus components and styles. ' +
    'With node (or a link with node-id), outlines that node’s layers to depth levels: types, names, IDs, sizes, auto-layout, fills, strokes, radius, fonts and text. ' +
    'Export frames as images with figma_export to see them.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File link or key.' },
      node: { type: 'string', description: 'Node ID (1:2) to outline. A link’s node-id is used when this is empty.' },
      depth: { type: 'integer', description: 'Levels of layers under the node, 1-8. Default 4.' },
    },
    required: ['file'],
  },
  async run(input, { signal }) {
    const f = figmaOf(input.file);
    const node = opt(input.node) ? nodeIdOf(input.node) : f.node;
    if (node) {
      const depth = int(input.depth, 4, 1, 8);
      const data = await figma<{ name: string; nodes: Record<string, { document: FNode } | null> }>(
        `/files/${f.key}/nodes?ids=${encodeURIComponent(node)}&depth=${depth}`,
        signal
      );
      const doc = data.nodes[node]?.document;
      if (!doc) throw new Error(`No node ${node} in “${data.name}”. List the file’s frames with figma_read without node.`);
      const out: string[] = [];
      outline(doc, 0, depth, out);
      return { output: clip(`“${data.name}” › ${doc.name} — ${fileLink(f.key, node)}\n${out.join('\n')}`) };
    }

    const file = await figma<FFile>(`/files/${f.key}?depth=2`, signal);
    const out = [`“${file.name}” — modified ${shortDate(file.lastModified)} — ${fileLink(f.key)}`];
    for (const page of file.document.children ?? []) {
      const frames = page.children ?? [];
      out.push('', `Page “${page.name}” ${page.id} (${frames.length} top-level layers)`);
      for (const fr of frames.slice(0, 60)) out.push(`  ${fr.type} “${fr.name}” ${fr.id}${size(fr) ? ` ${size(fr)}` : ''}`);
      if (frames.length > 60) out.push(`  … ${frames.length - 60} more`);
    }
    const sets = Object.entries(file.componentSets ?? {});
    const comps = Object.entries(file.components ?? {}).filter(([, c]) => !c.componentSetId);
    if (sets.length || comps.length) {
      out.push('', `Components (${sets.length + comps.length}):`);
      for (const [id, s] of sets.slice(0, 80)) out.push(`  ${s.name} ${id} (variants)`);
      for (const [id, c] of comps.slice(0, 120)) out.push(`  ${c.name} ${id}${c.description ? ` – ${short(c.description, 80)}` : ''}`);
    }
    const styles = Object.values(file.styles ?? {});
    if (styles.length) {
      out.push('', 'Styles:');
      const byType = new Map<string, string[]>();
      for (const s of styles) byType.set(s.styleType, [...(byType.get(s.styleType) ?? []), s.name]);
      for (const [type, names] of byType) out.push(`  ${type.toLowerCase()}: ${names.slice(0, 80).join(', ')}`);
    }
    return { output: clip(out.join('\n')) };
  },
};

const EXPORT_FORMATS = ['png', 'jpg', 'svg', 'pdf'];
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'GROUP', 'INSTANCE']);

const figmaExport: Tool = {
  name: 'figma_export',
  description:
    'Export Figma frames or other nodes as images into the workspace (under figma/). nodes are IDs from figma_read (default: the top-level frames ' +
    'of the first page, at most 10). Look at the PNG or JPG files with read_file.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File link or key (a link’s node-id is exported when nodes is empty).' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Node IDs to export, up to 10.' },
      format: { type: 'string', enum: EXPORT_FORMATS, description: 'Default png.' },
      scale: { type: 'number', description: 'For png/jpg, 0.01-4. Default 2.' },
    },
    required: ['file'],
  },
  async run(input, { signal, conversationId, workspace: ws }) {
    const f = figmaOf(input.file);
    const format = (opt(input.format) ?? 'png').toLowerCase().replace('jpeg', 'jpg');
    if (!EXPORT_FORMATS.includes(format)) throw new Error(`format must be one of: ${EXPORT_FORMATS.join(', ')}.`);
    let ids = strings(input.nodes).map(nodeIdOf);
    if (!ids.length && f.node) ids = [f.node];
    const names = new Map<string, string>();
    if (!ids.length) {
      const file = await figma<FFile>(`/files/${f.key}?depth=2`, signal);
      const first = file.document.children?.[0];
      const frames = (first?.children ?? []).filter((n) => FRAME_TYPES.has(n.type) && n.visible !== false).slice(0, 10);
      if (!frames.length) throw new Error(`The first page of “${file.name}” has no frames. Pass nodes from figma_read.`);
      for (const fr of frames) names.set(fr.id, fr.name);
      ids = frames.map((fr) => fr.id);
    } else {
      if (ids.length > 10) throw new Error('Export at most 10 nodes at a time.');
      const data = await figma<{ nodes: Record<string, { document: FNode } | null> }>(`/files/${f.key}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=1`, signal);
      for (const id of ids) {
        const doc = data.nodes[id]?.document;
        if (!doc) throw new Error(`No node ${id} in this file.`);
        names.set(id, doc.name);
      }
    }

    const params = new URLSearchParams({ ids: ids.join(','), format });
    if (format === 'png' || format === 'jpg') {
      const scale = typeof input.scale === 'number' ? input.scale : parseFloat(String(input.scale ?? '2'));
      params.set('scale', String(Number.isFinite(scale) ? Math.min(4, Math.max(0.01, scale)) : 2));
    }
    const res = await figma<{ err?: string | null; images: Record<string, string | null> }>(`/images/${f.key}?${params}`, signal);
    if (res.err) throw new Error(`Figma could not render: ${res.err}`);

    const files: string[] = [];
    const lines: string[] = [];
    for (const id of ids) {
      const url = res.images?.[id];
      const name = names.get(id) ?? id;
      if (!url) {
        lines.push(`${name} (${id}): Figma could not render it (empty or invisible).`);
        continue;
      }
      // Rendered images are on Figma's storage, fetched without the Figma token.
      const img = await fetch(url, { signal });
      if (!img.ok) {
        lines.push(`${name} (${id}): download failed (${img.status}).`);
        continue;
      }
      const bytes = new Uint8Array(await img.arrayBuffer());
      const saved = await saveDownload({ ws, conversationId, bytes, name: `${safeName(name)}.${format}`, dir: 'figma' });
      files.push(saved.path);
      lines.push(`${name} (${id}) → ${saved.path} (${formatSize(saved.size)})`);
    }
    const look = files.length && (format === 'png' || format === 'jpg') ? '\nLook at them with read_file.' : '';
    return { output: `Exported ${files.length} of ${ids.length} as ${format.toUpperCase()}:\n${lines.join('\n')}${look}`, files, isError: !files.length };
  },
};

type FComment = {
  id: string;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  parent_id?: string;
  user?: { handle: string };
  client_meta?: { node_id?: string } | null;
};

const figmaComment: Tool = {
  name: 'figma_comment',
  description:
    'Figma file comments: list (default; threads with author, date, resolved, the node they are on), add a new comment (message, optionally ' +
    'pinned to node), or reply to a comment (comment_id of the thread’s first comment).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'reply'] },
      file: { type: 'string', description: 'File link or key.' },
      message: { type: 'string', description: 'For add and reply.' },
      node: { type: 'string', description: 'For add: node ID to pin the comment to (a link’s node-id is used when empty).' },
      comment_id: { type: 'string', description: 'For reply: the thread’s first comment ID.' },
      unresolved_only: { type: 'boolean', description: 'For list: hide resolved threads.' },
    },
    required: ['file'],
  },
  async run(input, { signal }) {
    const f = figmaOf(input.file);
    const action = opt(input.action) ?? 'list';
    const path = `/files/${f.key}/comments`;

    if (action === 'add' || action === 'reply') {
      const message = str(input.message, 'message');
      let json: Record<string, unknown>;
      if (action === 'reply') json = { message, comment_id: str(input.comment_id, 'comment_id').trim() };
      else {
        const node = opt(input.node) ? nodeIdOf(input.node) : f.node;
        // Without client_meta Figma places the comment on the canvas origin.
        json = { message, ...(node ? { client_meta: { node_id: node, node_offset: { x: 0, y: 0 } } } : {}) };
      }
      const c = await figma<FComment>(path, signal, { method: 'POST', json });
      return { output: `${action === 'reply' ? 'Replied' : 'Commented'} (comment ${c.id}) on ${fileLink(f.key, f.node)}` };
    }
    if (action !== 'list') throw new Error('action must be list, add or reply.');

    const { comments } = await figma<{ comments: FComment[] }>(path, signal);
    const roots = comments.filter((c) => !c.parent_id && !(input.unresolved_only && c.resolved_at));
    if (!roots.length) return { output: input.unresolved_only ? 'No unresolved comments.' : 'No comments on this file.' };
    roots.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const out = roots.map((c) => {
      const replies = comments.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const head = `[${c.id}] ${c.user?.handle ?? 'someone'}, ${shortDate(c.created_at)}${c.resolved_at ? ' · resolved' : ''}${c.client_meta?.node_id ? ` · on node ${c.client_meta.node_id}` : ''}`;
      return [head, `  ${c.message.trim()}`, ...replies.map((r) => `  ↳ ${r.user?.handle ?? 'someone'}, ${shortDate(r.created_at)}: ${r.message.trim()}`)].join('\n');
    });
    return { output: clip(`${roots.length} thread${roots.length === 1 ? '' : 's'}:\n${out.join('\n')}`) };
  },
};

/** Tools for the GitHub, Linear and Figma plugins. */
export const DEVELOPER_TOOLS: Tool[] = [
  githubSearch,
  githubRead,
  githubIssues,
  githubWrite,
  githubCommit,
  figmaRead,
  figmaExport,
  figmaComment,
];

const repoLabel = (i: Record<string, unknown>) => {
  try {
    const r = repoOf(i.repo);
    return `${r.owner}/${r.repo}`;
  } catch {
    return field(i, 'repo');
  }
};

const numLabel = (i: Record<string, unknown>) => {
  const n = i.number ?? (() => {
    try {
      return repoOf(i.repo).number;
    } catch {
      return undefined;
    }
  })();
  return n != null && n !== '' ? `#${n}` : 'an issue';
};

export const DEVELOPER_LABELS: ToolLabels = {
  github_search: (i) => {
    const kind = field(i, 'kind') || 'repos';
    const what = { repos: 'repos', issues: 'issues', prs: 'pull requests', code: 'code' }[kind] ?? kind;
    return `Search GitHub ${what} “${short(field(i, 'query'))}”`;
  },
  github_read: (i) => {
    const path = field(i, 'path');
    return `Read ${repoLabel(i)}${path ? `/${path.replace(/^\/+/, '')}` : ''}`;
  },
  github_issues: (i) => {
    const n = i.number != null && i.number !== '' ? `#${i.number}` : '';
    if (n) return `Read ${repoLabel(i)}${n}`;
    return `List ${field(i, 'kind') === 'prs' ? 'pull requests' : 'issues'} in ${repoLabel(i)}`;
  },
  github_write: (i) =>
    ({
      create_issue: `Open issue “${short(field(i, 'title'))}”`,
      comment: `Comment on ${numLabel(i)}`,
      close: `Close ${numLabel(i)}`,
      reopen: `Reopen ${numLabel(i)}`,
      label: `Label ${numLabel(i)}`,
      assign: `Assign ${numLabel(i)}`,
      edit: `Edit ${numLabel(i)}`,
    })[field(i, 'action')] ?? 'Update GitHub',
  github_commit: (i) => `Commit ${field(i, 'path')} to ${repoLabel(i)}${field(i, 'branch') ? ` (${field(i, 'branch')})` : ''}`,
  figma_read: (i) => (field(i, 'node') || /node-id=/.test(field(i, 'file')) ? 'Read Figma layers' : 'Read a Figma file'),
  figma_export: (i) => {
    const n = list(i.nodes).length;
    return n ? `Export ${n} Figma ${n === 1 ? 'frame' : 'frames'}` : 'Export Figma frames';
  },
  figma_comment: (i) => ({ add: 'Comment on Figma', reply: 'Reply to a Figma comment' })[field(i, 'action')] ?? 'Read Figma comments',
};
