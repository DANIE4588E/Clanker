import { fetch } from '@/lib/net';
import { PluginApiError, pluginFetch, pluginJson, type PluginRequest } from '../plugins/auth';
import { formatSize } from '../workspace';
import type { Tool } from './index';
import {
  clip,
  extOf,
  field,
  htmlToText,
  int,
  list,
  MAX_TRANSFER_BYTES,
  opt,
  readUpload,
  saveDownload,
  short,
  shortDate,
  str,
  strings,
  toBase64,
  type ToolLabels,
} from './pluginUtil';

/**
 * Tools for the Outlook, Outlook Calendar, OneDrive and Microsoft To Do plugins, through
 * Microsoft Graph v1.0. They work for personal and work or school accounts alike.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

type JsonInit = Omit<PluginRequest, 'body'> & { json?: unknown };

/** A Graph path (or a full Graph URL such as an @odata.nextLink) as a URL. */
function graphUrl(path: string) {
  if (/^https?:\/\//i.test(path)) {
    // Page tokens are nextLink URLs; never send the token anywhere but Graph.
    if (!path.startsWith(`${GRAPH}/`)) throw new Error('That page_token is not a Microsoft Graph link. Pass next_page_token exactly as given.');
    return path;
  }
  return `${GRAPH}${path}`;
}

const graph = <T = any>(path: string, init?: JsonInit) => pluginJson<T>('microsoft', graphUrl(path), init);
const graphFetch = (path: string, init?: PluginRequest) => pluginFetch('microsoft', graphUrl(path), init);

/** A query string, encoded with %20 for spaces (OData doesn't read + as a space everywhere). */
function qs(params: Record<string, string | number | undefined>) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const enc = encodeURIComponent;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const morePages = (next?: string) => (next ? `\n\n[More results: pass page_token "${next}".]` : '');
const bool = (v: unknown) => v === true || v === 'true';

// ---- Time zones ----------------------------------------------------------------------------

/** The device's IANA time zone. */
function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneOf(value: unknown) {
  const tz = opt(value) ?? deviceZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Unknown time zone "${tz}". Use an IANA name such as "Europe/London".`);
  }
  return tz;
}

/** The wall-clock time "YYYY-MM-DDTHH:mm:ss" in `tz` at an instant. */
function wallIn(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`;
}

/** The instant of a wall-clock time in `tz`. */
function instantOf(wall: string, tz: string) {
  const asUtc = Date.parse(`${wall}Z`);
  const offset = (ms: number) => Date.parse(`${wallIn(ms, tz)}Z`) - Math.floor(ms / 1000) * 1000;
  const guess = asUtc - offset(asUtc);
  return asUtc - offset(guess);
}

/**
 * A model-given date or date-time as a wall-clock time in `tz`. Times with Z or an offset are
 * converted; times without are taken as already in `tz`.
 */
function parseWhen(value: unknown, tz: string, name: string): { wall: string; dateOnly: boolean } {
  const s = str(value, name).trim().replace(' ', 'T');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(:\d{2})?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) {
    throw new Error(`${name} "${s}" is not a date or date-time like 2026-11-27T14:30 or 2026-11-27.`);
  }
  if (!m[2]) return { wall: `${m[1]}T00:00:00`, dateOnly: true };
  let wall = `${m[1]}T${m[2]}${m[3] ?? ':00'}`;
  if (m[4]) {
    const zone = m[4].toUpperCase() === 'Z' ? 'Z' : m[4].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
    wall = wallIn(Date.parse(`${wall}${zone}`), tz);
  }
  return { wall, dateOnly: false };
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

type DateTimeTimeZone = { dateTime: string; timeZone?: string };

/** A Graph date-time as wall time in `tz` (Graph sometimes answers in UTC whatever was asked). */
function wallOf(dt: DateTimeTimeZone, tz: string) {
  let wall = dt.dateTime.replace(/Z$/, '').slice(0, 19);
  if (!dt.timeZone || /^(UTC|Etc\/UTC|tzone:\/\/Microsoft\/Utc)$/i.test(dt.timeZone)) {
    const ms = Date.parse(`${wall}Z`);
    if (!Number.isNaN(ms) && tz !== 'UTC') wall = wallIn(ms, tz);
  }
  return wall;
}

function showTime(dt: DateTimeTimeZone | undefined, tz: string, dateOnly = false) {
  if (!dt?.dateTime) return '';
  const wall = wallOf(dt, tz);
  return dateOnly ? wall.slice(0, 10) : shortDate(wall);
}

const preferZone = (tz: string) => `outlook.timezone="${tz}"`;

// ---- Outlook mail --------------------------------------------------------------------------

type Recipient = { emailAddress?: { name?: string; address?: string } };
type ItemBody = { contentType?: string; content?: string };
type Message = {
  id: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  body?: ItemBody;
  uniqueBody?: ItemBody;
  hasAttachments?: boolean;
  isRead?: boolean;
  isDraft?: boolean;
  webLink?: string;
  conversationId?: string;
  flag?: { flagStatus?: string };
};
type MailFolder = { id: string; displayName: string; totalItemCount?: number; unreadItemCount?: number; childFolderCount?: number };
type Attachment = { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; '@odata.type'?: string };

const LIST_FIELDS = 'id,subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead,webLink,flag';

/** Folder names Graph accepts in place of a folder ID. */
const WELL_KNOWN_FOLDERS = [
  'inbox',
  'drafts',
  'sentitems',
  'deleteditems',
  'archive',
  'junkemail',
  'outbox',
  'clutter',
  'conversationhistory',
  'msgfolderroot',
  'scheduled',
  'searchfolders',
];
const FOLDER_ALIASES: Record<string, string> = {
  sent: 'sentitems',
  'sent items': 'sentitems',
  deleted: 'deleteditems',
  'deleted items': 'deleteditems',
  trash: 'deleteditems',
  bin: 'deleteditems',
  junk: 'junkemail',
  spam: 'junkemail',
  'junk email': 'junkemail',
  draft: 'drafts',
};

const who = (r?: Recipient) => {
  const e = r?.emailAddress;
  if (!e) return '';
  return e.name && e.address && e.name !== e.address ? `${e.name} <${e.address}>` : (e.address ?? e.name ?? '');
};
const whoList = (rs?: Recipient[]) => (rs ?? []).map(who).filter(Boolean).join(', ');

function describeMessage(m: Message, i?: number) {
  const marks = [m.isRead === false ? 'unread' : '', m.hasAttachments ? 'attachments' : '', m.flag?.flagStatus === 'flagged' ? 'flagged' : '']
    .filter(Boolean)
    .join(', ');
  const preview = (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim();
  return (
    `${i != null ? `${i + 1}. ` : ''}${m.subject || '(no subject)'}${marks ? ` [${marks}]` : ''}\n` +
    `   From ${who(m.from) || 'unknown'} · ${shortDate(m.receivedDateTime)} UTC\n` +
    (preview ? `   ${short(preview, 160)}\n` : '') +
    `   id ${m.id}${m.webLink ? `\n   ${m.webLink}` : ''}`
  );
}

/** Looks like a Graph mail folder ID rather than a name. */
const isFolderId = (s: string) => s.length > 40 && /^[A-Za-z0-9+/_=-]+$/.test(s);

async function childFolders(parent: string | null, signal: AbortSignal) {
  const base = parent ? `/me/mailFolders/${enc(parent)}/childFolders` : '/me/mailFolders';
  const out: MailFolder[] = [];
  let next: string | undefined = `${base}${qs({ $top: 100, $select: 'id,displayName,totalItemCount,unreadItemCount,childFolderCount' })}`;
  for (let page = 0; next && page < 5; page++) {
    const data: { value?: MailFolder[]; '@odata.nextLink'?: string } = await graph(next, { signal });
    out.push(...(data.value ?? []));
    next = data['@odata.nextLink'];
  }
  return out;
}

/**
 * A mail folder's ID (or well-known name) from a well-known name, an ID, or a display name or
 * path like "Inbox/Clients". With `create`, missing folders in the path are made.
 */
async function resolveMailFolder(input: string, signal: AbortSignal, create = false): Promise<{ id: string; label: string; created?: boolean }> {
  const s = input.trim();
  const lower = s.toLowerCase();
  const known = FOLDER_ALIASES[lower] ?? (WELL_KNOWN_FOLDERS.includes(lower.replace(/\s+/g, '')) ? lower.replace(/\s+/g, '') : undefined);
  if (known) return { id: known, label: known };
  if (isFolderId(s)) return { id: s, label: 'the folder' };

  const segments = s.split('/').map((p) => p.trim()).filter(Boolean);
  let parent: string | null = null;
  let created = false;
  for (const [n, name] of segments.entries()) {
    const segLower = name.toLowerCase();
    const segKnown = n === 0 ? (FOLDER_ALIASES[segLower] ?? (WELL_KNOWN_FOLDERS.includes(segLower) ? segLower : undefined)) : undefined;
    let found: MailFolder | undefined;
    if (segKnown) {
      found = { id: segKnown, displayName: name };
    } else {
      const folders = await childFolders(parent, signal);
      found = folders.find((f) => f.displayName.toLowerCase() === segLower);
      // A single name may be a subfolder of the Inbox, where people usually file mail.
      if (!found && n === 0 && segments.length === 1) {
        found = (await childFolders('inbox', signal)).find((f) => f.displayName.toLowerCase() === segLower);
      }
    }
    if (!found) {
      if (!create) {
        throw new Error(`No mail folder named "${segments.slice(0, n + 1).join('/')}". List folders with outlook_move list_folders: true, or pass create_folder: true.`);
      }
      const path: string = parent ? `/me/mailFolders/${enc(parent)}/childFolders` : '/me/mailFolders';
      found = await graph<MailFolder>(path, { method: 'POST', json: { displayName: name }, signal });
      created = true;
    }
    parent = found.id;
  }
  if (!parent) throw new Error('Pass the folder.');
  return { id: parent, label: `“${segments.join('/')}”`, created };
}

const outlookSearch: Tool = {
  name: 'outlook_search',
  description:
    "Search the user's Outlook mail. query takes keywords or KQL (from:ana, to:, subject:\"weekly report\", hasAttachments:true, received:2026-11-20, attachment:invoice.pdf); " +
    'keyword results come newest-sent first, at most 1,000. Without a query, lists the newest messages. Defaults to all folders; folder narrows to one ' +
    '(inbox, sentitems, drafts, archive, deleteditems, junkemail, a folder name or ID). Returns IDs and links for outlook_read and outlook_move.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords or KQL.' },
      folder: { type: 'string', description: 'Well-known folder name, folder name or ID. Default all mail.' },
      unread_only: { type: 'boolean', description: 'Only unread messages.' },
      count: { type: 'integer', description: 'How many, 1-50. Default 15.' },
      page_token: { type: 'string', description: 'From a previous search, for more results.' },
    },
  },
  async run(input, { signal }) {
    const query = opt(input.query);
    const unread = bool(input.unread_only);
    let url = opt(input.page_token);
    if (!url) {
      const base = opt(input.folder) ? `/me/mailFolders/${enc((await resolveMailFolder(input.folder, signal)).id)}/messages` : '/me/messages';
      const top = int(input.count, 15, 1, 50);
      // $search can't be combined with $filter or $orderby on messages; unread is then filtered here.
      // With $filter and $orderby, the sorted property must come first in the filter.
      url =
        base +
        (query
          ? qs({ $search: `"${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, $top: top, $select: LIST_FIELDS })
          : qs({
              $filter: unread ? 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false' : undefined,
              $orderby: 'receivedDateTime desc',
              $top: top,
              $select: LIST_FIELDS,
            }));
    }
    const data = await graph<{ value?: Message[]; '@odata.nextLink'?: string }>(url, { signal });
    let messages = data.value ?? [];
    const filtered = query && unread;
    if (filtered) messages = messages.filter((m) => m.isRead === false);
    const next = data['@odata.nextLink'];
    if (!messages.length) return { output: `No matching messages${filtered ? ' unread on this page' : ''}.${morePages(next)}` };
    const note = filtered ? '\n[Unread filter applied to this page of keyword results.]' : '';
    return { output: clip(messages.map((m, i) => describeMessage(m, i)).join('\n') + note + morePages(next)) };
  },
};

const outlookRead: Tool = {
  name: 'outlook_read',
  description:
    'Read an Outlook message: headers, text body and attachments. conversation: true also shows the rest of its thread (each message’s new text only). ' +
    'save_attachments: true saves its file attachments into the workspace under outlook/.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Message ID from outlook_search.' },
      conversation: { type: 'boolean', description: 'Include the other messages in the conversation.' },
      save_attachments: { type: 'boolean', description: 'Save file attachments to the workspace.' },
    },
    required: ['message_id'],
  },
  async run(input, { signal, conversationId, workspace: ws }) {
    const id = str(input.message_id, 'message_id').trim();
    const textBody = { Prefer: 'outlook.body-content-type="text"' };
    const m = await graph<Message>(
      `/me/messages/${enc(id)}${qs({ $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isRead,isDraft,webLink,conversationId,flag' })}`,
      { signal, headers: textBody }
    );
    const bodyText = (b?: ItemBody) => {
      const content = b?.content ?? '';
      return (b?.contentType?.toLowerCase() === 'html' ? htmlToText(content) : content).replace(/\n{3,}/g, '\n\n').trim();
    };
    const out = [
      `# ${m.subject || '(no subject)'}`,
      `From: ${who(m.from)}`,
      m.toRecipients?.length ? `To: ${whoList(m.toRecipients)}` : '',
      m.ccRecipients?.length ? `Cc: ${whoList(m.ccRecipients)}` : '',
      `Date: ${shortDate(m.receivedDateTime)} UTC${m.isDraft ? ' (draft)' : ''}${m.flag?.flagStatus === 'flagged' ? ' · flagged' : ''}`,
      `id ${m.id}${m.webLink ? `\n${m.webLink}` : ''}`,
      '',
      bodyText(m.body) || '[No text.]',
    ].filter((l, i) => l !== '' || i === 6);

    const files: string[] = [];
    // hasAttachments is false when there are only inline images, which are rarely wanted.
    if (m.hasAttachments || bool(input.save_attachments)) {
      const atts = await graph<{ value?: Attachment[] }>(`/me/messages/${enc(m.id)}/attachments${qs({ $select: 'id,name,contentType,size,isInline' })}`, { signal });
      const listed = (atts.value ?? []).filter((a) => !a.isInline || bool(input.save_attachments));
      if (listed.length) {
        out.push('', 'Attachments:');
        for (const a of listed) {
          const isFile = (a['@odata.type'] ?? '').endsWith('fileAttachment');
          let saved = '';
          if (bool(input.save_attachments) && isFile && !a.isInline) {
            if ((a.size ?? 0) > MAX_TRANSFER_BYTES) saved = ' (too large to save)';
            else {
              const res = await graphFetch(`/me/messages/${enc(m.id)}/attachments/${enc(a.id)}/$value`, { signal, headers: { Accept: '*/*' } });
              const { path } = await saveDownload({ ws, conversationId, bytes: new Uint8Array(await res.arrayBuffer()), name: a.name || 'attachment', dir: 'outlook' });
              files.push(path);
              saved = ` → saved to ${path}`;
            }
          } else if (!isFile) saved = ' (attached item, not a file)';
          out.push(`- ${a.name ?? 'attachment'} (${a.contentType ?? 'file'}, ${formatSize(a.size ?? 0)})${a.isInline ? ' inline' : ''}${saved}`);
        }
      }
    }

    if (bool(input.conversation) && m.conversationId) {
      const thread = await graph<{ value?: Message[] }>(
        `/me/messages${qs({ $filter: `conversationId eq '${m.conversationId.replace(/'/g, "''")}'`, $top: 50, $select: 'id,subject,from,receivedDateTime,uniqueBody,isDraft' })}`,
        { signal, headers: textBody }
      );
      const others = (thread.value ?? [])
        .filter((t) => t.id !== m.id)
        .sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));
      if (others.length) {
        out.push('', `--- ${plural(others.length, 'other message')} in this conversation, oldest first ---`);
        for (const t of others) {
          out.push('', `## ${who(t.from)} · ${shortDate(t.receivedDateTime)} UTC${t.isDraft ? ' (draft)' : ''}`, `id ${t.id}`, short(bodyText(t.uniqueBody) || '[No new text.]', 4000));
        }
      }
    }
    return { output: clip(out.join('\n')), ...(files.length ? { files } : {}) };
  },
};

/** Largest attachment added to a message in one request (Graph's limit for the simple way). */
const MAX_MAIL_ATTACHMENT = 3 * 1024 * 1024;

const recipients = (value: unknown) =>
  strings(value).map((s) => {
    const m = s.match(/^(.*)<([^>]+)>$/);
    const address = (m ? m[2] : s).trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error(`"${s}" is not an email address.`);
    return { emailAddress: { address, ...(m?.[1]?.trim() ? { name: m[1].trim().replace(/^"|"$/g, '') } : {}) } };
  });

const outlookSend: Tool = {
  name: 'outlook_send',
  description:
    'Write an Outlook email: a new message, a reply (reply_to, with reply_all) or a forward (forward + to). It is saved as a draft unless send: true, ' +
    'so the user can review it in Outlook; only send when the user asked to. Attachments are workspace files up to 3 MB each. ' +
    'For replies and forwards, body goes above the quoted original. Returns the draft’s ID and link.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string', description: 'Subject. Replies and forwards keep the original’s unless given.' },
      body: { type: 'string', description: 'Message text (or HTML with html: true).' },
      html: { type: 'boolean', description: 'body is HTML. Default false (plain text).' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Workspace paths of files to attach.' },
      reply_to: { type: 'string', description: 'ID of a message to reply to.' },
      reply_all: { type: 'boolean', description: 'With reply_to, reply to everyone.' },
      forward: { type: 'string', description: 'ID of a message to forward (pass to).' },
      send: { type: 'boolean', description: 'Send now instead of leaving a draft. Default false.' },
    },
  },
  async run(input, { signal, workspace: ws }) {
    const to = recipients(input.to);
    const cc = recipients(input.cc);
    const bcc = recipients(input.bcc);
    const body = typeof input.body === 'string' ? input.body : '';
    const html = bool(input.html);
    const subject = opt(input.subject);
    const replyTo = opt(input.reply_to);
    const forward = opt(input.forward);
    if (replyTo && forward) throw new Error('Pass reply_to or forward, not both.');

    // Read attachments first, so a bad path fails before a draft is made.
    const files = [];
    for (const path of strings(input.attachments)) {
      const f = await readUpload(ws, path);
      if (f.size > MAX_MAIL_ATTACHMENT) {
        throw new Error(`${f.path} is ${formatSize(f.size)}; Outlook attachments sent this way must be under 3 MB. Upload it with onedrive_upload and share a link instead.`);
      }
      files.push(f);
    }

    let draft: Message;
    let kind: string;
    if (replyTo || forward) {
      const id = (replyTo ?? forward)!;
      if (forward && !to.length) throw new Error('Pass to: who to forward the message to.');
      const action = forward ? 'createForward' : bool(input.reply_all) ? 'createReplyAll' : 'createReply';
      kind = forward ? 'forward' : bool(input.reply_all) ? 'reply to all' : 'reply';
      // comment puts the text above the quoted original (body would replace the quote).
      draft = await graph<Message>(`/me/messages/${enc(id)}/${action}`, {
        method: 'POST',
        json: { ...(body ? { comment: body } : {}), ...(forward ? { toRecipients: to } : {}) },
        signal,
      });
      const patch: Record<string, unknown> = {};
      if (subject) patch.subject = subject;
      if (!forward && to.length) patch.toRecipients = [...(draft.toRecipients ?? []), ...to];
      if (cc.length) patch.ccRecipients = [...(draft.ccRecipients ?? []), ...cc];
      if (bcc.length) patch.bccRecipients = bcc;
      if (Object.keys(patch).length) draft = await graph<Message>(`/me/messages/${enc(draft.id)}`, { method: 'PATCH', json: patch, signal });
    } else {
      if (!to.length && bool(input.send)) throw new Error('Pass to: who to send the message to.');
      kind = 'message';
      draft = await graph<Message>('/me/messages', {
        method: 'POST',
        json: {
          subject: subject ?? '',
          body: { contentType: html ? 'HTML' : 'Text', content: body },
          toRecipients: to,
          ccRecipients: cc,
          bccRecipients: bcc,
        },
        signal,
      });
    }

    for (const f of files) {
      await graph(`/me/messages/${enc(draft.id)}/attachments`, {
        method: 'POST',
        json: { '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.mime, contentBytes: toBase64(f.bytes) },
        signal,
      });
    }
    const attached = files.length ? ` with ${plural(files.length, 'attachment')}` : '';
    const recipientsLine = [whoList(draft.toRecipients) || whoList(to), cc.length ? `cc ${whoList(cc)}` : ''].filter(Boolean).join(', ');

    if (bool(input.send)) {
      await graph(`/me/messages/${enc(draft.id)}/send`, { method: 'POST', signal });
      return { output: `Sent the ${kind} “${draft.subject || subject || '(no subject)'}”${attached} to ${recipientsLine || 'its recipients'}. It is in Sent Items.` };
    }
    return {
      output:
        `Saved a draft ${kind} “${draft.subject || subject || '(no subject)'}”${attached}${recipientsLine ? ` to ${recipientsLine}` : ''} in Drafts; it has not been sent.\n` +
        `id ${draft.id}${draft.webLink ? `\n${draft.webLink}` : ''}`,
    };
  },
};

const FLAGS = ['flagged', 'complete', 'notFlagged'];

const outlookMove: Tool = {
  name: 'outlook_move',
  description:
    'Organise Outlook mail: move messages to a folder (well-known name like inbox/archive/junkemail, folder name or path like "Inbox/Clients", or ID; ' +
    'create_folder: true makes it if missing), mark them read or unread, flag them, or delete them (moved to Deleted Items, where the user can restore them). ' +
    'list_folders: true lists the mail folders instead. Moved messages get new IDs, which are returned.',
  parameters: {
    type: 'object',
    properties: {
      message_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of the messages to act on.' },
      folder: { type: 'string', description: 'Folder to move them to.' },
      create_folder: { type: 'boolean', description: 'Create the folder if it does not exist.' },
      mark_read: { type: 'boolean', description: 'true marks read, false unread.' },
      flag: { type: 'string', enum: FLAGS },
      delete: { type: 'boolean', description: 'Move them to Deleted Items.' },
      list_folders: { type: 'boolean', description: 'List mail folders and their counts.' },
    },
  },
  async run(input, { signal }) {
    if (bool(input.list_folders)) {
      const top = await childFolders(null, signal);
      const lines: string[] = [];
      for (const f of top) {
        lines.push(`- ${f.displayName} (${f.unreadItemCount ?? 0} unread / ${f.totalItemCount ?? 0}) · id ${f.id}`);
        if (f.childFolderCount) {
          for (const c of await childFolders(f.id, signal)) {
            lines.push(`  - ${f.displayName}/${c.displayName} (${c.unreadItemCount ?? 0} unread / ${c.totalItemCount ?? 0}) · id ${c.id}`);
          }
        }
      }
      return { output: clip(lines.length ? `Mail folders:\n${lines.join('\n')}` : 'No mail folders.') };
    }

    const ids = strings(input.message_ids);
    if (!ids.length) throw new Error('Pass message_ids (or list_folders: true).');
    const flag = opt(input.flag);
    if (flag && !FLAGS.includes(flag)) throw new Error(`flag must be one of: ${FLAGS.join(', ')}.`);
    const markRead = input.mark_read == null ? undefined : bool(input.mark_read);
    const del = bool(input.delete);
    const folderArg = opt(input.folder);
    if (del && folderArg) throw new Error('Pass delete or folder, not both.');
    if (!del && !folderArg && markRead === undefined && !flag) throw new Error('Nothing to do: pass folder, delete, mark_read or flag.');

    const dest = del ? { id: 'deleteditems', label: 'Deleted Items' } : folderArg ? await resolveMailFolder(folderArg, signal, bool(input.create_folder)) : undefined;
    const patch: Record<string, unknown> = {};
    if (markRead !== undefined) patch.isRead = markRead;
    if (flag) patch.flag = { flagStatus: flag };

    const done: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        let m: Message = { id };
        if (Object.keys(patch).length) m = await graph<Message>(`/me/messages/${enc(id)}${qs({ $select: 'id,subject' })}`, { method: 'PATCH', json: patch, signal });
        if (dest) m = await graph<Message>(`/me/messages/${enc(id)}/move`, { method: 'POST', json: { destinationId: dest.id }, signal });
        done.push(`- ${m.subject ? `“${short(m.subject, 60)}” ` : ''}${dest ? `new id ${m.id}` : `id ${m.id}`}`);
      } catch (e) {
        if (signal.aborted) throw e;
        failed.push(`- ${id}: ${(e as Error).message}`);
      }
    }
    const what = [
      dest ? (del ? 'moved to Deleted Items (restorable from there)' : `moved to ${dest.label}${'created' in dest && dest.created ? ' (new folder)' : ''}`) : '',
      markRead !== undefined ? `marked ${markRead ? 'read' : 'unread'}` : '',
      flag ? (flag === 'notFlagged' ? 'unflagged' : flag === 'complete' ? 'flag marked complete' : 'flagged') : '',
    ]
      .filter(Boolean)
      .join(', ');
    const out = [done.length ? `${plural(done.length, 'message')} ${what}:\n${done.join('\n')}` : '', failed.length ? `Failed for ${failed.length}:\n${failed.join('\n')}` : '']
      .filter(Boolean)
      .join('\n\n');
    return { output: clip(out), ...(done.length ? {} : { isError: true }) };
  },
};

// ---- Outlook Calendar ----------------------------------------------------------------------

type Attendee = Recipient & { type?: string; status?: { response?: string } };
type CalEvent = {
  id: string;
  subject?: string;
  start?: DateTimeTimeZone;
  end?: DateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  location?: { displayName?: string };
  organizer?: Recipient;
  attendees?: Attendee[];
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  responseStatus?: { response?: string };
  showAs?: string;
  webLink?: string;
  bodyPreview?: string;
  recurrence?: unknown;
  seriesMasterId?: string | null;
};

const EVENT_FIELDS =
  'id,subject,start,end,isAllDay,isCancelled,isOrganizer,location,organizer,attendees,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,responseStatus,showAs,webLink,bodyPreview,seriesMasterId';

function describeEvent(e: CalEvent, tz: string, i?: number) {
  const allDay = !!e.isAllDay;
  const start = showTime(e.start, tz, allDay);
  // All-day events end at midnight after their last day.
  const end = allDay && e.end?.dateTime ? addDays(e.end.dateTime.slice(0, 10), -1) : showTime(e.end, tz);
  const when = allDay ? (end && end !== start ? `${start} – ${end} (all day)` : `${start} (all day)`) : `${start} – ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end}`;
  const join = e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? '';
  const response = e.isOrganizer ? 'organizer' : e.responseStatus?.response && e.responseStatus.response !== 'none' ? e.responseStatus.response : '';
  const bits = [
    e.location?.displayName ? `at ${e.location.displayName}` : '',
    !e.isOrganizer && e.organizer ? `organized by ${who(e.organizer)}` : '',
    e.attendees?.length ? plural(e.attendees.length, 'attendee') : '',
    response ? `you: ${response}` : '',
    e.seriesMasterId ? 'recurring' : '',
  ].filter(Boolean);
  return (
    `${i != null ? `${i + 1}. ` : ''}${e.isCancelled ? '[Cancelled] ' : ''}${e.subject || '(no title)'} — ${when}\n` +
    (bits.length ? `   ${bits.join(' · ')}\n` : '') +
    (join ? `   Join: ${join}\n` : '') +
    `   id ${e.id}${e.webLink ? `\n   ${e.webLink}` : ''}`
  );
}

const outlookCalendarEvents: Tool = {
  name: 'outlook_calendar_events',
  description:
    "List events in the user's Outlook calendar between from and to (default now to 7 days ahead), including each occurrence of recurring events, " +
    'with times in the user’s time zone. query keeps events whose title, location or preview contain it. list_calendars: true lists the calendars instead. ' +
    'Returns event IDs for outlook_calendar_update.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start, e.g. 2026-11-27 or 2026-11-27T09:00 (user’s time zone unless an offset is given).' },
      to: { type: 'string', description: 'End (exclusive). A bare date means the start of that day.' },
      query: { type: 'string', description: 'Text to look for in titles, locations and previews.' },
      count: { type: 'integer', description: 'How many, 1-100. Default 30.' },
      calendar: { type: 'string', description: 'Calendar ID. Default the main calendar.' },
      time_zone: { type: 'string', description: 'IANA time zone. Default the device’s.' },
      list_calendars: { type: 'boolean' },
      page_token: { type: 'string', description: 'From a previous call, for more events.' },
    },
  },
  async run(input, { signal }) {
    const tz = zoneOf(input.time_zone);
    const headers = { Prefer: preferZone(tz) };
    if (bool(input.list_calendars)) {
      const data = await graph<{ value?: { id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean; owner?: { address?: string } }[] }>(
        `/me/calendars${qs({ $select: 'id,name,isDefaultCalendar,canEdit,owner', $top: 100 })}`,
        { signal }
      );
      const lines = (data.value ?? []).map(
        (c) => `- ${c.name}${c.isDefaultCalendar ? ' (default)' : ''}${c.canEdit === false ? ' (read-only)' : ''}${c.owner?.address ? ` · ${c.owner.address}` : ''}\n  id ${c.id}`
      );
      return { output: clip(lines.length ? lines.join('\n') : 'No calendars.') };
    }
    const query = opt(input.query)?.toLowerCase();
    const count = int(input.count, 30, 1, 100);
    let url = opt(input.page_token);
    let range = '';
    if (!url) {
      const from = opt(input.from) ? instantOf(parseWhen(input.from, tz, 'from').wall, tz) : Date.now();
      const to = opt(input.to) ? instantOf(parseWhen(input.to, tz, 'to').wall, tz) : from + 7 * 86_400_000;
      if (!(to > from)) throw new Error('to must be after from.');
      const base = opt(input.calendar) ? `/me/calendars/${enc(input.calendar.trim())}/calendarView` : '/me/calendarView';
      url =
        base +
        qs({
          startDateTime: new Date(from).toISOString(),
          endDateTime: new Date(to).toISOString(),
          $orderby: 'start/dateTime',
          // Matching happens here (events don't support $search), so fetch more when filtering.
          $top: query ? 100 : count,
          $select: EVENT_FIELDS,
        });
      range = `${shortDate(wallIn(from, tz))} – ${shortDate(wallIn(to, tz))} (${tz})`;
    }
    const data = await graph<{ value?: CalEvent[]; '@odata.nextLink'?: string }>(url, { signal, headers });
    let events = data.value ?? [];
    if (query) {
      events = events.filter((e) => [e.subject, e.location?.displayName, e.bodyPreview].some((t) => t?.toLowerCase().includes(query))).slice(0, count);
    }
    const next = data['@odata.nextLink'];
    if (!events.length) return { output: `No ${query ? 'matching ' : ''}events${range ? ` in ${range}` : ''}.${morePages(next)}` };
    return { output: clip(`${range ? `Events ${range}:\n` : ''}${events.map((e, i) => describeEvent(e, tz, i)).join('\n')}${morePages(next)}`) };
  },
};

type Recurrence = { frequency?: string; interval?: number; count?: number; until?: string };
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A Graph patternedRecurrence for a simple repeat, anchored on the start date. */
function recurrenceOf(value: unknown, startDate: string, tz: string) {
  let r: Recurrence;
  if (typeof value === 'string' && !value.trim().startsWith('{')) r = { frequency: value };
  else r = (typeof value === 'string' ? JSON.parse(value) : value) as Recurrence;
  const frequency = String(r.frequency ?? '').toLowerCase();
  if (!FREQUENCIES.includes(frequency)) throw new Error(`recurrence.frequency must be one of: ${FREQUENCIES.join(', ')}.`);
  const interval = int(r.interval, 1, 1, 99);
  const day = new Date(`${startDate}T00:00:00Z`);
  const pattern: Record<string, unknown> = { interval };
  if (frequency === 'daily') pattern.type = 'daily';
  else if (frequency === 'weekly') Object.assign(pattern, { type: 'weekly', daysOfWeek: [WEEKDAYS[day.getUTCDay()]], firstDayOfWeek: 'sunday' });
  else if (frequency === 'monthly') Object.assign(pattern, { type: 'absoluteMonthly', dayOfMonth: day.getUTCDate() });
  else Object.assign(pattern, { type: 'absoluteYearly', dayOfMonth: day.getUTCDate(), month: day.getUTCMonth() + 1 });
  const until = opt(r.until);
  const count = r.count != null ? int(r.count, 1, 1, 999) : undefined;
  const range = until
    ? { type: 'endDate', startDate, endDate: parseWhen(until, tz, 'recurrence.until').wall.slice(0, 10), recurrenceTimeZone: tz }
    : count
      ? { type: 'numbered', startDate, numberOfOccurrences: count, recurrenceTimeZone: tz }
      : { type: 'noEnd', startDate, recurrenceTimeZone: tz };
  return { pattern, range };
}

/** start/end/isAllDay for an event from model input. All-day events need whole dates. */
function eventTimes(input: Record<string, any>, tz: string, existing?: CalEvent) {
  const out: Record<string, unknown> = {};
  const allDay = input.all_day != null ? bool(input.all_day) : undefined;
  let start = opt(input.start) ? parseWhen(input.start, tz, 'start') : undefined;
  const end = opt(input.end) ? parseWhen(input.end, tz, 'end') : undefined;
  // Switching an existing event to or from all day needs its times rewritten too.
  if (!start && allDay !== undefined && existing?.start && allDay !== !!existing.isAllDay) {
    start = { wall: wallOf(existing.start, tz), dateOnly: allDay };
  }
  const isAllDay = allDay ?? (start ? start.dateOnly && (!end || end.dateOnly) : existing?.isAllDay);
  if (allDay !== undefined) out.isAllDay = allDay;
  else if (start && isAllDay) out.isAllDay = true;
  // When only the start moves, an existing event keeps its length.
  const keep = existing?.start && existing.end && !!existing.isAllDay === !!isAllDay;
  const oldStart = keep ? wallOf(existing.start!, tz) : '';
  const oldEnd = keep ? wallOf(existing.end!, tz) : '';
  if (start) {
    if (isAllDay) {
      const s = start.wall.slice(0, 10);
      const days = keep ? Math.max(1, Math.round((Date.parse(`${oldEnd.slice(0, 10)}T00:00:00Z`) - Date.parse(`${oldStart.slice(0, 10)}T00:00:00Z`)) / 86_400_000)) : 1;
      // An all-day event's end is the midnight after its last day; a given end date is taken as inclusive.
      const e = end ? addDays(end.wall.slice(0, 10), end.wall.slice(0, 10) === s ? 1 : end.dateOnly ? 1 : 0) : addDays(s, days);
      out.start = { dateTime: `${s}T00:00:00`, timeZone: tz };
      out.end = { dateTime: `${e > s ? e : addDays(s, 1)}T00:00:00`, timeZone: tz };
    } else {
      out.start = { dateTime: start.wall, timeZone: tz };
      const length = keep ? instantOf(oldEnd, tz) - instantOf(oldStart, tz) : 60 * 60_000;
      const endWall = end?.wall ?? wallIn(instantOf(start.wall, tz) + (length > 0 ? length : 60 * 60_000), tz);
      if (instantOf(endWall, tz) <= instantOf(start.wall, tz)) throw new Error('end must be after start.');
      out.end = { dateTime: endWall, timeZone: tz };
    }
  } else if (end) {
    out.end = isAllDay ? { dateTime: `${addDays(end.wall.slice(0, 10), 1)}T00:00:00`, timeZone: tz } : { dateTime: end.wall, timeZone: tz };
  }
  return out;
}

const attendeesOf = (required: unknown, optional: unknown) => [
  ...recipients(required).map((r) => ({ ...r, type: 'required' })),
  ...recipients(optional).map((r) => ({ ...r, type: 'optional' })),
];

/** The online meeting provider to use for teams: true, or a note on why there is none. */
async function meetingProvider(signal: AbortSignal): Promise<{ provider?: string; note?: string }> {
  try {
    const cal = await graph<{ allowedOnlineMeetingProviders?: string[]; defaultOnlineMeetingProvider?: string }>(
      `/me/calendar${qs({ $select: 'allowedOnlineMeetingProviders,defaultOnlineMeetingProvider' })}`,
      { signal }
    );
    const allowed = (cal.allowedOnlineMeetingProviders ?? []).filter((p) => p !== 'unknown');
    if (allowed.includes('teamsForBusiness')) return { provider: 'teamsForBusiness' };
    // Personal Microsoft accounts usually only offer Skype (or nothing) here.
    const fallback = cal.defaultOnlineMeetingProvider && cal.defaultOnlineMeetingProvider !== 'unknown' ? cal.defaultOnlineMeetingProvider : allowed[0];
    if (fallback) return { provider: fallback, note: `This account can't create Teams meetings through Outlook, so a ${fallback} meeting was added instead.` };
    return { note: "This account can't add online meeting links to events (common for personal Microsoft accounts), so the event has no Teams link." };
  } catch (e) {
    if (signal.aborted) throw e;
    return { provider: 'teamsForBusiness' };
  }
}

const outlookCalendarCreate: Tool = {
  name: 'outlook_calendar_create',
  description:
    "Create an event in the user's Outlook calendar. Times are in the user's time zone unless time_zone or an offset is given; a bare date, or all_day: true, " +
    'makes an all-day event (end date inclusive). Without end, timed events last an hour. Attendees get invitations. teams: true adds a Teams meeting link ' +
    '(work or school accounts; personal accounts may not support it). recurrence repeats it, e.g. {"frequency":"weekly","count":10}.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      start: { type: 'string', description: 'e.g. 2026-11-27T14:30, or 2026-11-27 for all day.' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      time_zone: { type: 'string', description: 'IANA time zone. Default the device’s.' },
      body: { type: 'string', description: 'Description (plain text).' },
      location: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Required attendees’ email addresses.' },
      optional_attendees: { type: 'array', items: { type: 'string' } },
      teams: { type: 'boolean', description: 'Add a Teams meeting link.' },
      reminder_minutes: { type: 'integer', description: 'Minutes before the start to remind. Default the calendar’s.' },
      show_as: { type: 'string', enum: ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'] },
      recurrence: {
        type: 'object',
        properties: {
          frequency: { type: 'string', enum: FREQUENCIES },
          interval: { type: 'integer', description: 'Every n days/weeks/months. Default 1.' },
          count: { type: 'integer', description: 'Number of occurrences.' },
          until: { type: 'string', description: 'Last date.' },
        },
      },
      calendar: { type: 'string', description: 'Calendar ID. Default the main calendar.' },
    },
    required: ['subject', 'start'],
  },
  async run(input, { signal }) {
    const tz = zoneOf(input.time_zone);
    const times = eventTimes(input, tz);
    const event: Record<string, unknown> = { subject: str(input.subject, 'subject'), ...times };
    if (opt(input.body)) event.body = { contentType: 'Text', content: input.body };
    if (opt(input.location)) event.location = { displayName: input.location.trim() };
    const attendees = attendeesOf(input.attendees, input.optional_attendees);
    if (attendees.length) event.attendees = attendees;
    if (input.reminder_minutes != null) Object.assign(event, { isReminderOn: true, reminderMinutesBeforeStart: int(input.reminder_minutes, 15, 0, 40_320) });
    if (opt(input.show_as)) event.showAs = input.show_as;
    if (input.recurrence != null && input.recurrence !== '') {
      event.recurrence = recurrenceOf(input.recurrence, (times.start as DateTimeTimeZone).dateTime.slice(0, 10), tz);
    }
    let note = '';
    if (bool(input.teams)) {
      const m = await meetingProvider(signal);
      if (m.provider) Object.assign(event, { isOnlineMeeting: true, onlineMeetingProvider: m.provider });
      note = m.note ?? '';
    }
    const path = opt(input.calendar) ? `/me/calendars/${enc(input.calendar.trim())}/events` : '/me/events';
    let created: CalEvent;
    try {
      created = await graph<CalEvent>(path, { method: 'POST', json: event, signal, headers: { Prefer: preferZone(tz) } });
    } catch (e) {
      // Some accounts refuse online meetings even when listed as allowed; make the event without one.
      if (!(e instanceof PluginApiError) || e.status !== 400 || !event.isOnlineMeeting || !/online ?meeting/i.test(e.message + e.body)) throw e;
      delete event.isOnlineMeeting;
      delete event.onlineMeetingProvider;
      created = await graph<CalEvent>(path, { method: 'POST', json: event, signal, headers: { Prefer: preferZone(tz) } });
      note = `The account refused an online meeting (${e.message}), so the event has no Teams link.`;
    }
    const invited = attendees.length ? ` Invitations went to ${plural(attendees.length, 'attendee')}.` : '';
    const joinMissing = bool(input.teams) && created.isOnlineMeeting && !created.onlineMeeting?.joinUrl ? ' The join link may take a moment to appear; check with outlook_calendar_events.' : '';
    return { output: `Created the event.${invited}${joinMissing}${note ? `\n${note}` : ''}\n${describeEvent(created, tz)}` };
  },
};

const RESPONSES: Record<string, string> = { accept: 'accept', decline: 'decline', tentative: 'tentativelyAccept' };

const outlookCalendarUpdate: Tool = {
  name: 'outlook_calendar_update',
  description:
    'Change an Outlook calendar event (find its ID with outlook_calendar_events first). Pass the fields to change (subject, start, end, all_day, location, body, ' +
    'attendees replaces the attendee list, teams, reminder_minutes, show_as); attendees are notified. Or: response accept|decline|tentative to an invitation ' +
    '(with optional comment); cancel: true to cancel a meeting you organise (attendees get the comment) or decline one you were invited to; ' +
    'delete: true to remove it (it goes to Deleted Items; deleting a meeting you organise cancels it for attendees).',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string' },
      subject: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      time_zone: { type: 'string', description: 'IANA time zone for start/end. Default the device’s.' },
      location: { type: 'string' },
      body: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'New required attendee list.' },
      optional_attendees: { type: 'array', items: { type: 'string' } },
      teams: { type: 'boolean' },
      reminder_minutes: { type: 'integer' },
      show_as: { type: 'string', enum: ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'] },
      response: { type: 'string', enum: Object.keys(RESPONSES) },
      cancel: { type: 'boolean' },
      delete: { type: 'boolean' },
      comment: { type: 'string', description: 'Message for the organizer or attendees (response, cancel).' },
    },
    required: ['event_id'],
  },
  async run(input, { signal }) {
    const tz = zoneOf(input.time_zone);
    const id = str(input.event_id, 'event_id').trim();
    const path = `/me/events/${enc(id)}`;
    const headers = { Prefer: preferZone(tz) };
    const comment = opt(input.comment) ?? '';

    if (bool(input.delete)) {
      const e = await graph<CalEvent>(`${path}${qs({ $select: 'id,subject,isOrganizer,attendees' })}`, { signal });
      await graph(path, { method: 'DELETE', signal });
      const cancelled = e.isOrganizer && e.attendees?.length ? ' Attendees were sent a cancellation.' : '';
      return { output: `Deleted “${e.subject ?? 'the event'}”; it is in Deleted Items.${cancelled}` };
    }
    if (bool(input.cancel)) {
      const e = await graph<CalEvent>(`${path}${qs({ $select: 'id,subject,isOrganizer,attendees' })}`, { signal });
      if (!e.isOrganizer) {
        await graph(`${path}/decline`, { method: 'POST', json: { comment, sendResponse: true }, signal });
        return { output: `You aren't the organizer of “${e.subject ?? 'the event'}”, so it was declined${comment ? ' with your comment' : ''} and the organizer told.` };
      }
      if (!e.attendees?.length) {
        // cancel is for meetings; an event without attendees is just removed.
        await graph(path, { method: 'DELETE', signal });
        return { output: `“${e.subject ?? 'The event'}” had no attendees, so it was deleted (it is in Deleted Items).` };
      }
      await graph(`${path}/cancel`, { method: 'POST', json: comment ? { comment } : {}, signal });
      return { output: `Cancelled “${e.subject ?? 'the meeting'}”; ${plural(e.attendees.length, 'attendee')} were sent the cancellation${comment ? ' with your comment' : ''}.` };
    }
    const response = opt(input.response);
    if (response) {
      const action = RESPONSES[response];
      if (!action) throw new Error(`response must be one of: ${Object.keys(RESPONSES).join(', ')}.`);
      await graph(`${path}/${action}`, { method: 'POST', json: { comment, sendResponse: true }, signal });
      const e = await graph<CalEvent>(`${path}${qs({ $select: EVENT_FIELDS })}`, { signal, headers });
      return { output: `Responded “${response}”${comment ? ' with a comment' : ''}.\n${describeEvent(e, tz)}` };
    }

    const current = input.start != null || input.end != null || input.all_day != null ? await graph<CalEvent>(`${path}${qs({ $select: 'id,isAllDay,start,end' })}`, { signal, headers }) : undefined;
    const patch: Record<string, unknown> = eventTimes(input, tz, current);
    if (opt(input.subject)) patch.subject = input.subject.trim();
    if (input.body != null) patch.body = { contentType: 'Text', content: String(input.body) };
    if (input.location != null) patch.location = { displayName: String(input.location) };
    if (input.attendees != null || input.optional_attendees != null) patch.attendees = attendeesOf(input.attendees, input.optional_attendees);
    if (input.reminder_minutes != null) Object.assign(patch, { isReminderOn: true, reminderMinutesBeforeStart: int(input.reminder_minutes, 15, 0, 40_320) });
    if (opt(input.show_as)) patch.showAs = input.show_as;
    let note = '';
    if (input.teams != null) {
      if (bool(input.teams)) {
        const m = await meetingProvider(signal);
        if (m.provider) Object.assign(patch, { isOnlineMeeting: true, onlineMeetingProvider: m.provider });
        note = m.note ?? '';
      } else note = 'An online meeting can’t be removed from an event once added.';
    }
    if (!Object.keys(patch).length) throw new Error(note || 'Nothing to change: pass fields to update, or response, cancel or delete.');
    const e = await graph<CalEvent>(path, { method: 'PATCH', json: patch, signal, headers });
    return { output: `Updated the event.${note ? `\n${note}` : ''}\n${describeEvent(e, tz)}` };
  },
};

// ---- OneDrive ------------------------------------------------------------------------------

type DriveItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  package?: { type?: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
  remoteItem?: DriveItem;
  '@microsoft.graph.downloadUrl'?: string;
};

/** The sharing token for a OneDrive or SharePoint link: "u!" + unpadded base64url of the URL. */
const shareToken = (url: string) =>
  `u!${toBase64(new TextEncoder().encode(url)).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;

/** Personal ("ABC123!456") and work ("01ABC…", 34 characters) item IDs. */
const isItemId = (s: string) => /^[A-Za-z0-9]+![A-Za-z0-9._!-]+$/.test(s) || /^[A-Z0-9]{30,}$/.test(s);

/** The Graph path for an item given as an ID, a OneDrive path, or a sharing/web link. */
function itemRef(value: unknown, name: string) {
  const s = str(value, name).trim();
  if (s === '/' || /^root$/i.test(s)) return '/me/drive/root';
  if (/^https?:\/\//i.test(s)) return `/shares/${shareToken(s)}/driveItem`;
  if (isItemId(s)) return `/me/drive/items/${enc(s)}`;
  const segments = s.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (!segments.length) return '/me/drive/root';
  return `/me/drive/root:/${segments.map(enc).join('/')}`;
}

/** An item's metadata; items shared into the user's drive resolve to the original. */
async function getItem(value: unknown, name: string, signal: AbortSignal) {
  const ref = itemRef(value, name);
  const headers: Record<string, string> = ref.startsWith('/shares/') ? { Prefer: 'redeemSharingLinkIfNecessary' } : {};
  try {
    const item = await graph<DriveItem>(ref, { signal, headers });
    return item.remoteItem ? { ...item.remoteItem, name: item.remoteItem.name ?? item.name } : item;
  } catch (e) {
    if (e instanceof PluginApiError && e.status === 404) {
      throw new Error(`OneDrive has no item "${String(value)}". Pass an ID or link from onedrive_search, or a path like "/Documents/report.docx".`);
    }
    throw e;
  }
}

const itemUrl = (item: DriveItem) =>
  item.parentReference?.driveId ? `/drives/${enc(item.parentReference.driveId)}/items/${enc(item.id)}` : `/me/drive/items/${enc(item.id)}`;

const itemPath = (item: DriveItem) => {
  const parent = item.parentReference?.path?.replace(/^\/drives?\/[^/]*\/?root:|^\/drive\/root:/, '');
  if (parent == null) return '';
  let decoded = parent;
  try {
    decoded = decodeURIComponent(parent);
  } catch {}
  return `${decoded}/${item.name}`;
};

function describeItem(item: DriveItem, i?: number) {
  const kind = item.folder ? `folder, ${plural(item.folder.childCount ?? 0, 'item')}` : item.package ? `${item.package.type ?? 'package'}` : formatSize(item.size ?? 0);
  const path = itemPath(item);
  return (
    `${i != null ? `${i + 1}. ` : ''}${item.name} (${kind}${item.lastModifiedDateTime ? `, modified ${item.lastModifiedDateTime.slice(0, 10)}` : ''})\n` +
    `   id ${item.id}${path ? ` · ${path}` : ''}${item.webUrl ? `\n   ${item.webUrl}` : ''}`
  );
}

const ITEM_FIELDS = 'id,name,size,webUrl,lastModifiedDateTime,folder,file,package,parentReference,remoteItem';

const onedriveSearch: Tool = {
  name: 'onedrive_search',
  description:
    "Find files in the user's OneDrive. query searches names and contents; folder lists a folder's contents instead (a path like \"/Documents\", an ID or a " +
    'share link; "/" for the top). With neither, lists the top folder. Returns IDs, paths and links for the other onedrive_ tools.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to find in file names and contents.' },
      folder: { type: 'string', description: 'Folder to list.' },
      count: { type: 'integer', description: 'How many, 1-100. Default 25.' },
      page_token: { type: 'string', description: 'From a previous call, for more results.' },
    },
  },
  async run(input, { signal }) {
    const query = opt(input.query);
    const top = int(input.count, 25, 1, 100);
    let url = opt(input.page_token);
    let heading = '';
    if (!url) {
      if (query) {
        url = `/me/drive/root/search(q='${enc(query.replace(/'/g, "''"))}')${qs({ $top: top, $select: ITEM_FIELDS })}`;
      } else {
        const folder = await getItem(opt(input.folder) ?? '/', 'folder', signal);
        if (!folder.folder) throw new Error(`“${folder.name}” is a file, not a folder.\n${describeItem(folder)}`);
        heading = `${itemPath(folder) || (folder.name === 'root' ? '/' : folder.name)} (folder id ${folder.id}):\n`;
        url = `${itemUrl(folder)}/children${qs({ $top: top, $select: ITEM_FIELDS })}`;
      }
    }
    const data = await graph<{ value?: DriveItem[]; '@odata.nextLink'?: string }>(url, { signal });
    const items = (data.value ?? []).map((it) => (it.remoteItem ? { ...it.remoteItem, name: it.remoteItem.name ?? it.name } : it));
    const next = data['@odata.nextLink'];
    if (!items.length) return { output: `${heading}${query ? 'No matching files in OneDrive.' : 'The folder is empty.'}${morePages(next)}` };
    return { output: clip(heading + items.map((it, i) => describeItem(it, i)).join('\n') + morePages(next)) };
  },
};

const onedriveDownload: Tool = {
  name: 'onedrive_download',
  description:
    'Download a OneDrive file into the workspace (under onedrive/ unless save_as is given), to read with read_file or process with a script. ' +
    'format: "pdf" converts Word, Excel, PowerPoint and other documents to PDF first (files up to about 2 MB).',
  parameters: {
    type: 'object',
    properties: {
      item: { type: 'string', description: 'File ID, OneDrive path like "/Documents/cv.docx", or share link.' },
      format: { type: 'string', enum: ['pdf'], description: 'Convert to PDF.' },
      save_as: { type: 'string', description: 'Workspace path to save to.' },
    },
    required: ['item'],
  },
  async run(input, { signal, conversationId, workspace: ws }) {
    const item = await getItem(input.item, 'item', signal);
    if (item.folder) throw new Error(`“${item.name}” is a folder. List it with onedrive_search folder="${item.id}".`);
    if (item.package) throw new Error(`“${item.name}” is a ${item.package.type ?? 'package'} and can't be downloaded as a file.`);
    const format = opt(input.format)?.toLowerCase().replace(/^\./, '');
    if (format && format !== 'pdf') throw new Error('format can only be "pdf".');
    let bytes: Uint8Array;
    let name = item.name;
    if (format === 'pdf' && extOf(item.name) !== 'pdf') {
      try {
        const res = await graphFetch(`${itemUrl(item)}/content?format=pdf`, { signal, headers: { Accept: '*/*' } });
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (e instanceof PluginApiError && [400, 406, 415, 501].includes(e.status)) {
          throw new Error(`OneDrive couldn't convert “${item.name}” to PDF (${e.message}). Conversion works for Office and similar documents up to about 2 MB; download it without format instead.`);
        }
        throw e;
      }
      name = `${item.name.replace(/\.[^.]+$/, '')}.pdf`;
    } else {
      if ((item.size ?? 0) > MAX_TRANSFER_BYTES) throw new Error(`“${item.name}” is ${formatSize(item.size ?? 0)}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);
      // The pre-authenticated download URL needs (and must not get) the Graph token.
      const direct = item['@microsoft.graph.downloadUrl'];
      if (direct) {
        const res = await fetch(direct, { signal });
        if (!res.ok) throw new Error(`OneDrive download failed (HTTP ${res.status}). Try again.`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const res = await graphFetch(`${itemUrl(item)}/content`, { signal, headers: { Accept: '*/*' } });
        bytes = new Uint8Array(await res.arrayBuffer());
      }
    }
    const { path, size } = await saveDownload({ ws, conversationId, bytes, name, dir: 'onedrive', saveAs: opt(input.save_as) });
    return { output: `Saved “${item.name}”${format === 'pdf' ? ' as PDF' : ''} to ${path} (${formatSize(size)}).`, files: [path] };
  },
};

/** Files up to this size upload in one request; larger ones use an upload session. */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Upload session chunk: a multiple of 320 KiB, under 10 MiB as Microsoft recommends. */
const CHUNK = 320 * 1024 * 30;
const CONFLICTS = ['rename', 'replace', 'fail'];

async function uploadInSession(parent: DriveItem, name: string, bytes: Uint8Array, conflict: string, signal: AbortSignal) {
  const session = await graph<{ uploadUrl: string }>(`${itemUrl(parent)}:/${enc(name)}:/createUploadSession`, {
    method: 'POST',
    json: { item: { '@microsoft.graph.conflictBehavior': conflict } },
    signal,
  });
  try {
    for (let start = 0; start < bytes.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, bytes.length);
      // The upload URL is pre-authenticated: sending the Graph token to it fails with 401.
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
        body: bytes.slice(start, end),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = text.slice(0, 300);
        try {
          message = JSON.parse(text).error?.message ?? message;
        } catch {}
        throw new Error(`OneDrive upload failed (HTTP ${res.status}${message ? `: ${message}` : ''}).`);
      }
      if (end === bytes.length) return (await res.json()) as DriveItem;
    }
    throw new Error('OneDrive upload ended without the file being created.');
  } catch (e) {
    fetch(session.uploadUrl, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

const onedriveUpload: Tool = {
  name: 'onedrive_upload',
  description:
    "Save a workspace file to the user's OneDrive, into folder (a path like \"/Documents\", an ID or share link; default the top folder). " +
    'conflict decides what happens when a file of that name exists: rename (default, keeps both), replace (overwrites it; OneDrive keeps the old version in its history) or fail. ' +
    'Returns the file’s ID and link.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace path of the file to upload.' },
      folder: { type: 'string', description: 'Destination folder. Default the top of OneDrive.' },
      name: { type: 'string', description: 'Name in OneDrive. Default the file’s name.' },
      conflict: { type: 'string', enum: CONFLICTS },
    },
    required: ['path'],
  },
  async run(input, { signal, workspace: ws }) {
    const file = await readUpload(ws, input.path);
    const conflict = opt(input.conflict) ?? 'rename';
    if (!CONFLICTS.includes(conflict)) throw new Error(`conflict must be one of: ${CONFLICTS.join(', ')}.`);
    const name = opt(input.name) ?? file.name;
    if (/[\\/:*?"<>|]/.test(name)) throw new Error(`"${name}" has characters OneDrive doesn't allow in names (\\ / : * ? " < > |).`);
    const parent = await getItem(opt(input.folder) ?? '/', 'folder', signal);
    if (!parent.folder) throw new Error(`“${parent.name}” is a file, not a folder.`);

    let item: DriveItem;
    if (file.size <= SIMPLE_UPLOAD_MAX) {
      const res = await graphFetch(`${itemUrl(parent)}:/${enc(name)}:/content?@microsoft.graph.conflictBehavior=${conflict}`, {
        method: 'PUT',
        headers: { 'Content-Type': file.mime },
        body: file.bytes.slice(),
        signal,
      });
      item = (await res.json()) as DriveItem;
    } else {
      item = await uploadInSession(parent, name, file.bytes, conflict, signal);
    }
    const renamed = item.name !== name ? ` (named “${item.name}” because “${name}” was taken)` : '';
    return { output: `Uploaded ${file.path} to OneDrive${renamed}.\n${describeItem(item)}` };
  },
};

const MANAGE_ACTIONS = ['create_folder', 'rename', 'move', 'copy', 'delete', 'share_link'];

const onedriveManage: Tool = {
  name: 'onedrive_manage',
  description:
    "Organise the user's OneDrive: create_folder (name, optional folder as parent), rename (item, name), move (item, folder, optional name), " +
    'copy (item, optional folder and name; runs in the background), delete (item: goes to the OneDrive recycle bin, restorable), ' +
    'or share_link (item: makes a view-only link anyone can open, or anyone in the organisation if the account doesn’t allow public links). ' +
    'Items and folders are IDs, OneDrive paths like "/Documents/a.docx", or share links.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: MANAGE_ACTIONS },
      item: { type: 'string', description: 'The file or folder to act on.' },
      name: { type: 'string', description: 'New name (create_folder, rename, move, copy).' },
      folder: { type: 'string', description: 'Destination or parent folder ("/" for the top).' },
    },
    required: ['action'],
  },
  async run(input, { signal }) {
    const action = str(input.action, 'action');
    const name = opt(input.name);
    const folder = async (fallback?: string) => {
      const ref = opt(input.folder) ?? fallback;
      if (!ref) throw new Error('Pass the destination folder.');
      const f = await getItem(ref, 'folder', signal);
      if (!f.folder) throw new Error(`“${f.name}” is a file, not a folder.`);
      return f;
    };
    switch (action) {
      case 'create_folder': {
        const parent = await folder('/');
        const f = await graph<DriveItem>(`${itemUrl(parent)}/children`, {
          method: 'POST',
          json: { name: str(input.name, 'name'), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
          signal,
        });
        return { output: `Created the folder.\n${describeItem(f)}` };
      }
      case 'rename': {
        const item = await getItem(input.item, 'item', signal);
        const f = await graph<DriveItem>(itemUrl(item), { method: 'PATCH', json: { name: str(input.name, 'name') }, signal });
        return { output: `Renamed “${item.name}” to “${f.name}”.\n${describeItem(f)}` };
      }
      case 'move': {
        const item = await getItem(input.item, 'item', signal);
        const dest = await folder();
        const f = await graph<DriveItem>(itemUrl(item), {
          method: 'PATCH',
          json: { parentReference: { id: dest.id }, ...(name ? { name } : {}) },
          signal,
        });
        return { output: `Moved “${item.name}” to ${itemPath(dest) || dest.name}.\n${describeItem(f)}` };
      }
      case 'copy': {
        const item = await getItem(input.item, 'item', signal);
        const dest = opt(input.folder) ? await folder() : undefined;
        const parentReference = dest
          ? { driveId: dest.parentReference?.driveId, id: dest.id }
          : { driveId: item.parentReference?.driveId, id: item.parentReference?.id };
        // Copies run asynchronously: Graph answers 202 with a monitor URL in Location.
        await graphFetch(`${itemUrl(item)}/copy?@microsoft.graph.conflictBehavior=rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentReference, ...(name ? { name } : {}) }),
          signal,
        });
        return {
          output: `Started copying “${item.name}”${name ? ` as “${name}”` : ''} into ${dest ? itemPath(dest) || dest.name : 'the same folder'}. OneDrive copies in the background; it should appear shortly (find it with onedrive_search).`,
        };
      }
      case 'delete': {
        const item = await getItem(input.item, 'item', signal);
        await graph(itemUrl(item), { method: 'DELETE', signal });
        return { output: `Deleted “${item.name}”. It is in the OneDrive recycle bin, where the user can restore it.` };
      }
      case 'share_link': {
        const item = await getItem(input.item, 'item', signal);
        type Permission = { link?: { webUrl?: string; scope?: string } };
        const create = (scope?: string) =>
          graph<Permission>(`${itemUrl(item)}/createLink`, { method: 'POST', json: { type: 'view', ...(scope ? { scope } : {}) }, signal });
        let perm: Permission;
        try {
          perm = await create('anonymous');
        } catch (e) {
          // Work accounts may have anonymous links turned off by an administrator.
          if (!(e instanceof PluginApiError) || e.status === 401 || e.status === 404 || e.status === 429) throw e;
          try {
            perm = await create('organization');
          } catch (e2) {
            if (!(e2 instanceof PluginApiError) || e2.status === 401 || e2.status === 404 || e2.status === 429) throw e2;
            perm = await create();
          }
        }
        const scope = perm.link?.scope;
        const who = scope === 'anonymous' ? 'anyone with the link' : scope === 'organization' ? 'people in the organisation' : 'people the link is shared with';
        return { output: `View-only link to “${item.name}” (${who} can open it):\n${perm.link?.webUrl ?? '[no link returned]'}` };
      }
      default:
        throw new Error(`Unknown action "${action}". Use one of: ${MANAGE_ACTIONS.join(', ')}.`);
    }
  },
};

// ---- Microsoft To Do -----------------------------------------------------------------------

type TodoList = { id: string; displayName: string; wellknownListName?: string; isOwner?: boolean; isShared?: boolean };
type TodoTask = {
  id: string;
  title?: string;
  status?: string;
  importance?: string;
  dueDateTime?: DateTimeTimeZone;
  reminderDateTime?: DateTimeTimeZone;
  isReminderOn?: boolean;
  completedDateTime?: DateTimeTimeZone;
  body?: ItemBody;
};

const IMPORTANCE = ['low', 'normal', 'high'];

async function todoLists(signal: AbortSignal) {
  const out: TodoList[] = [];
  let next: string | undefined = '/me/todo/lists';
  for (let page = 0; next && page < 5; page++) {
    const data: { value?: TodoList[]; '@odata.nextLink'?: string } = await graph(next, { signal });
    out.push(...(data.value ?? []));
    next = data['@odata.nextLink'];
  }
  return out;
}

/** A list from its ID or name; no value means the default list ("Tasks"). */
async function resolveList(value: unknown, signal: AbortSignal, lists?: TodoList[]) {
  const all = lists ?? (await todoLists(signal));
  const s = opt(value);
  const found = s
    ? (all.find((l) => l.id === s) ??
      all.find((l) => l.displayName.toLowerCase() === s.toLowerCase()) ??
      (/^(default|tasks)$/i.test(s) ? all.find((l) => l.wellknownListName === 'defaultList') : undefined))
    : (all.find((l) => l.wellknownListName === 'defaultList') ?? all[0]);
  if (!found) throw new Error(`No To Do list ${s ? `named "${s}"` : 'found'}. Lists: ${all.map((l) => l.displayName).join(', ') || 'none'}.`);
  return found;
}

function describeTask(t: TodoTask, tz: string, i?: number) {
  const bits = [
    t.status && t.status !== 'notStarted' ? t.status : '',
    t.importance === 'high' ? 'important' : '',
    t.dueDateTime ? `due ${showTime(t.dueDateTime, tz, true)}` : '',
    t.isReminderOn && t.reminderDateTime ? `reminder ${showTime(t.reminderDateTime, tz)}` : '',
  ].filter(Boolean);
  const notes = t.body?.content ? (t.body.contentType?.toLowerCase() === 'html' ? htmlToText(t.body.content) : t.body.content).replace(/\s+/g, ' ').trim() : '';
  return `${i != null ? `${i + 1}. ` : ''}${t.status === 'completed' ? '[x] ' : '[ ] '}${t.title || '(untitled)'}${bits.length ? ` (${bits.join(', ')})` : ''}${notes ? `\n   ${short(notes, 160)}` : ''}\n   id ${t.id}`;
}

const TASK_FIELDS = 'id,title,status,importance,dueDateTime,reminderDateTime,isReminderOn,completedDateTime,body';

const todoList: Tool = {
  name: 'todo_list',
  description:
    "Show the user's Microsoft To Do lists and their open tasks (show_completed: true includes finished ones), with due dates, reminders and IDs. " +
    'list narrows to one list (name or ID); without it, every list is shown.',
  parameters: {
    type: 'object',
    properties: {
      list: { type: 'string', description: 'List name or ID. Default all lists.' },
      show_completed: { type: 'boolean' },
      count: { type: 'integer', description: 'Most tasks per list, 1-100. Default 30.' },
      time_zone: { type: 'string', description: 'IANA time zone to show times in. Default the device’s.' },
    },
  },
  async run(input, { signal }) {
    const tz = zoneOf(input.time_zone);
    const all = await todoLists(signal);
    const lists = opt(input.list) ? [await resolveList(input.list, signal, all)] : all;
    const top = int(input.count, 30, 1, 100);
    const sections: string[] = [];
    for (const l of lists) {
      const data = await graph<{ value?: TodoTask[]; '@odata.nextLink'?: string }>(
        `/me/todo/lists/${enc(l.id)}/tasks${qs({ $filter: bool(input.show_completed) ? undefined : "status ne 'completed'", $top: top, $select: TASK_FIELDS })}`,
        { signal, headers: { Prefer: preferZone(tz) } }
      );
      const tasks = data.value ?? [];
      const head = `## ${l.displayName}${l.wellknownListName === 'defaultList' ? ' (default)' : ''}${l.isShared ? ' (shared)' : ''} · list id ${l.id}`;
      const more = data['@odata.nextLink'] ? `\n   [More tasks in this list; pass list and a higher count.]` : '';
      sections.push(`${head}\n${tasks.length ? tasks.map((t, i) => describeTask(t, tz, i)).join('\n') : bool(input.show_completed) ? '(no tasks)' : '(no open tasks)'}${more}`);
    }
    return { output: clip(sections.join('\n\n') || 'No To Do lists.') };
  },
};

/** dueDateTime for a date (To Do keeps only the date). */
const dueOf = (value: unknown, tz: string) => ({ dateTime: `${parseWhen(value, tz, 'due').wall.slice(0, 10)}T00:00:00`, timeZone: tz });

function reminderOf(value: unknown, tz: string) {
  const r = parseWhen(value, tz, 'reminder');
  // A bare date reminds at 9:00, as To Do does.
  return { dateTime: r.dateOnly ? `${r.wall.slice(0, 10)}T09:00:00` : r.wall, timeZone: tz };
}

const todoAdd: Tool = {
  name: 'todo_add',
  description:
    "Add a task to Microsoft To Do, in list (name or ID; default the user's default Tasks list). due is a date (To Do keeps only the day); " +
    "reminder is a date-time in the user's time zone unless an offset is given.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      list: { type: 'string', description: 'List name or ID.' },
      notes: { type: 'string', description: 'Task notes.' },
      due: { type: 'string', description: 'Due date, e.g. 2026-11-28.' },
      reminder: { type: 'string', description: 'Reminder time, e.g. 2026-11-28T09:00.' },
      importance: { type: 'string', enum: IMPORTANCE },
      time_zone: { type: 'string', description: 'IANA time zone. Default the device’s.' },
    },
    required: ['title'],
  },
  async run(input, { signal }) {
    const tz = zoneOf(input.time_zone);
    const l = await resolveList(input.list, signal);
    const importance = opt(input.importance);
    if (importance && !IMPORTANCE.includes(importance)) throw new Error(`importance must be one of: ${IMPORTANCE.join(', ')}.`);
    const notes = opt(input.notes ?? input.body);
    const task = await graph<TodoTask>(`/me/todo/lists/${enc(l.id)}/tasks`, {
      method: 'POST',
      json: {
        title: str(input.title, 'title'),
        ...(notes ? { body: { content: notes, contentType: 'text' } } : {}),
        ...(opt(input.due) ? { dueDateTime: dueOf(input.due, tz) } : {}),
        ...(opt(input.reminder) ? { reminderDateTime: reminderOf(input.reminder, tz), isReminderOn: true } : {}),
        ...(importance ? { importance } : {}),
      },
      signal,
      headers: { Prefer: preferZone(tz) },
    });
    return { output: `Added to “${l.displayName}” (list id ${l.id}):\n${describeTask(task, tz)}` };
  },
};

/** A task by ID or exact title, in one list or all of them. */
async function findTask(taskArg: unknown, listArg: unknown, signal: AbortSignal) {
  const key = str(taskArg, 'task').trim();
  const all = await todoLists(signal);
  const lists = opt(listArg) ? [await resolveList(listArg, signal, all)] : all;
  const byTitle: { list: TodoList; task: TodoTask }[] = [];
  for (const l of lists) {
    if (key.length > 40 && /^[A-Za-z0-9+/_=-]+$/.test(key)) {
      try {
        const task = await graph<TodoTask>(`/me/todo/lists/${enc(l.id)}/tasks/${enc(key)}${qs({ $select: TASK_FIELDS })}`, { signal });
        return { list: l, task };
      } catch (e) {
        if (!(e instanceof PluginApiError) || (e.status !== 404 && e.status !== 400)) throw e;
        continue;
      }
    }
    let next: string | undefined = `/me/todo/lists/${enc(l.id)}/tasks${qs({ $top: 100, $select: TASK_FIELDS })}`;
    for (let page = 0; next && page < 10; page++) {
      const data: { value?: TodoTask[]; '@odata.nextLink'?: string } = await graph(next, { signal });
      for (const t of data.value ?? []) if (t.title?.trim().toLowerCase() === key.toLowerCase()) byTitle.push({ list: l, task: t });
      next = data['@odata.nextLink'];
    }
  }
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    const open = byTitle.filter((m) => m.task.status !== 'completed');
    if (open.length === 1) return open[0];
    throw new Error(`${byTitle.length} tasks are titled "${key}" (in ${[...new Set(byTitle.map((m) => m.list.displayName))].join(', ')}). Pass the task ID from todo_list.`);
  }
  throw new Error(`No To Do task "${key}"${opt(listArg) ? ` in "${opt(listArg)}"` : ''}. Find its ID with todo_list.`);
}

const todoUpdate: Tool = {
  name: 'todo_update',
  description:
    'Change a Microsoft To Do task (by ID from todo_list, or exact title): title, notes, due date, reminder, importance, completed: true/false, ' +
    'or delete: true (permanent; there is no recycle bin for tasks). Passing list makes finding the task quicker.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task ID or exact title.' },
      list: { type: 'string', description: 'List name or ID the task is in.' },
      title: { type: 'string' },
      notes: { type: 'string' },
      due: { type: 'string', description: 'New due date, or "none" to clear it.' },
      reminder: { type: 'string', description: 'New reminder time, or "none" to clear it.' },
      importance: { type: 'string', enum: IMPORTANCE },
      completed: { type: 'boolean' },
      delete: { type: 'boolean' },
      time_zone: { type: 'string', description: 'IANA time zone. Default the device’s.' },
    },
    required: ['task'],
  },
  async run(input, { signal }) {
    const tz = zoneOf(input.time_zone);
    const { list: l, task } = await findTask(input.task, input.list, signal);
    const path = `/me/todo/lists/${enc(l.id)}/tasks/${enc(task.id)}`;
    if (bool(input.delete)) {
      await graph(path, { method: 'DELETE', signal });
      return { output: `Deleted the task “${task.title}” from “${l.displayName}”.` };
    }
    const patch: Record<string, unknown> = {};
    if (opt(input.title)) patch.title = input.title.trim();
    if (input.notes != null) patch.body = { content: String(input.notes), contentType: 'text' };
    const none = (v: unknown) => typeof v === 'string' && /^(none|null|clear)$/i.test(v.trim());
    if (none(input.due)) patch.dueDateTime = null;
    else if (opt(input.due)) patch.dueDateTime = dueOf(input.due, tz);
    if (none(input.reminder)) Object.assign(patch, { isReminderOn: false, reminderDateTime: null });
    else if (opt(input.reminder)) Object.assign(patch, { reminderDateTime: reminderOf(input.reminder, tz), isReminderOn: true });
    const importance = opt(input.importance);
    if (importance) {
      if (!IMPORTANCE.includes(importance)) throw new Error(`importance must be one of: ${IMPORTANCE.join(', ')}.`);
      patch.importance = importance;
    }
    if (input.completed != null) patch.status = bool(input.completed) ? 'completed' : 'notStarted';
    if (!Object.keys(patch).length) throw new Error('Nothing to change: pass title, notes, due, reminder, importance, completed or delete.');
    const updated = await graph<TodoTask>(path, { method: 'PATCH', json: patch, signal, headers: { Prefer: preferZone(tz) } });
    return { output: `Updated the task in “${l.displayName}”:\n${describeTask(updated, tz)}` };
  },
};

export const MICROSOFT_TOOLS: Tool[] = [
  outlookSearch,
  outlookRead,
  outlookSend,
  outlookMove,
  outlookCalendarEvents,
  outlookCalendarCreate,
  outlookCalendarUpdate,
  onedriveSearch,
  onedriveDownload,
  onedriveUpload,
  onedriveManage,
  todoList,
  todoAdd,
  todoUpdate,
];

const count = (i: Record<string, unknown>, key: string) => list(i[key]).length;

export const MICROSOFT_LABELS: ToolLabels = {
  outlook_search: (i) => (field(i, 'query') ? `Search Outlook “${short(field(i, 'query'))}”` : field(i, 'unread_only') || i.unread_only ? 'List unread Outlook mail' : 'List recent Outlook mail'),
  outlook_read: (i) => (i.conversation ? 'Read an Outlook conversation' : 'Read an Outlook message'),
  outlook_send: (i) => {
    const subject = field(i, 'subject');
    const verb = i.send === true || i.send === 'true' ? 'Send' : 'Draft';
    if (field(i, 'forward')) return `${verb} a forward`;
    if (field(i, 'reply_to')) return `${verb} a reply${i.reply_all ? ' to all' : ''}`;
    return subject ? `${verb} “${short(subject)}”` : `${verb} an email`;
  },
  outlook_move: (i) => {
    if (i.list_folders) return 'List Outlook folders';
    const n = count(i, 'message_ids');
    const what = n === 1 ? 'a message' : `${n} messages`;
    if (i.delete) return `Delete ${what}`;
    if (field(i, 'folder')) return `Move ${what} to ${short(field(i, 'folder'), 30)}`;
    if (field(i, 'flag')) return `${field(i, 'flag') === 'notFlagged' ? 'Unflag' : 'Flag'} ${what}`;
    return `Mark ${what} ${i.mark_read === false ? 'unread' : 'read'}`;
  },
  outlook_calendar_events: (i) =>
    i.list_calendars ? 'List Outlook calendars' : field(i, 'query') ? `Find events “${short(field(i, 'query'))}”` : 'Check Outlook Calendar',
  outlook_calendar_create: (i) => `Create event “${short(field(i, 'subject'))}”`,
  outlook_calendar_update: (i) =>
    i.delete ? 'Delete an event' : i.cancel ? 'Cancel an event' : field(i, 'response') ? `${field(i, 'response').replace(/^./, (c) => c.toUpperCase())} an invitation` : 'Update an event',
  onedrive_search: (i) => (field(i, 'query') ? `Search OneDrive “${short(field(i, 'query'))}”` : `List OneDrive ${field(i, 'folder') ? short(field(i, 'folder'), 40) : 'files'}`),
  onedrive_download: (i) => `Download ${field(i, 'item') && !/^https?:/i.test(field(i, 'item')) && field(i, 'item').includes('/') ? short(field(i, 'item').split('/').pop()!, 40) : 'a file'} from OneDrive${field(i, 'format') ? ' as PDF' : ''}`,
  onedrive_upload: (i) => `Upload ${short(field(i, 'path').split('/').pop() || 'a file', 40)} to OneDrive`,
  onedrive_manage: (i) =>
    ({
      create_folder: `Create OneDrive folder “${short(field(i, 'name'))}”`,
      rename: `Rename to “${short(field(i, 'name'))}”`,
      move: 'Move a OneDrive item',
      copy: 'Copy a OneDrive item',
      delete: 'Delete a OneDrive item',
      share_link: 'Make a OneDrive share link',
    })[field(i, 'action')] ?? 'Organise OneDrive',
  todo_list: (i) => (field(i, 'list') ? `See To Do list “${short(field(i, 'list'))}”` : 'See To Do tasks'),
  todo_add: (i) => `Add task “${short(field(i, 'title'))}”`,
  todo_update: (i) =>
    i.delete
      ? 'Delete a task'
      : i.completed === true
        ? field(i, 'task').length > 40
          ? 'Complete a task'
          : `Complete “${field(i, 'task')}”`
        : `Update task${field(i, 'title') ? ` “${short(field(i, 'title'))}”` : ''}`,
};
