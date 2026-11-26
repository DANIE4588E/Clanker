import { PluginApiError, pluginJson } from '../plugins/auth';
import type { Tool } from './index';
import { clip, field, int, list, opt, short, shortDate, str, strings, type ToolLabels } from './pluginUtil';

/**
 * Tools for the Notion, Todoist, Asana, ClickUp and Airtable plugins. They act on the user's real
 * pages, tasks and records through each service's API; the plugin catalog decides which are offered.
 */

type Init = Parameters<typeof pluginJson>[2];

const isStatus = (e: unknown, ...codes: number[]) => e instanceof PluginApiError && codes.includes(e.status);


/** A JSON argument of any shape (filters, sorts), parsed when sent as a string. */
function json(value: unknown, name: string): unknown {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`"${name}" must be valid JSON.`);
  }
}

/** A boolean argument; tolerates "true"/"false" strings. */
function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(t)) return true;
    if (['false', 'no', '0'].includes(t)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneLine = (text: string, max = 200) => short(text.replace(/\s+/g, ' ').trim(), max);

// ---- Asana -----------------------------------------------------------------------------------

const ASANA = 'https://app.asana.com/api/1.0';
type AsanaRes<T> = { data: T; next_page?: { offset: string } | null };
const asana = <T = any>(path: string, init: Init = {}) => pluginJson<AsanaRes<T>>('asana', `${ASANA}${path}`, init);

type AsanaRef = { gid: string; name?: string };
type AsanaTask = {
  gid: string;
  name: string;
  notes?: string;
  completed?: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  assignee?: (AsanaRef & { email?: string }) | null;
  projects?: AsanaRef[];
  memberships?: { project?: AsanaRef; section?: AsanaRef }[];
  parent?: AsanaRef | null;
  tags?: AsanaRef[];
  permalink_url?: string;
  created_at?: string;
  modified_at?: string;
  num_subtasks?: number;
  workspace?: AsanaRef;
};

const TASK_FIELDS = 'name,completed,due_on,due_at,assignee.name,projects.name,permalink_url';

async function asanaMe(signal: AbortSignal) {
  const r = await asana<{ gid: string; name: string; email?: string; workspaces: AsanaRef[] }>('/users/me?opt_fields=name,email,workspaces.name', { signal });
  return r.data;
}

/** A task gid from a gid or an app.asana.com link (old /0/<project>/<task> and new /…/task/<task> forms). */
export function asanaTaskGid(input: unknown, name = 'task'): string {
  const s = str(input, name).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/task\/(\d+)/) ?? s.match(/\/item\/(\d+)/);
  if (m) return m[1];
  const nums = s.split(/[?#]/)[0].match(/\/(\d{6,})(?=\/|$)/g);
  if (nums?.length) return nums[nums.length - 1].slice(1);
  throw new Error(`"${s}" is not an Asana task ID or link.`);
}

/** Picks the workspace: the one given (gid or name), or the only one. */
function pickWorkspace(workspaces: AsanaRef[], ref: string | undefined) {
  if (ref) {
    const w = workspaces.find((x) => x.gid === ref) ?? workspaces.find((x) => x.name?.toLowerCase() === ref.toLowerCase());
    if (!w) throw new Error(`No workspace "${ref}". Workspaces: ${workspaces.map((x) => `${x.name} (${x.gid})`).join(', ')}.`);
    return w;
  }
  if (workspaces.length === 1) return workspaces[0];
  throw new Error(`Pass the workspace: ${workspaces.map((x) => `${x.name} (${x.gid})`).join(', ')}.`);
}

/** A project gid from a gid, a link, or a name looked up by typeahead in the workspaces. */
async function asanaProject(ref: string, workspaces: AsanaRef[], signal: AbortSignal): Promise<AsanaRef> {
  const r = ref.trim();
  if (/^\d+$/.test(r)) return { gid: r };
  const m = r.match(/\/project\/(\d+)/) ?? r.match(/app\.asana\.com\/0\/(\d+)/);
  if (m) return { gid: m[1] };
  const found: AsanaRef[] = [];
  for (const w of workspaces) {
    const res = await asana<AsanaRef[]>(`/workspaces/${w.gid}/typeahead?resource_type=project&count=20&opt_fields=name&query=${encodeURIComponent(r)}`, { signal });
    found.push(...res.data);
  }
  const exact = found.filter((p) => p.name?.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No Asana project matching "${r}". List them with asana_tasks list_projects: true.`);
  throw new Error(`Several projects match "${r}": ${(exact.length ? exact : found).map((p) => `${p.name} (${p.gid})`).join(', ')}. Pass the gid.`);
}

function asanaLine(t: AsanaTask) {
  const due = t.due_at ? shortDate(t.due_at) : (t.due_on ?? '');
  const bits = [
    due && `due ${due}`,
    t.assignee?.name && `→ ${t.assignee.name}`,
    t.projects?.length ? t.projects.map((p) => p.name).join(', ') : '',
  ].filter(Boolean);
  return `${t.completed ? '[done] ' : ''}${t.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}\n   gid ${t.gid}${t.permalink_url ? ` · ${t.permalink_url}` : ''}`;
}

const byDue = (a: AsanaTask, b: AsanaTask) => (a.due_at ?? a.due_on ?? '9999').localeCompare(b.due_at ?? b.due_on ?? '9999');

const asanaTasks: Tool = {
  name: 'asana_tasks',
  description:
    "See Asana tasks. With nothing given, the user's incomplete tasks (sorted by due date). task (gid or link) shows one task with notes, subtasks and comments; " +
    'project (gid, link or name) lists a project’s tasks; assignee ("me", an email or gid) lists someone’s tasks; search finds tasks by text; ' +
    'list_projects: true lists workspaces and projects with their gids. Completed tasks are left out unless include_completed is true.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task gid or link, for its details.' },
      project: { type: 'string', description: 'Project gid, link or name.' },
      assignee: { type: 'string', description: '"me", an email or a user gid. Default me.' },
      search: { type: 'string', description: 'Text to search for in task names and descriptions.' },
      workspace: { type: 'string', description: 'Workspace gid or name, when there are several.' },
      list_projects: { type: 'boolean' },
      include_completed: { type: 'boolean' },
      count: { type: 'integer', description: 'How many tasks, 1-100. Default 50.' },
      offset: { type: 'string', description: 'next offset from a previous call, for more tasks.' },
    },
  },
  async run(input, { signal }) {
    const count = int(input.count, 50);
    const withDone = bool(input.include_completed) ?? false;
    const page = `limit=${count}${opt(input.offset) ? `&offset=${encodeURIComponent(opt(input.offset)!)}` : ''}`;
    const more = (r: AsanaRes<unknown>, hint = '') => (r.next_page?.offset ? `\n\n[More: pass offset "${r.next_page.offset}"${hint}.]` : '');

    if (opt(input.task)) {
      const gid = asanaTaskGid(input.task);
      const [task, subtasks, stories] = await Promise.all([
        asana<AsanaTask>(
          `/tasks/${gid}?opt_fields=name,notes,completed,completed_at,due_on,due_at,start_on,assignee.name,assignee.email,projects.name,memberships.project.name,memberships.section.name,parent.name,tags.name,permalink_url,created_at,modified_at,workspace.name`,
          { signal }
        ),
        asana<AsanaTask[]>(`/tasks/${gid}/subtasks?opt_fields=${TASK_FIELDS}&limit=50`, { signal }),
        asana<{ type: string; text?: string; created_at?: string; created_by?: AsanaRef }[]>(
          `/tasks/${gid}/stories?opt_fields=type,text,created_at,created_by.name&limit=100`,
          { signal }
        ),
      ]);
      const t = task.data;
      const sections = (t.memberships ?? []).filter((m) => m.section?.name).map((m) => `${m.project?.name} / ${m.section!.name}`);
      const parts = [
        asanaLine(t),
        [
          t.parent ? `Subtask of: ${t.parent.name} (${t.parent.gid})` : '',
          sections.length ? `Sections: ${sections.join(', ')}` : '',
          t.start_on ? `Starts ${t.start_on}` : '',
          t.tags?.length ? `Tags: ${t.tags.map((x) => x.name).join(', ')}` : '',
          t.assignee?.email ? `Assignee email: ${t.assignee.email}` : '',
          `Created ${shortDate(t.created_at)} · modified ${shortDate(t.modified_at)}${t.completed_at ? ` · completed ${shortDate(t.completed_at)}` : ''}`,
          t.workspace ? `Workspace: ${t.workspace.name} (${t.workspace.gid})` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ];
      if (t.notes) parts.push(`Notes:\n${t.notes}`);
      if (subtasks.data.length) parts.push(`Subtasks:\n${subtasks.data.map((s) => `- ${asanaLine(s)}`).join('\n')}`);
      const comments = stories.data.filter((s) => s.type === 'comment');
      if (comments.length) parts.push(`Comments:\n${comments.map((c) => `- ${c.created_by?.name ?? 'Someone'}, ${shortDate(c.created_at)}: ${c.text}`).join('\n')}`);
      return { output: clip(parts.join('\n\n')) };
    }

    const me = await asanaMe(signal);
    const workspaces = opt(input.workspace) ? [pickWorkspace(me.workspaces, opt(input.workspace))] : me.workspaces;

    if (bool(input.list_projects)) {
      const blocks: string[] = [];
      for (const w of workspaces) {
        const r = await asana<(AsanaRef & { permalink_url?: string; team?: AsanaRef })[]>(
          `/projects?workspace=${w.gid}&archived=false&opt_fields=name,permalink_url,team.name&limit=100`,
          { signal }
        );
        const rows = r.data.map((p) => `- ${p.name}${p.team?.name ? ` (${p.team.name})` : ''} · gid ${p.gid}${p.permalink_url ? ` · ${p.permalink_url}` : ''}`);
        blocks.push(`Workspace ${w.name} · gid ${w.gid}\n${rows.join('\n') || '  [No projects.]'}${r.next_page ? '\n  [More projects not shown.]' : ''}`);
      }
      return { output: clip(blocks.join('\n\n')) };
    }

    if (opt(input.project)) {
      const p = await asanaProject(opt(input.project)!, workspaces, signal);
      const r = await asana<AsanaTask[]>(`/projects/${p.gid}/tasks?opt_fields=${TASK_FIELDS}&${page}${withDone ? '' : '&completed_since=now'}`, { signal });
      if (!r.data.length) return { output: `No ${withDone ? '' : 'open '}tasks in ${p.name ?? `project ${p.gid}`}.` };
      return { output: clip(`Tasks in ${p.name ?? `project ${p.gid}`}:\n${r.data.map((t, i) => `${i + 1}. ${asanaLine(t)}`).join('\n')}${more(r)}`) };
    }

    if (opt(input.search)) {
      const text = opt(input.search)!;
      const out: string[] = [];
      for (const w of workspaces) {
        let tasks: AsanaTask[];
        let how = '';
        try {
          const r = await asana<AsanaTask[]>(
            `/workspaces/${w.gid}/tasks/search?text=${encodeURIComponent(text)}&opt_fields=${TASK_FIELDS}&limit=${count}&sort_by=modified_at${withDone ? '' : '&completed=false'}`,
            { signal }
          );
          tasks = r.data;
        } catch (e) {
          // Full search needs a paid plan; typeahead matches names only, but works everywhere.
          if (!isStatus(e, 402, 403)) throw e;
          const r = await asana<AsanaTask[]>(
            `/workspaces/${w.gid}/typeahead?resource_type=task&count=${Math.min(count, 100)}&opt_fields=${TASK_FIELDS}&query=${encodeURIComponent(text)}`,
            { signal }
          );
          tasks = withDone ? r.data : r.data.filter((t) => !t.completed);
          how = ' (name matches only: full-text search needs a paid Asana plan)';
        }
        if (tasks.length) out.push(`${w.name}${how}:\n${tasks.map((t, i) => `${i + 1}. ${asanaLine(t)}`).join('\n')}`);
      }
      return { output: clip(out.join('\n\n') || `No tasks matching “${text}”.`) };
    }

    const assignee = opt(input.assignee) ?? 'me';
    if (opt(input.offset) && workspaces.length > 1) throw new Error('offset needs the workspace it came from.');
    const out: string[] = [];
    for (const w of workspaces) {
      const r = await asana<AsanaTask[]>(
        `/tasks?assignee=${encodeURIComponent(assignee)}&workspace=${w.gid}&opt_fields=${TASK_FIELDS}&${page}${withDone ? '' : '&completed_since=now'}`,
        { signal }
      );
      if (r.data.length) {
        const rows = [...r.data].sort(byDue).map((t, i) => `${i + 1}. ${asanaLine(t)}`);
        out.push(`${workspaces.length > 1 ? `${w.name} (${w.gid}):\n` : ''}${rows.join('\n')}${more(r, workspaces.length > 1 ? ` with workspace "${w.gid}"` : '')}`);
      }
    }
    const who = assignee === 'me' ? 'you' : assignee;
    return { output: clip(out.length ? `${withDone ? 'Tasks' : 'Open tasks'} assigned to ${who}:\n${out.join('\n\n')}` : `No ${withDone ? '' : 'open '}tasks assigned to ${who}.`) };
  },
};

const ASANA_WRITE_FIELDS = `opt_fields=${TASK_FIELDS}`;

const asanaCreate: Tool = {
  name: 'asana_create',
  description:
    'Create an Asana task in a project (gid, link or name), or as a subtask of parent. Without either, it goes in My Tasks of the workspace. ' +
    'assignee is "me", an email or a user gid; due_on is YYYY-MM-DD, due_at an ISO date-time. Returns the task’s link.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      notes: { type: 'string', description: 'Description (plain text).' },
      project: { type: 'string', description: 'Project gid, link or name.' },
      workspace: { type: 'string', description: 'Workspace gid or name; needed without a project or parent when there are several.' },
      assignee: { type: 'string' },
      due_on: { type: 'string' },
      due_at: { type: 'string' },
      parent: { type: 'string', description: 'Parent task gid or link, to make a subtask.' },
    },
    required: ['name'],
  },
  async run(input, { signal }) {
    const fields = {
      name: str(input.name, 'name').trim(),
      ...(opt(input.notes) ? { notes: input.notes } : {}),
      ...(opt(input.assignee) ? { assignee: opt(input.assignee) } : {}),
      ...(opt(input.due_on) ? { due_on: opt(input.due_on) } : {}),
      ...(opt(input.due_at) ? { due_at: opt(input.due_at) } : {}),
    };
    let task: AsanaTask;
    if (opt(input.parent)) {
      const parent = asanaTaskGid(input.parent, 'parent');
      task = (await asana<AsanaTask>(`/tasks/${parent}/subtasks?${ASANA_WRITE_FIELDS}`, { method: 'POST', json: { data: fields }, signal })).data;
    } else {
      const me = await asanaMe(signal);
      let where: object;
      if (opt(input.project)) {
        const workspaces = opt(input.workspace) ? [pickWorkspace(me.workspaces, opt(input.workspace))] : me.workspaces;
        where = { projects: [(await asanaProject(opt(input.project)!, workspaces, signal)).gid] };
      } else {
        const w = pickWorkspace(me.workspaces, opt(input.workspace));
        // A task outside any project is only visible to its assignee, so default to the user.
        where = { workspace: w.gid, ...(fields.assignee ? {} : { assignee: 'me' }) };
      }
      task = (await asana<AsanaTask>(`/tasks?${ASANA_WRITE_FIELDS}`, { method: 'POST', json: { data: { ...fields, ...where } }, signal })).data;
    }
    return { output: `Created the Asana task.\n${asanaLine(task)}` };
  },
};

const asanaUpdate: Tool = {
  name: 'asana_update',
  description:
    'Change an Asana task: name, notes (replaces the description), completed (true/false), assignee ("me", email, gid, or "none" to unassign), ' +
    'due_on (YYYY-MM-DD, or "none" to clear), due_at, comment (adds a comment), add_project (gid, link or name). Returns its link.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task gid or link.' },
      name: { type: 'string' },
      notes: { type: 'string' },
      completed: { type: 'boolean' },
      assignee: { type: 'string' },
      due_on: { type: 'string' },
      due_at: { type: 'string' },
      comment: { type: 'string' },
      add_project: { type: 'string' },
    },
    required: ['task'],
  },
  async run(input, { signal }) {
    const gid = asanaTaskGid(input.task);
    const none = (v: string | undefined) => (v && /^(none|null|clear)$/i.test(v) ? null : v);
    const completed = bool(input.completed);
    const assignee = opt(input.assignee);
    const dueOn = opt(input.due_on);
    const data = {
      ...(opt(input.name) ? { name: opt(input.name) } : {}),
      ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
      ...(completed != null ? { completed } : {}),
      ...(assignee ? { assignee: none(assignee) } : {}),
      ...(dueOn ? { due_on: none(dueOn) } : {}),
      ...(opt(input.due_at) ? { due_at: opt(input.due_at) } : {}),
    };
    const done: string[] = [];
    let task: AsanaTask | undefined;
    if (Object.keys(data).length) {
      task = (await asana<AsanaTask>(`/tasks/${gid}?${ASANA_WRITE_FIELDS}`, { method: 'PUT', json: { data }, signal })).data;
      done.push(completed === true ? 'completed it' : completed === false ? 'marked it incomplete' : '');
      const rest = Object.keys(data).filter((k) => k !== 'completed');
      if (rest.length) done.push(`set ${rest.join(', ')}`);
    }
    if (opt(input.add_project)) {
      const me = await asanaMe(signal);
      const p = await asanaProject(opt(input.add_project)!, me.workspaces, signal);
      await asana(`/tasks/${gid}/addProject`, { method: 'POST', json: { data: { project: p.gid } }, signal });
      done.push(`added it to ${p.name ?? `project ${p.gid}`}`);
    }
    if (opt(input.comment)) {
      await asana(`/tasks/${gid}/stories`, { method: 'POST', json: { data: { text: input.comment } }, signal });
      done.push('added a comment');
    }
    if (!done.filter(Boolean).length) throw new Error('Nothing to change: pass a field to update, comment or add_project.');
    task = (await asana<AsanaTask>(`/tasks/${gid}?${ASANA_WRITE_FIELDS}`, { signal })).data;
    return { output: `${done.filter(Boolean).join('; ')}.\n${asanaLine(task)}` };
  },
};

// ---- Airtable --------------------------------------------------------------------------------

const AIRTABLE = 'https://api.airtable.com/v0';
const airtable = <T = any>(path: string, init: Init = {}) => pluginJson<T>('airtable', `${AIRTABLE}${path}`, init);

/** The base, table, view and record IDs in an airtable.com link or ID. */
function airtableIds(s: string) {
  return {
    base: s.match(/\b(app[A-Za-z0-9]{14})\b/)?.[1],
    table: s.match(/\b(tbl[A-Za-z0-9]{14})\b/)?.[1],
    view: s.match(/\b(viw[A-Za-z0-9]{14})\b/)?.[1],
    record: s.match(/\b(rec[A-Za-z0-9]{14})\b/)?.[1],
  };
}

/** Base and table from the arguments, which may be IDs, names (tables) or links. */
function airtableTarget(input: any, needTable = true) {
  const fromBase = airtableIds(str(input.base, 'base'));
  if (!fromBase.base) throw new Error(`"${input.base}" is not an Airtable base ID (app…) or link. List bases with airtable_bases.`);
  const tableArg = opt(input.table);
  const table = tableArg ? (airtableIds(tableArg).table ?? tableArg) : fromBase.table;
  if (needTable && !table) throw new Error('Pass the table (name or tbl… ID).');
  return { base: fromBase.base, table: table ?? '', view: fromBase.view, record: fromBase.record };
}

type AtField = { id: string; name: string; type: string; options?: any; description?: string };
type AtTable = { id: string; name: string; primaryFieldId: string; description?: string; fields: AtField[]; views: { id: string; name: string; type: string }[] };
type AtRecord = { id: string; createdTime?: string; fields: Record<string, unknown> };

/** A cell value as short text. */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, any>;
    if (o.filename) return `${o.filename}${o.url ? ` (${o.url})` : ''}`;
    if (o.name || o.email) return o.name ?? o.email;
    if ('specialValue' in o) return String(o.specialValue);
    if ('error' in o) return `#ERROR ${o.error}`;
    return JSON.stringify(o);
  }
  return String(v);
}

const recordText = (r: AtRecord, max: number) =>
  `${r.id}\n${Object.entries(r.fields)
    .map(([k, v]) => `   ${k}: ${max ? short(cellText(v).replace(/\s*\n\s*/g, ' ⏎ '), max) : cellText(v)}`)
    .join('\n')}`;

function fieldText(f: AtField) {
  const o = f.options ?? {};
  let extra = '';
  if (o.choices) extra = o.choices.map((c: { name: string }) => c.name).join(', ');
  else if (o.linkedTableId) extra = `→ ${o.linkedTableId}`;
  else if (o.formula) extra = oneLine(o.formula, 80);
  else if (o.precision != null && f.type !== 'number') extra = '';
  return `${f.name} (${f.type}${extra ? `: ${extra}` : ''})`;
}

const airtableBases: Tool = {
  name: 'airtable_bases',
  description:
    'See Airtable bases. With no base: the bases the token can reach (ID, name, permission). With a base (ID or link): its tables with their fields ' +
    '(types and select choices) and views. Use field and table names exactly as listed in airtable_records and airtable_write.',
  parameters: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Base ID (app…) or link.' },
      table: { type: 'string', description: 'Only this table (name or ID).' },
      offset: { type: 'string', description: 'Listing bases: next offset from a previous call.' },
    },
  },
  async run(input, { signal }) {
    if (!opt(input.base)) {
      const r = await airtable<{ bases: { id: string; name: string; permissionLevel: string }[]; offset?: string }>(
        `/meta/bases${opt(input.offset) ? `?offset=${encodeURIComponent(opt(input.offset)!)}` : ''}`,
        { signal }
      );
      if (!r.bases.length) return { output: 'No bases. The token needs the bases added to it on Airtable’s token page.' };
      const rows = r.bases.map((b, i) => `${i + 1}. ${b.name} · ${b.id} (${b.permissionLevel}) · https://airtable.com/${b.id}`);
      return { output: clip(rows.join('\n') + (r.offset ? `\n\n[More bases: pass offset "${r.offset}".]` : '')) };
    }
    const { base, table } = airtableTarget(input, false);
    const r = await airtable<{ tables: AtTable[] }>(`/meta/bases/${base}/tables`, { signal });
    let tables = r.tables;
    if (table) {
      tables = tables.filter((t) => t.id === table || t.name.toLowerCase() === table.toLowerCase());
      if (!tables.length) throw new Error(`No table "${table}". Tables: ${r.tables.map((t) => t.name).join(', ')}.`);
    }
    const out = tables.map((t) => {
      const primary = t.fields.find((f) => f.id === t.primaryFieldId)?.name;
      return (
        `## ${t.name} · ${t.id}${primary ? ` (primary field: ${primary})` : ''}${t.description ? `\n${t.description}` : ''}\n` +
        `Fields:\n${t.fields.map((f) => `- ${fieldText(f)}`).join('\n')}\n` +
        `Views: ${t.views.map((v) => `${v.name} (${v.id}, ${v.type})`).join(', ')}\n` +
        `https://airtable.com/${base}/${t.id}`
      );
    });
    return { output: clip(`Base ${base}\n\n${out.join('\n\n')}`) };
  },
};

const airtableRecords: Tool = {
  name: 'airtable_records',
  description:
    'Read records from an Airtable table. filter is an Airtable formula (filterByFormula), e.g. {Status} = "Done" or AND({Score} > 3, NOT({Email} = "")); ' +
    'sort is [{"field":"Name","direction":"asc"}]; fields limits the columns; view uses a view’s filters and order. record (ID) reads one record whole. ' +
    'Empty fields are left out of records.',
  parameters: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Base ID or link (a table or record link also fills table and record).' },
      table: { type: 'string', description: 'Table name or ID.' },
      record: { type: 'string', description: 'Record ID (rec…), to read one record.' },
      filter: { type: 'string', description: 'filterByFormula.' },
      view: { type: 'string', description: 'View name or ID.' },
      sort: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } } } },
      fields: { type: 'array', items: { type: 'string' }, description: 'Only these fields.' },
      count: { type: 'integer', description: 'Records per page, 1-100. Default 20.' },
      offset: { type: 'string', description: 'next offset from a previous call, for more records.' },
    },
    required: ['base'],
  },
  async run(input, { signal }) {
    const t = airtableTarget(input);
    const tablePath = `/${t.base}/${encodeURIComponent(t.table)}`;
    const recordId = opt(input.record) ? (airtableIds(opt(input.record)!).record ?? opt(input.record)!) : t.record;
    if (recordId) {
      const r = await airtable<AtRecord>(`${tablePath}/${recordId}`, { signal });
      return { output: clip(`${recordText(r, 0)}\n   (created ${shortDate(r.createdTime)})`) };
    }
    const params = new URLSearchParams({ pageSize: String(int(input.count, 20)) });
    if (opt(input.filter)) params.set('filterByFormula', opt(input.filter)!);
    const view = opt(input.view) ?? t.view;
    if (view) params.set('view', view);
    list<{ field?: string; direction?: string } | string>(input.sort).forEach((s, i) => {
      const f = typeof s === 'string' ? { field: s } : s;
      params.set(`sort[${i}][field]`, str(f.field, 'sort.field'));
      if (f.direction) params.set(`sort[${i}][direction]`, String(f.direction).toLowerCase().startsWith('d') ? 'desc' : 'asc');
    });
    for (const f of strings(input.fields)) params.append('fields[]', f);
    if (opt(input.offset)) params.set('offset', opt(input.offset)!);
    const r = await airtable<{ records: AtRecord[]; offset?: string }>(`${tablePath}?${params}`, { signal });
    if (!r.records.length) return { output: `No records${opt(input.filter) ? ' match the filter' : ''}.` };
    const rows = r.records.map((rec, i) => `${i + 1}. ${recordText(rec, 300)}`);
    return { output: clip(rows.join('\n') + (r.offset ? `\n\n[More records: pass offset "${r.offset}".]` : '')) };
  },
};

type AtWrite = { id?: string; fields?: Record<string, unknown> };

const airtableWrite: Tool = {
  name: 'airtable_write',
  description:
    'Change records in an Airtable table. action "create": records [{"fields":{...}}]; "update": records [{"id":"rec…","fields":{...}}] (only the given fields change); ' +
    '"delete": records ["rec…", …]. Up to 100 records per call. Field names must match airtable_bases exactly; with typecast (default true) text values are converted ' +
    '(e.g. new select options are added). Deleting is permanent from the API (only restorable from the base’s trash in Airtable for a limited time): confirm with the user first.',
  parameters: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Base ID or link.' },
      table: { type: 'string', description: 'Table name or ID.' },
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      records: { type: 'array', items: { type: 'object' }, description: 'Records as described above.' },
      typecast: { type: 'boolean', description: 'Convert text values to field types. Default true.' },
    },
    required: ['base', 'table', 'action', 'records'],
  },
  async run(input, { signal }) {
    const t = airtableTarget(input);
    const tablePath = `/${t.base}/${encodeURIComponent(t.table)}`;
    const action = str(input.action, 'action');
    const raw = list<unknown>(input.records);
    if (!raw.length) throw new Error('Pass the records.');
    if (raw.length > 100) throw new Error('At most 100 records per call; split the work.');
    const typecast = bool(input.typecast) ?? true;
    const batches = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / 10) }, (_, i) => items.slice(i * 10, i * 10 + 10));

    if (action === 'delete') {
      const ids = raw.map((r) => {
        const id = typeof r === 'string' ? r : (r as AtWrite)?.id;
        if (!id || !/^rec/.test(id)) throw new Error(`"${JSON.stringify(r)}" is not a record ID (rec…).`);
        return id.trim();
      });
      const deleted: string[] = [];
      for (const batch of batches(ids)) {
        const q = batch.map((id) => `records[]=${encodeURIComponent(id)}`).join('&');
        const r = await airtable<{ records: { id: string; deleted: boolean }[] }>(`${tablePath}?${q}`, { method: 'DELETE', signal });
        deleted.push(...r.records.filter((x) => x.deleted).map((x) => x.id));
      }
      return { output: `Deleted ${plural(deleted.length, 'record')} from ${t.table}: ${deleted.join(', ')}.` };
    }

    if (action !== 'create' && action !== 'update') throw new Error(`Unknown action "${action}". Use create, update or delete.`);
    const records = raw.map((r, i) => {
      const o = (typeof r === 'string' ? json(r, `records[${i}]`) : r) as AtWrite & Record<string, unknown>;
      if (!o || typeof o !== 'object') throw new Error(`records[${i}] must be an object.`);
      // Tolerate bare field objects ({"Name": "x"}) for create.
      const fields = (o.fields && typeof o.fields === 'object' ? o.fields : Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'id'))) as Record<string, unknown>;
      if (action === 'update' && !o.id) throw new Error(`records[${i}] needs the record id to update.`);
      return action === 'update' ? { id: String(o.id), fields } : { fields };
    });
    const written: AtRecord[] = [];
    for (const batch of batches(records)) {
      const r = await airtable<{ records: AtRecord[] }>(tablePath, { method: action === 'create' ? 'POST' : 'PATCH', json: { records: batch, typecast }, signal });
      written.push(...r.records);
    }
    const rows = written.map((rec) => recordText(rec, 120));
    return { output: clip(`${action === 'create' ? 'Created' : 'Updated'} ${plural(written.length, 'record')} in ${t.table}:\n${rows.join('\n')}`) };
  },
};

// ---- Exports ---------------------------------------------------------------------------------

/** Tools for the Asana and Airtable plugins. (Notion, Todoist and ClickUp use their MCP servers.) */
export const PRODUCTIVITY_TOOLS: Tool[] = [
  asanaTasks,
  asanaCreate,
  asanaUpdate,
  airtableBases,
  airtableRecords,
  airtableWrite,
];

const updateLabel = (i: Record<string, unknown>, service: string) => {
  const it = `${/^[AEIOU]/.test(service) ? 'an' : 'a'} ${service} task`;
  if (bool(i.delete)) return `Delete ${it}`;
  if (bool(i.complete) === true || bool(i.completed) === true) return `Complete ${it}`;
  if (bool(i.complete) === false || bool(i.completed) === false) return `Reopen ${it}`;
  const keys = Object.keys(i).filter((k) => k !== 'task' && i[k] != null && i[k] !== '');
  if (keys.length === 1 && keys[0] === 'comment') return `Comment on ${it}`;
  return `Update ${it}`;
};

/** "Create Asana task “x”", or "Create an Asana task" without a name. */
const named = (verb: string, what: string, name: string) => (name ? `${verb} ${what} “${short(name)}”` : `${verb} ${/^[AEIOU]/.test(what) ? 'an' : 'a'} ${what}`);

export const PRODUCTIVITY_LABELS: ToolLabels = {
  asana_tasks: (i) =>
    bool(i.list_projects)
      ? 'List Asana projects'
      : field(i, 'task')
        ? 'Read an Asana task'
        : field(i, 'search')
          ? `Search Asana “${short(field(i, 'search'))}”`
          : field(i, 'project')
            ? `Asana tasks in ${short(field(i, 'project'))}`
            : 'My Asana tasks',
  asana_create: (i) => named('Create', 'Asana task', field(i, 'name')),
  asana_update: (i) => updateLabel(i, 'Asana'),
  airtable_bases: (i) => (field(i, 'base') ? 'Read an Airtable base’s tables' : 'List Airtable bases'),
  airtable_records: (i) =>
    field(i, 'record') ? 'Read an Airtable record' : `Read ${int(i.count, 20)} Airtable records${field(i, 'table') ? ` from ${short(field(i, 'table'), 30)}` : ''}`,
  airtable_write: (i) => {
    const n = list(i.records).length;
    const what = n ? plural(n, 'Airtable record') : 'Airtable records';
    return { create: `Add ${what}`, update: `Update ${what}`, delete: `Delete ${what}` }[field(i, 'action')] ?? 'Change Airtable records';
  },
};
