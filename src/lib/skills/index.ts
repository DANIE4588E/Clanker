import { Directory, File, Paths } from 'expo-file-system';
import { useChats, type Conversation } from '@/store/chats';
import { useSettings } from '@/store/settings';
import { enabledSkills, useSkills, type Skill, type SkillRef } from '@/store/skills';

/**
 * Skills, in the format Claude Code, DeepSeek Harness and Hermes Agent share: a folder holding a
 * SKILL.md (YAML frontmatter with a name and description, then markdown instructions) and any
 * scripts, references or assets it needs. Models see each enabled skill's name and description in
 * the system prompt and load the rest with skill_view when a task calls for it.
 */

export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_SKILL_CHARS = 100_000;
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;
// Descriptions in the system prompt are cut to this, and the whole list to the total.
const LISTED_DESCRIPTION_CHARS = 400;
const LISTED_TOTAL_CHARS = 12_000;

export const SKILL_FILE = 'SKILL.md';

export class SkillError extends Error {}

// ---- SKILL.md ----------------------------------------------------------------------------

type Entry = { key: string; value: string; start: number; end: number };

function unquote(value: string) {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The top-level keys of a SKILL.md's frontmatter, with the lines each spans. Handles the YAML that
 * skills use in practice: plain, quoted and block (| and >) scalars; nested maps are skipped.
 */
function frontmatterEntries(lines: string[]): { entries: Entry[]; close: number } | null {
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (close < 0) return null;
  const entries: Entry[] = [];
  for (let i = 1; i < close; ) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < close && (/^\s/.test(lines[j]) || !lines[j].trim())) j++;
    const rest = lines.slice(i + 1, j);
    const raw = m[2].trim();
    let value: string;
    if (/^[|>][+-]?$/.test(raw)) {
      const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length), Infinity);
      const body = rest.map((l) => (l.trim() ? l.slice(indent === Infinity ? 0 : indent) : ''));
      value = raw.startsWith('|') ? body.join('\n').trim() : body.join(' ').replace(/\s+/g, ' ').trim();
    } else if (!raw) {
      // A nested map or list: not a value skills need.
      value = '';
    } else {
      value = unquote([raw, ...rest.map((l) => l.trim())].filter(Boolean).join(' '));
    }
    entries.push({ key: m[1], value, start: i, end: j });
    i = j;
  }
  return { entries, close };
}

/** A SKILL.md's name, description and the instructions after the frontmatter. */
export function parseSkillMd(text: string) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const parsed = frontmatterEntries(lines);
  if (!parsed) return { name: '', description: '', body: lines.join('\n').trim(), hasFrontmatter: false };
  const get = (key: string) => parsed.entries.find((e) => e.key === key)?.value ?? '';
  return {
    name: get('name'),
    description: get('description').replace(/\s+/g, ' ').trim(),
    body: lines.slice(parsed.close + 1).join('\n').trim(),
    hasFrontmatter: true,
  };
}

const yamlString = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** A new SKILL.md. */
export function buildSkillMd(name: string, description: string, body: string) {
  return `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${body.trim()}\n`;
}

/**
 * A SKILL.md with its name, description and/or body replaced, keeping the rest of its frontmatter
 * (license, metadata and so on) as it was.
 */
export function withSkillFields(text: string, fields: { name?: string; description?: string; body?: string }) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const parsed = frontmatterEntries(lines);
  const current = parseSkillMd(text);
  if (!parsed) {
    return buildSkillMd(fields.name ?? current.name, fields.description ?? current.description, fields.body ?? current.body);
  }
  const replace: Record<string, string> = {};
  if (fields.name != null) replace.name = `name: ${fields.name}`;
  if (fields.description != null) replace.description = `description: ${yamlString(fields.description)}`;
  const head: string[] = ['---'];
  let cursor = 1;
  for (const e of parsed.entries) {
    head.push(...lines.slice(cursor, e.start));
    if (replace[e.key] != null) {
      head.push(replace[e.key]);
      delete replace[e.key];
    } else head.push(...lines.slice(e.start, e.end));
    cursor = e.end;
  }
  head.push(...lines.slice(cursor, parsed.close));
  // Keys the frontmatter lacked go first, where readers expect them.
  head.splice(1, 0, ...Object.values(replace));
  head.push('---');
  const body = fields.body != null ? fields.body.trim() : lines.slice(parsed.close + 1).join('\n').trim();
  return `${head.join('\n')}\n\n${body}\n`;
}

// ---- names and paths -----------------------------------------------------------------------

/** A valid skill name made from anything: lowercase letters, digits and single hyphens. */
export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/, '');
}

export function checkName(name: string) {
  if (!name) throw new SkillError('A skill needs a name.');
  if (name.length > MAX_NAME_CHARS || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new SkillError(
      `"${name}" is not a valid skill name: use lowercase letters, digits and hyphens, at most ${MAX_NAME_CHARS} characters (e.g. "pdf-forms").`
    );
  }
  return name;
}

export function checkDescription(description: string) {
  const d = description.replace(/\s+/g, ' ').trim();
  if (!d) throw new SkillError('A skill needs a description saying what it does and when to use it.');
  if (d.length > MAX_DESCRIPTION_CHARS) {
    throw new SkillError(`A skill's description can be at most ${MAX_DESCRIPTION_CHARS} characters (this one is ${d.length}).`);
  }
  return d;
}

/** A path inside a skill's folder, relative and without "..". */
export function skillPath(input: string) {
  const parts: string[] = [];
  for (const seg of (input ?? '').trim().replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new SkillError(`"${input}" points outside the skill.`);
    parts.push(seg);
  }
  const path = parts.join('/');
  if (!path) throw new SkillError('Expected a file path inside the skill, e.g. "scripts/fill.py".');
  if (path.toLowerCase() === SKILL_FILE.toLowerCase()) {
    throw new SkillError(`${SKILL_FILE} is the skill itself; change it with patch or edit.`);
  }
  return path;
}

export const skillDir = (name: string) => new Directory(Paths.document, 'skills', name);
const fileIn = (name: string, path: string) => new File(skillDir(name), ...path.split('/'));

function walk(dir: Directory, prefix = ''): { path: string; size: number }[] {
  if (!dir.exists) return [];
  return dir.list().flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry instanceof Directory ? walk(entry, rel) : [{ path: rel, size: entry.size ?? 0 }];
  });
}

/** The files a skill folder holds besides its SKILL.md. */
export function listSkillFiles(name: string) {
  return walk(skillDir(name))
    .filter((f) => f.path !== SKILL_FILE)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function readSkillMd(name: string) {
  const file = new File(skillDir(name), SKILL_FILE);
  if (!file.exists) throw new SkillError(`Skill "${name}" has no ${SKILL_FILE}.`);
  return file.textSync();
}

export function skillFile(name: string, path: string) {
  return fileIn(name, skillPath(path));
}

// ---- saving --------------------------------------------------------------------------------

export type SkillFiles = Record<string, Uint8Array | string>;

const byteLength = (v: Uint8Array | string) => (typeof v === 'string' ? new TextEncoder().encode(v).length : v.length);

function writeFile(name: string, path: string, content: Uint8Array | string) {
  const file = fileIn(name, path);
  const parent = new Directory(skillDir(name), ...path.split('/').slice(0, -1));
  if (!parent.exists) parent.create({ intermediates: true });
  file.writeSync(content);
}

/**
 * Saves a whole skill from its SKILL.md text and other files, replacing any skill of the same name
 * when `replace` is set. The name comes from `name` or else the frontmatter. Returns the skill.
 */
export function saveSkill(opts: {
  skillMd: string;
  files?: SkillFiles;
  name?: string;
  source: Skill['source'];
  origin?: string;
  replace?: boolean;
  conversationId?: string;
}): Skill {
  const parsed = parseSkillMd(opts.skillMd);
  const name = checkName(opts.name ?? (parsed.name || ''));
  const description = checkDescription(parsed.description);
  if (!parsed.body.trim()) throw new SkillError('A skill needs instructions after its frontmatter.');
  // The frontmatter names the skill as it is saved, so it reads the same anywhere it is copied.
  const skillMd = parsed.name === name && parsed.hasFrontmatter ? opts.skillMd : withSkillFields(opts.skillMd, { name, description });
  if (skillMd.length > MAX_SKILL_CHARS) throw new SkillError(`${SKILL_FILE} can be at most ${MAX_SKILL_CHARS} characters.`);
  const files = Object.entries(opts.files ?? {}).map(([p, c]) => [skillPath(p), c] as const);
  if (files.length > MAX_SKILL_FILES) throw new SkillError(`A skill can hold at most ${MAX_SKILL_FILES} files.`);
  const bytes = files.reduce((n, [, c]) => n + byteLength(c), skillMd.length);
  if (bytes > MAX_SKILL_BYTES) throw new SkillError(`A skill can be at most ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);

  const existing = useSkills.getState().skills[name];
  if (existing && !opts.replace) throw new SkillError(`A skill named "${name}" already exists.`);
  const dir = skillDir(name);
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true });
  writeFile(name, SKILL_FILE, skillMd);
  for (const [path, content] of files) writeFile(name, path, content);

  const now = Date.now();
  const skill: Skill = {
    name,
    description,
    enabled: existing?.enabled ?? true,
    source: opts.source,
    ...(opts.origin ? { origin: opts.origin } : {}),
    files: listSkillFiles(name).map((f) => f.path),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
  };
  useSkills.getState().put(skill);
  return skill;
}

/** Rewrites a skill's SKILL.md in place, as `by` (the user, a model or the review). */
export function updateSkillMd(name: string, skillMd: string, by: Skill['source'], conversationId?: string) {
  const skill = useSkills.getState().skills[name];
  if (!skill) throw new SkillError(`No skill "${name}".`);
  const parsed = parseSkillMd(skillMd);
  if (parsed.name && parsed.name !== name) {
    throw new SkillError(`The frontmatter must keep name: ${name}. Make a new skill to use another name.`);
  }
  const description = checkDescription(parsed.description);
  if (!parsed.body.trim()) throw new SkillError('A skill needs instructions after its frontmatter.');
  const text = parsed.name ? skillMd : withSkillFields(skillMd, { name });
  if (text.length > MAX_SKILL_CHARS) throw new SkillError(`${SKILL_FILE} can be at most ${MAX_SKILL_CHARS} characters.`);
  writeFile(name, SKILL_FILE, text);
  useSkills.getState().patch(name, {
    description,
    updatedAt: Date.now(),
    updatedBy: by,
    ...(conversationId ? { conversationId } : {}),
  });
}

/** Replaces `oldText` in a skill's SKILL.md: once, unless `all`. Returns how many it replaced. */
export function patchSkillMd(name: string, oldText: string, newText: string, all: boolean, by: Skill['source'], conversationId?: string) {
  if (!oldText) throw new SkillError('old_string is empty.');
  const text = readSkillMd(name).replace(/\r\n?/g, '\n');
  const count = text.split(oldText).length - 1;
  if (!count) throw new SkillError(`old_string was not found in ${name}/${SKILL_FILE}. Load it with skill_view and copy the text exactly.`);
  if (count > 1 && !all) {
    throw new SkillError(`old_string appears ${count} times in ${name}/${SKILL_FILE}. Add surrounding text to pick one, or pass replace_all.`);
  }
  updateSkillMd(name, all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText), by, conversationId);
  return count;
}

export function writeSkillFile(name: string, path: string, content: Uint8Array | string, by: Skill['source'], conversationId?: string) {
  const skill = useSkills.getState().skills[name];
  if (!skill) throw new SkillError(`No skill "${name}".`);
  const rel = skillPath(path);
  if (!skill.files.includes(rel) && skill.files.length >= MAX_SKILL_FILES) {
    throw new SkillError(`A skill can hold at most ${MAX_SKILL_FILES} files.`);
  }
  const total = listSkillFiles(name).reduce((n, f) => n + (f.path === rel ? 0 : f.size), byteLength(content));
  if (total > MAX_SKILL_BYTES) throw new SkillError(`A skill can be at most ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
  writeFile(name, rel, content);
  useSkills.getState().patch(name, {
    files: listSkillFiles(name).map((f) => f.path),
    updatedAt: Date.now(),
    updatedBy: by,
    ...(conversationId ? { conversationId } : {}),
  });
  return rel;
}

export function removeSkillFile(name: string, path: string, by: Skill['source']) {
  const rel = skillPath(path);
  const file = fileIn(name, rel);
  if (!file.exists) throw new SkillError(`Skill "${name}" has no file "${rel}".`);
  file.delete();
  useSkills.getState().patch(name, { files: listSkillFiles(name).map((f) => f.path), updatedAt: Date.now(), updatedBy: by });
}

export function deleteSkill(name: string) {
  const dir = skillDir(name);
  if (dir.exists) dir.delete();
  useSkills.getState().remove(name);
}

// ---- in chats ------------------------------------------------------------------------------

/** Whether models may create and improve skills, with skill_manage and the after-reply review. */
export const skillsLearn = () => useSettings.getState().skillsAuto;

/** The skills a chat's system prompt lists: its snapshot, or the current ones before it has one. */
export function skillsFor(conversationId: string | null | undefined): SkillRef[] {
  const base = conversationId ? useChats.getState().conversations[conversationId]?.skillBase : undefined;
  return base ?? enabledSkills();
}

/** Freezes the skills a chat's system prompt lists, on its first request with tools. */
export function ensureSkillBase(conversationId: string) {
  const conversation = useChats.getState().conversations[conversationId];
  if (!conversation || conversation.skillBase) return;
  useChats.getState().setSkillBase(conversationId, enabledSkills());
}

const clipLine = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);

function listed(skills: SkillRef[]) {
  let total = 0;
  const lines: string[] = [];
  for (const s of skills) {
    const line = `- ${s.name}: ${clipLine(s.description, LISTED_DESCRIPTION_CHARS)}`;
    total += line.length;
    // Past the budget, names alone, so every skill can still be found.
    lines.push(total > LISTED_TOTAL_CHARS ? `- ${s.name}` : line);
  }
  return lines.join('\n');
}

/** The skills part of the system prompt. `manage` when the model has skill_manage. */
export function skillsSection(skills: SkillRef[], opts: { manage: boolean }) {
  if (!skills.length && !opts.manage) return '';
  const lines = [
    '# Skills',
    'Skills are instructions for particular kinds of task, installed by the user or saved in earlier chats, with any scripts and references they need. Before you start a task, check whether a skill below matches it. If one does, load it with skill_view first and follow it: it holds what was learned about doing that task well. Load only the skills the task needs; never guess at a skill\'s contents from its description.',
    skills.length ? `Available skills:\n${listed(skills)}` : 'No skills are installed yet.',
    "- Skills are guidance written for you, but the user's requests come first. A skill's scripts and files are copied into the workspace when you load it.",
  ];
  if (opts.manage) {
    lines.push(
      'Skills are also your procedural memory, which you keep up yourself with skill_manage:',
      '- After a complex task (about five or more tool calls), after getting past a tricky error, or once you have worked out a non-obvious workflow the user is likely to want again, save the approach as a skill (action "create"). Write it so a model that has never seen this chat can follow it: when to use it, the steps, the exact commands or code that worked, pitfalls to avoid and how to check the result. Put long scripts or reference material in files with write_file.',
      '- When a skill you loaded turned out to be wrong, incomplete or out of date, fix it with action "patch" as soon as you know what works, rather than only working around it.',
      "- Don't make skills for one-off tasks or trivial ones, for facts about the user (those are memories), or with secrets, personal details or the specifics of this task baked in. Prefer improving an existing skill to making a near-duplicate.",
      "- Changes to skills show in the chat; mention them in a few words, without making them the point of your reply."
    );
  }
  return lines.join('\n');
}

/** Skills added, changed and removed since the chat's snapshot, as lines for its context note. */
export function skillsDiff(conversation: Conversation) {
  const base = conversation.skillBase ?? [];
  const current = enabledSkills();
  const before = new Map(base.map((s) => [s.name, s]));
  const now = new Set(current.map((s) => s.name));
  const lines: string[] = [];
  for (const s of current) {
    const old = before.get(s.name);
    if (!old) lines.push(`+ ${s.name}: ${clipLine(s.description, LISTED_DESCRIPTION_CHARS)}`);
    else if (old.description !== s.description) lines.push(`~ ${s.name}: ${clipLine(s.description, LISTED_DESCRIPTION_CHARS)}`);
  }
  for (const s of base) if (!now.has(s.name)) lines.push(`- ${s.name} (no longer available)`);
  return lines.join('\n');
}
