import type Feather from '@expo/vector-icons/Feather';
import { useChats, type Conversation } from '@/store/chats';
import { useLibrary } from '@/store/library';
import { useSkills } from '@/store/skills';
import { availableCommands, goalCommand, planCommand, studyCommand } from './commands';
import { KIND_LABEL, libraryItems, type LibraryItem } from './library';
import { readChat } from './memory';
import { PLUGINS, pluginReady, type PluginId } from './plugins/catalog';
import { memoryPool, projectOf, workspaceFor } from './projects';
import { readSkillMd } from './skills';
import { toolOn } from './tools';
import { splitQuotes } from './quotes';
import { projectWorkspace, type Workspace } from './workspace';

/**
 * Mentions in the composer: "@" points the model at a file or folder in the chat's workspace, a
 * file in the Library or an earlier chat; "/" at a command, a skill or a plugin. Picking one only
 * writes "@label" or "/label" into the message, so typing it by hand works the same. When a
 * message is sent, resolveMentions works out what each one names, for the model.
 */
export type MentionKind = 'folder' | 'file' | 'library' | 'chat' | 'command' | 'skill' | 'plugin';

export type MentionOption = {
  key: string;
  kind: MentionKind;
  /** What goes into the message after the "@" or "/". */
  label: string;
  /** The name the list shows; subtitle is the line under it. */
  title: string;
  subtitle?: string;
  /** Lowercased names that typing filters on: an option shows when one starts with the query. */
  match: string[];
  icon?: keyof typeof Feather.glyphMap;
  /** A Library file, attached to the message when picked. */
  item?: LibraryItem;
  plugin?: PluginId;
};

export type MentionSection = { title: string; data: MentionOption[] };

export type MentionTrigger = { char: '@' | '/'; start: number; query: string };

export const SLASH_KINDS: MentionKind[] = ['command', 'skill', 'plugin'];

// Past this, what follows the "@" or "/" is taken for ordinary text.
const MAX_QUERY = 80;
// Rows a section shows at most; typing narrows the rest down.
const MAX_ROWS = 200;
// How much of a chat or skill goes into the message when there's no tool to read it with.
const MAX_INLINE_CHARS = 12_000;

/**
 * The "@" or "/" being typed at the cursor, with what follows it so far: one that starts the text
 * or follows a space, on the cursor's line. "a@b.com" and "and/or" aren't mentions.
 */
export function mentionTrigger(text: string, cursor: number): MentionTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  for (let i = before.length - 1; i >= 0 && before.length - i <= MAX_QUERY + 1; i--) {
    const ch = before[i];
    if (ch === '\n') return null;
    if ((ch === '@' || ch === '/') && (i === 0 || /\s/.test(before[i - 1]))) {
      return { char: ch, start: i, query: before.slice(i + 1) };
    }
  }
  return null;
}

/** Whether only spaces come before `index`, where a command must start (quotes ride outside the text). */
export const atStart = (text: string, index: number) => !text.slice(0, index).trim();

/** The folder the chat's tools work in; for a chat not yet started, its project's, if any. */
function workspaceOfChat(conversationId: string | null): Workspace | null {
  if (conversationId) return workspaceFor(conversationId);
  const project = projectOf(null);
  return project ? projectWorkspace(project.id) : null;
}

/** Plugins "/" and "@" can name. Study has no tools to point at: /study, a command, stands in for it. */
const mentionablePlugins = () => PLUGINS.filter((p) => p.id !== 'study' && pluginReady(p));

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const baseName = (path: string) => path.split('/').pop() ?? path;

/** Chats another chat may read, newest first: not itself, not temporary, and not walled off by a project. */
function readableChats(fromId: string | null): Conversation[] {
  const pool = memoryPool(fromId);
  return Object.values(useChats.getState().conversations)
    .filter((c) => c.id !== fromId && c.memory !== false && c.messages.length > 0 && memoryPool(c.id) === pool)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function whenLabel(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/**
 * What "@" offers, in sections: the workspace's folders and files, the Library's files, and earlier
 * chats. A remote chat works on another machine, so it gets only Library files, which go along
 * as attachments.
 */
export function atSections(conversationId: string | null, remote: boolean): MentionSection[] {
  const sections: MentionSection[] = [];
  const ws = remote ? null : workspaceOfChat(conversationId);

  if (ws) {
    let entries: ReturnType<Workspace['entries']> = [];
    try {
      entries = ws.entries();
    } catch {
      // An unreadable workspace just has nothing to offer.
    }
    const data = entries.map(
      (e): MentionOption => ({
        key: `w:${e.path}`,
        kind: e.folder ? 'folder' : 'file',
        label: e.folder ? `${e.path}/` : e.path,
        title: baseName(e.path),
        subtitle: e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/') + 1) : undefined,
        match: [baseName(e.path).toLowerCase(), e.path.toLowerCase()],
      })
    );
    if (data.length) sections.push({ title: 'Workspace', data });
  }

  const { deleted, purged } = useLibrary.getState();
  let items: LibraryItem[] = [];
  try {
    items = libraryItems(useChats.getState().conversations);
  } catch {
    // The Library is a convenience here; without it the other sections still show.
  }
  const library = items
    // Agent files in this chat's own workspace are listed under Workspace already.
    .filter((i) => !deleted[i.key] && !purged[i.key] && !(ws && i.workspace === ws.key))
    .map(
      (i): MentionOption => ({
        key: `l:${i.key}`,
        kind: 'library',
        label: i.name,
        title: i.name,
        subtitle: i.chatTitle ? `${KIND_LABEL[i.kind]} · ${oneLine(i.chatTitle)}` : KIND_LABEL[i.kind],
        match: [i.name.toLowerCase()],
        item: i,
      })
    );
  if (library.length) sections.push({ title: 'Library', data: library });

  if (!remote) {
    const chats = readableChats(conversationId).map(
      (c): MentionOption => {
        const title = oneLine(c.title) || 'Untitled chat';
        return {
          key: `c:${c.id}`,
          kind: 'chat',
          label: title,
          title,
          subtitle: whenLabel(c.updatedAt),
          match: [title.toLowerCase()],
          icon: 'message-square',
        };
      }
    );
    if (chats.length) sections.push({ title: 'Chats', data: chats });
  }
  return sections;
}

/**
 * What "/" offers: commands (only at the start of the message, where they work), then the
 * skills models may use and the plugins that are connected.
 */
export function slashSections(commands: boolean): MentionSection[] {
  const sections: MentionSection[] = [];
  if (commands) {
    sections.push({
      title: 'Commands',
      data: availableCommands().map((c) => ({
        key: `x:${c.name}`,
        kind: 'command',
        label: c.name,
        title: `/${c.name}`,
        subtitle: c.description,
        match: [c.name],
        icon: c.icon,
      })),
    });
  }
  const skills = Object.values(useSkills.getState().skills)
    .filter((s) => s.enabled)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (s): MentionOption => ({
        key: `s:${s.name}`,
        kind: 'skill',
        label: s.name,
        title: `/${s.name}`,
        subtitle: oneLine(s.description),
        match: [s.name.toLowerCase()],
        icon: 'zap',
      })
    );
  if (skills.length) sections.push({ title: 'Skills', data: skills });
  const plugins = mentionablePlugins().map(
    (p): MentionOption => ({
      key: `p:${p.id}`,
      kind: 'plugin',
      label: p.title,
      title: `/${p.title}`,
      subtitle: p.summary,
      match: [p.title.toLowerCase(), p.id],
      plugin: p.id,
    })
  );
  if (plugins.length) sections.push({ title: 'Plugins', data: plugins });
  return sections;
}

/** The options a name starts with the query in (case aside), sections that keep none dropped. */
export function filterSections(sections: MentionSection[], query: string): MentionSection[] {
  const q = query.toLowerCase();
  return sections
    .map((s) => ({ ...s, data: (q ? s.data.filter((o) => o.match.some((m) => m.startsWith(q))) : s.data).slice(0, MAX_ROWS) }))
    .filter((s) => s.data.length > 0);
}

// ---- resolving a sent message ----------------------------------------------------------------

type Target = { label: string; describe: (written: string) => string };

const clip = (text: string) => (text.length > MAX_INLINE_CHARS ? `${text.slice(0, MAX_INLINE_CHARS)}\n[…cut short]` : text);

// What may follow a mention: the end, a space, or punctuation closing a sentence or a bracket.
const BOUNDARY = /^($|[\s.,;:!?)\]}'"”’])/;

// An "@" or "/" that starts the text or follows a space, with something after it.
const MARK = /(^|\s)([@/])(?=\S)/g;

/** Where each "@" and "/" that could start a mention is. */
const marksIn = (text: string) =>
  [...text.matchAll(MARK)].map((m) => ({ char: m[2] as '@' | '/', at: (m.index ?? 0) + m[1].length }));

/** Whether `label` is named right at the start of `rest`, case aside, and ends there. */
const namedAt = (rest: string, label: string) =>
  !!label && rest.slice(0, label.length).toLowerCase() === label.toLowerCase() && BOUNDARY.test(rest.slice(label.length));

/** The longest of `items` named right at the start of `rest`. */
function longestAt<T>(rest: string, items: Iterable<T>, labelOf: (item: T) => string): T | undefined {
  let best: T | undefined;
  let length = 0;
  for (const item of items) {
    const label = labelOf(item);
    if (label.length > length && namedAt(rest, label)) {
      best = item;
      length = label.length;
    }
  }
  return best;
}

/** The names "@", "/" and, at the start of a message, commands can be followed by. */
export type MentionLabels = { at: string[]; slash: string[]; commands: string[] };

export type MentionSpan = { text: string; mention: boolean };

/** The text cut into plain runs and the mentions in it ("@name", "/name"), for showing them apart. */
export function mentionSpans(text: string, labels: MentionLabels): MentionSpan[] {
  const spans: MentionSpan[] = [];
  let last = 0;
  for (const { char, at } of marksIn(text)) {
    if (at < last) continue;
    const rest = text.slice(at + 1);
    const names = char === '@' ? labels.at : atStart(text, at) ? [...labels.slash, ...labels.commands] : labels.slash;
    const label = longestAt(rest, names, (l) => l);
    if (!label) continue;
    if (at > last) spans.push({ text: text.slice(last, at), mention: false });
    last = at + 1 + label.length;
    spans.push({ text: text.slice(at, last), mention: true });
  }
  if (last < text.length) spans.push({ text: text.slice(last), mention: false });
  return spans;
}

/** Every name a mention can have in this chat right now, for picking mentions out as they're typed. */
export function mentionLabels(conversationId: string | null, remote: boolean): MentionLabels {
  // Folders can be written with or without their slash.
  const at = atSections(conversationId, remote).flatMap((s) =>
    s.data.flatMap((o) => (o.kind === 'folder' ? [o.label, o.label.slice(0, -1)] : [o.label]))
  );
  if (remote) return { at, slash: [], commands: [] };
  // Plugins still answer to "@" (see resolveMentions).
  at.push(...mentionablePlugins().map((p) => p.title));
  return {
    at,
    slash: slashSections(false).flatMap((s) => s.data.map((o) => o.label)),
    commands: availableCommands().map((c) => c.name),
  };
}

/** The labels for the mentions a sent message was found to have (see resolveMentions). */
export function sentLabels(mentions: string[]): MentionLabels {
  const of = (char: string) => mentions.filter((m) => m.startsWith(char)).map((m) => m.slice(1));
  return { at: of('@'), slash: of('/'), commands: [] };
}

function chatTarget(fromId: string, c: Conversation): Target {
  const title = oneLine(c.title) || 'Untitled chat';
  return {
    label: title,
    describe: (written) => {
      if (toolOn('read_chat', fromId)) return `- ${written}: the earlier chat "${title}" (chat_id ${c.id}). Read it with read_chat.`;
      // No tool to read it with (memory is off here): it comes along instead.
      try {
        return `- ${written}: the earlier chat "${title}". Its transcript:\n<chat>\n${clip(readChat(fromId, c.id, 0))}\n</chat>`;
      } catch (e) {
        return `- ${written}: the earlier chat "${title}", which can't be read from here (${e instanceof Error ? e.message : String(e)}).`;
      }
    },
  };
}

function skillTarget(fromId: string, name: string): Target {
  return {
    label: name,
    describe: (written) => {
      if (toolOn('skill_view', fromId)) return `- ${written}: use the skill "${name}". Load it with skill_view and follow it.`;
      try {
        return `- ${written}: use the skill "${name}". Its instructions:\n<skill name="${name}">\n${clip(readSkillMd(name))}\n</skill>`;
      } catch {
        return `- ${written}: the skill "${name}", which couldn't be read.`;
      }
    },
  };
}

/**
 * What the @mentions and /commands in a message the user is sending refer to: `context` tells the
 * model (undefined when there is nothing to tell), and `mentions` lists them as written, for the chat
 * to show them apart. `attached` names the files sent with the message, which "@" can name too (a
 * Library file picked from the list comes along as one). Kept with the message as it was sent, so
 * the note stays the same in later requests.
 */
export function resolveMentions(
  conversationId: string,
  text: string,
  attached: string[] = []
): { context?: string; mentions: string[] } {
  const notes: string[] = [];
  const mentions: string[] = [];
  const marks = marksIn(text);

  if (marks.length) {
    // Built once, only for a message with something to look up.
    let at: Target[] | null = null;
    let slash: Target[] | null = null;
    const plugins = (): Target[] =>
      mentionablePlugins().map((p) => ({ label: p.title, describe: (w) => `- ${w}: use ${p.title} for this.` }));
    const atTargets = () => {
      if (at) return at;
      at = [];
      try {
        for (const e of workspaceFor(conversationId).entries(5000)) {
          const kind = e.folder ? 'folder' : 'file';
          const describe = (w: string) => `- ${w}: the ${kind} "${e.path}${e.folder ? '/' : ''}" in the workspace.`;
          at.push({ label: e.path, describe });
          if (e.folder) at.push({ label: `${e.path}/`, describe });
        }
      } catch {
        // Nothing in the workspace to point at.
      }
      at.push(...attached.map((name) => ({ label: name, describe: (w: string) => `- ${w}: the file "${name}" attached to this message.` })));
      at.push(...readableChats(conversationId).map((c) => chatTarget(conversationId, c)));
      // Plugins were named with "@" before they moved under "/"; their example prompts still are.
      at.push(...plugins());
      return at;
    };
    const slashTargets = () => {
      if (slash) return slash;
      slash = Object.values(useSkills.getState().skills)
        .filter((s) => s.enabled)
        .map((s) => skillTarget(conversationId, s.name));
      slash.push(...plugins());
      return slash;
    };

    const seen = new Set<string>();
    const lines: string[] = [];
    for (const { char, at: index } of marks) {
      const rest = text.slice(index + 1);
      const target = longestAt(rest, char === '@' ? atTargets() : slashTargets(), (t) => t.label);
      if (!target) continue;
      const written = `${char}${rest.slice(0, target.label.length)}`;
      if (seen.has(written.toLowerCase())) continue;
      seen.add(written.toLowerCase());
      mentions.push(written);
      lines.push(target.describe(written));
    }
    if (lines.length) notes.push(`[What the user's @mentions and /mentions in this message refer to:\n${lines.join('\n')}]`);
  }

  const plan = planCommand(text);
  const planning = !!plan && 'start' in plan;
  if (planning) {
    notes.push(
      "[/plan: Plan mode is on for this chat: the user wants a plan they approve before anything is done. Look into whatever you need to (read files, search, look things up), but change nothing: tools that write files, run code, act in apps or otherwise change things are refused. When you have a concrete plan (the steps, what each one touches, anything the user needs to decide), submit it with exit_plan_mode so they can approve it or ask for changes. If you have no such tool, reply with the plan and ask whether to go ahead.]"
    );
  }
  const study = studyCommand(text);
  const studying = !!study && 'start' in study;
  if (studying) {
    notes.push(
      '[/study: Study mode is on for this chat: the user wants to learn, so tutor them rather than hand over answers. Guide them step by step with hints and questions, test one question at a time, help them find their own mistakes, and adapt to how they are doing. The full rules come with the instructions for this chat.]'
    );
  }
  const goal = goalCommand(text);
  if (goal && 'goal' in goal) {
    notes.push(
      `[/goal: The user set a goal for this chat: "${goal.goal}". Work toward it on your own, step by step, until it is fully achieved; don't stop to ask permission for steps the goal already covers. When it is achieved, call goal_done with a short summary and tell the user the outcome. If it can't be achieved, or only the user can unblock it, call goal_done with achieved: false and explain why. Until goal_done is called, the app keeps the work going with automatic messages.]`
    );
  }
  // The command too, as written at the start of the message's own text.
  const command = /^\/(plan|goal|study)(?=\s|$)/i.exec(splitQuotes(text).text.trimStart())?.[0];
  if (command && (planning || studying || (goal && 'goal' in goal))) mentions.push(command);
  return { context: notes.length ? notes.join('\n\n') : undefined, mentions };
}
