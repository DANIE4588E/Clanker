import { googleFetch, googleJson, PluginApiError } from '../plugins/auth';
import { formatSize, type Workspace } from '../workspace';
import { fileIdOf } from './google';
import type { Tool } from './index';
import {
  clip,
  field,
  fromBase64,
  htmlToText,
  int,
  list,
  MAX_OUTPUT_CHARS,
  multipartRelated,
  opt,
  readUpload,
  saveDownload,
  short,
  str,
  strings,
  toBase64,
  type ToolLabels,
} from './pluginUtil';

/**
 * Tools for the Gmail, Google Calendar, Google Slides and Google Tasks plugins. They act on the
 * user's real mail, calendar, decks and to-dos through Google's REST APIs; the plugin catalog
 * decides which are offered.
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const SLIDES = 'https://slides.googleapis.com/v1/presentations';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';

/** Models send booleans as strings now and then. */
const flag = (value: unknown) => value === true || value === 'true';

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Dates and times ------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-11-27 09:00" in the device's time zone. */
const localStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDate = (d: Date) => localStamp(d).slice(0, 10);

/** "Thu 2026-11-27" for a calendar date. */
function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${date}`;
}

function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO 8601 date or date-time without a zone offset. */
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/** The instant an ISO 8601 value names; values without a zone are in the device's time zone. */
function instant(value: unknown, name: string): Date {
  const s = str(value, name).trim();
  const m = s.match(NAIVE);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} "${s}" is not an ISO 8601 date or time (e.g. 2026-11-27 or 2026-11-27T09:00).`);
  return d;
}

/** A calendar date (YYYY-MM-DD) from a date or date-time, in the device's time zone. */
const dateOf = (value: unknown, name: string) => {
  const s = str(value, name).trim();
  return DATE_ONLY.test(s) ? s : localDate(instant(s, name));
};

// ---- Gmail ----------------------------------------------------------------------------------

type Header = { name: string; value: string };
type MessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: MessagePart[];
};
type GmailMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: MessagePart };
type GmailLabel = { id: string; name: string; type?: 'system' | 'user' };
type AttachmentInfo = { name: string; mime: string; size: number; attachmentId?: string; data?: string };

const headerOf = (headers: Header[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** A Gmail message or thread ID, also from an old-style Gmail link (…#inbox/18c2…). */
function gmailIdOf(value: unknown, name: string) {
  const s = str(value, name).trim();
  const m = s.match(/#[^/]+\/([0-9a-f]{10,})\/?$/i) ?? s.match(/^([\w-]{6,})$/);
  if (!m) throw new Error(`${name} "${s}" is not a Gmail ID. Use the id or thread id gmail_search returned.`);
  return m[1];
}

const threadLink = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;
const messageDate = (m: GmailMessage) => (m.internalDate ? localStamp(new Date(Number(m.internalDate))) : '');

const getLabels = (signal: AbortSignal) =>
  googleJson<{ labels?: GmailLabel[] }>(`${GMAIL}/labels`, { signal }).then((r) => r.labels ?? []);

/** A label's name as shown to the model: user labels as named, system ones lower-cased. */
const labelName = (l: GmailLabel) => (l.type === 'system' ? l.name.replace(/^CATEGORY_/, '').toLowerCase() : l.name);

function decodeText(data: string, charset: string) {
  const bytes = fromBase64(data);
  const cs = charset.toLowerCase();
  if (/^(iso-8859-1|latin1|windows-1252|cp1252|us-ascii|ascii)$/.test(cs)) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  try {
    return new TextDecoder(cs && cs !== 'utf8' ? cs : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** A message's plain text (or its HTML as text) and its attachments. */
function contentOf(payload: MessagePart | undefined) {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: AttachmentInfo[] = [];
  const visit = (part: MessagePart) => {
    if (part.parts?.length) {
      part.parts.forEach(visit);
      return;
    }
    const mime = (part.mimeType ?? '').toLowerCase();
    if (part.filename) {
      attachments.push({ name: part.filename, mime, size: part.body?.size ?? 0, attachmentId: part.body?.attachmentId, data: part.body?.data });
      return;
    }
    const data = part.body?.data;
    if (!data) return;
    const charset = headerOf(part.headers, 'Content-Type').match(/charset="?([^";\s]+)/i)?.[1] ?? 'utf-8';
    if (mime === 'text/plain') plain.push(decodeText(data, charset));
    else if (mime === 'text/html') html.push(decodeText(data, charset));
  };
  if (payload) visit(payload);
  const text = plain.some((t) => t.trim()) ? plain.join('\n\n') : html.map(htmlToText).join('\n\n');
  return { text: text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), attachments };
}

/** Drops quoted earlier messages ("> …" lines and their "On … wrote:" intro) from a reply. */
function withoutQuotes(text: string) {
  const lines = text.split('\n');
  const kept = lines.filter((l) => !/^\s*>/.test(l));
  if (kept.length === lines.length) return text;
  while (kept.length && (!kept[kept.length - 1].trim() || /wrote:\s*$/.test(kept[kept.length - 1]))) kept.pop();
  return `${kept.join('\n').trim()}\n[quoted text hidden]`;
}

function renderMessage(m: GmailMessage, labels: Map<string, GmailLabel>, opts: { hideQuotes: boolean; maxBody: number }) {
  const h = m.payload?.headers;
  const { text, attachments } = contentOf(m.payload);
  const lines = [`## ${headerOf(h, 'Subject') || '(no subject)'}`];
  for (const name of ['From', 'To', 'Cc', 'Reply-To']) {
    const v = headerOf(h, name);
    if (v) lines.push(`${name}: ${v}`);
  }
  lines.push(`Date: ${messageDate(m)}`);
  const tags = (m.labelIds ?? []).map((id) => (labels.get(id) ? labelName(labels.get(id)!) : id)).filter((n) => n !== 'unread');
  const unread = m.labelIds?.includes('UNREAD') ? 'unread · ' : '';
  lines.push(`id ${m.id} · thread ${m.threadId} · ${unread}labels: ${tags.join(', ') || 'none'}`);
  const body = opts.hideQuotes ? withoutQuotes(text) : text;
  lines.push('', body ? clip(body, opts.maxBody) : '[No text body.]');
  if (attachments.length) {
    lines.push('', 'Attachments:');
    for (const a of attachments) lines.push(`- ${a.name} (${a.mime || 'file'}, ${formatSize(a.size)})`);
  }
  return { text: lines.join('\n'), attachments };
}

const gmailSearch: Tool = {
  name: 'gmail_search',
  description:
    "Search the user's Gmail with Gmail search syntax (from:, to:, subject:, is:unread, newer_than:7d, after:2026/11/01, has:attachment, label:, in:sent …). " +
    'With no query, lists the newest mail. Returns sender, recipients, subject, date, snippet, labels and unread state, with each message id and thread id for gmail_read and gmail_modify.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query, as typed in the Gmail search box.' },
      count: { type: 'integer', description: 'How many messages, 1-50. Default 15.' },
      page_token: { type: 'string', description: 'next_page_token from a previous search, for more results.' },
    },
  },
  async run(input, { signal }) {
    const params = new URLSearchParams({ maxResults: String(int(input.count, 15, 1, 50)) });
    const query = opt(input.query);
    if (query) params.set('q', query);
    if (opt(input.page_token)) params.set('pageToken', input.page_token.trim());
    const [found, labels] = await Promise.all([
      googleJson<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(`${GMAIL}/messages?${params}`, {
        signal,
      }),
      getLabels(signal),
    ]);
    const ids = found.messages ?? [];
    if (!ids.length) return { output: query ? `No messages match “${query}”.` : 'The mailbox is empty.' };
    const byId = new Map(labels.map((l) => [l.id, l]));
    const meta = ['From', 'To', 'Subject'].map((h) => `metadataHeaders=${h}`).join('&');
    const messages = await mapLimit(ids, 10, (m) => googleJson<GmailMessage>(`${GMAIL}/messages/${m.id}?format=metadata&${meta}`, { signal }));
    const lines = messages.map((m, i) => {
      const h = m.payload?.headers;
      const tags = (m.labelIds ?? [])
        .filter((id) => id !== 'UNREAD')
        .map((id) => (byId.get(id) ? labelName(byId.get(id)!) : id));
      return (
        `${i + 1}. ${m.labelIds?.includes('UNREAD') ? '[unread] ' : ''}${headerOf(h, 'Subject') || '(no subject)'}\n` +
        `   from ${headerOf(h, 'From')} · to ${short(headerOf(h, 'To'), 80)} · ${messageDate(m)}${tags.length ? ` · ${tags.join(', ')}` : ''}\n` +
        `   ${(m.snippet ?? '').replace(/\s+/g, ' ').trim()}\n` +
        `   id ${m.id} · thread ${m.threadId}`
      );
    });
    const more = found.nextPageToken ? `\n\n[More results: pass page_token "${found.nextPageToken}".]` : '';
    return { output: clip(lines.join('\n') + more) };
  },
};

/** Saves the chosen attachments of a message into the workspace under gmail/. */
async function saveAttachments(
  ws: Workspace,
  conversationId: string,
  messageId: string,
  attachments: AttachmentInfo[],
  which: unknown,
  signal: AbortSignal
) {
  const names = strings(which).map((n) => n.toLowerCase());
  const wanted = flag(which) || names.includes('all') || names.includes('true') ? null : names;
  const chosen = attachments.filter((a) => !wanted || wanted.includes(a.name.toLowerCase()));
  const saved: string[] = [];
  for (const a of chosen) {
    const data = a.attachmentId
      ? (await googleJson<{ data?: string }>(`${GMAIL}/messages/${messageId}/attachments/${a.attachmentId}`, { signal })).data
      : a.data;
    if (!data) continue;
    const { path } = await saveDownload({ ws, conversationId, bytes: fromBase64(data), name: a.name, dir: 'gmail' });
    saved.push(path);
  }
  return saved;
}

const gmailRead: Tool = {
  name: 'gmail_read',
  description:
    'Read a Gmail message (message_id) or a whole conversation (thread_id, every message in order, with quoted earlier text hidden). ' +
    'Shows headers, the text body and attachments. save_attachments: ["all"] saves every attachment into the workspace under gmail/ ' +
    '(or list attachment file names to save only those), to open with read_file or other tools.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Message id from gmail_search.' },
      thread_id: { type: 'string', description: 'Thread id from gmail_search, to read the whole conversation.' },
      save_attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Attachment file names to save into the workspace, or ["all"] (true also works) for every attachment.',
      },
    },
  },
  async run(input, { signal, conversationId, workspace: ws }) {
    if (!opt(input.message_id) && !opt(input.thread_id)) throw new Error('Pass message_id or thread_id.');
    const labelsP = getLabels(signal);
    let messages: GmailMessage[];
    let header = '';
    if (opt(input.thread_id)) {
      const thread = await googleJson<{ id: string; messages?: GmailMessage[] }>(`${GMAIL}/threads/${gmailIdOf(input.thread_id, 'thread_id')}?format=full`, {
        signal,
      });
      messages = thread.messages ?? [];
      header = `Thread ${thread.id} · ${plural(messages.length, 'message')} · ${threadLink(thread.id)}\n\n`;
    } else {
      const m = await googleJson<GmailMessage>(`${GMAIL}/messages/${gmailIdOf(input.message_id, 'message_id')}?format=full`, { signal });
      messages = [m];
      header = `${threadLink(m.threadId)}\n\n`;
    }
    const labels = new Map((await labelsP).map((l) => [l.id, l]));
    const isThread = messages.length > 1;
    const maxBody = isThread ? Math.max(3000, Math.floor((MAX_OUTPUT_CHARS - 2000) / messages.length)) : MAX_OUTPUT_CHARS - 2000;
    const files: string[] = [];
    const parts: string[] = [];
    const wantSave = input.save_attachments != null && input.save_attachments !== false && input.save_attachments !== 'false';
    for (const m of messages) {
      const r = renderMessage(m, labels, { hideQuotes: isThread, maxBody });
      parts.push(r.text);
      if (wantSave && r.attachments.length) files.push(...(await saveAttachments(ws, conversationId, m.id, r.attachments, input.save_attachments, signal)));
    }
    const saved = wantSave ? `\n\n${files.length ? `Saved to the workspace: ${files.join(', ')}` : 'No matching attachments to save.'}` : '';
    return { output: clip(header + parts.join('\n\n---\n\n') + saved), ...(files.length ? { files } : {}) };
  },
};

// MIME building for gmail_send. Everything is kept 7-bit: non-ASCII headers become RFC 2047
// encoded-words and bodies are base64, so the message is plain ASCII text.

const utf8 = new TextEncoder();
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 encoded-words for a header value, split so each stays under 76 characters. */
function encodeWord(s: string, fold = '\r\n ') {
  if (isAscii(s)) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (chunk && utf8.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${toBase64(utf8.encode(w))}?=`).join(fold);
}

/** An address header item, with a non-ASCII display name encoded: "José <j@x.com>". */
function encodeAddress(a: string) {
  const m = oneLine(a).match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (!m || !m[1].trim()) return oneLine(a).replace(/^<|>$/g, '');
  const name = m[1].trim();
  return `${isAscii(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeWord(name)} <${m[2].trim()}>`;
}

const base64Lines = (bytes: Uint8Array) => toBase64(bytes).replace(/.{1,76}/g, '$&\r\n');
const boundary = () => `=_clanker_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

type MailFile = { name: string; mime: string; bytes: Uint8Array };

/** An RFC 2822 message: text (and HTML) body, attachments as multipart/mixed. */
function buildMime(m: { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html?: string; headers: Record<string, string>; files: MailFile[] }) {
  const head: string[] = ['MIME-Version: 1.0'];
  if (m.to.length) head.push(`To: ${m.to.map(encodeAddress).join(', ')}`);
  if (m.cc.length) head.push(`Cc: ${m.cc.map(encodeAddress).join(', ')}`);
  if (m.bcc.length) head.push(`Bcc: ${m.bcc.map(encodeAddress).join(', ')}`);
  head.push(`Subject: ${encodeWord(oneLine(m.subject))}`);
  for (const [k, v] of Object.entries(m.headers)) if (v) head.push(`${k}: ${oneLine(v)}`);

  const textPart = (type: string, content: string) =>
    `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(utf8.encode(content))}`;
  let body = textPart('text/plain', m.text.replace(/\r?\n/g, '\r\n'));
  if (m.html != null) {
    const b = boundary();
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${body}--${b}\r\n${textPart('text/html', m.html)}--${b}--\r\n`;
  }
  if (m.files.length) {
    const b = boundary();
    const files = m.files.map((f) => {
      const name = oneLine(f.name).replace(/"/g, "'");
      const quoted = isAscii(name) ? name : encodeWord(name, ' ');
      const star = isAscii(name) ? '' : `; filename*=UTF-8''${encodeURIComponent(name)}`;
      return (
        `Content-Type: ${f.mime}; name="${quoted}"\r\nContent-Disposition: attachment; filename="${quoted}"${star}\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${base64Lines(f.bytes)}`
      );
    });
    body = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}${files.map((f) => `--${b}\r\n${f}`).join('')}--${b}--\r\n`;
  }
  return `${head.join('\r\n')}\r\n${body}`;
}

/** Gmail's limit for attachments on a sent message. */
const MAX_MAIL_ATTACHMENTS = 25 * 1024 * 1024;
/** Messages bigger than this go through the upload endpoint rather than as JSON. */
const MAX_JSON_MESSAGE = 4 * 1024 * 1024;

const reSubject = (prefix: 'Re' | 'Fwd', subject: string) =>
  new RegExp(`^${prefix === 'Re' ? 're' : 'fwd?'}:`, 'i').test(subject.trim()) ? subject.trim() : `${prefix}: ${subject.trim()}`;

/** Splits "a@x.com, B <b@y.com>" header lists into addresses, keeping quoted names intact. */
const splitAddresses = (value: string) =>
  (value.match(/(?:"[^"]*"|[^,"])+/g) ?? []).map((s) => s.trim()).filter(Boolean);
const bareEmail = (a: string) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase();

const gmailSend: Tool = {
  name: 'gmail_send',
  description:
    'Write an email from the user’s Gmail: saved as a draft by default (the user can review it in Gmail); it is sent only with send: true, which you use only when the user asked to send. ' +
    'reply_to (a message id) replies in that thread: it addresses the sender (reply_all: true adds everyone else), sets the threading headers and uses "Re: <subject>" unless subject is given. ' +
    'forward (a message id) forwards that message with its attachments below body. attachments are workspace file paths. ' +
    'draft_id with send: true sends a draft made earlier, unchanged.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses, e.g. ["sam@example.com", "Ana Diaz <ana@example.com>"].' },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      body: { type: 'string', description: 'The message, plain text (or HTML with html: true).' },
      html: { type: 'boolean', description: 'body is HTML. Default false.' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Workspace paths of files to attach.' },
      reply_to: { type: 'string', description: 'Message id to reply to.' },
      reply_all: { type: 'boolean', description: 'With reply_to: also address everyone on the original. Default false.' },
      forward: { type: 'string', description: 'Message id to forward.' },
      send: { type: 'boolean', description: 'Send now instead of saving a draft. Default false.' },
      draft_id: { type: 'string', description: 'With send: true, the id of an existing draft to send as it is.' },
    },
  },
  async run(input, { signal, workspace: ws }) {
    const send = flag(input.send);

    if (opt(input.draft_id)) {
      if (!send) throw new Error('draft_id is for sending an existing draft: pass send: true with it.');
      const sent = await googleJson<GmailMessage>(`${GMAIL}/drafts/send`, { method: 'POST', json: { id: input.draft_id.trim() }, signal });
      return { output: `Sent the draft ${input.draft_id.trim()} (message id ${sent.id}, thread ${sent.threadId}). ${threadLink(sent.threadId)}` };
    }
    if (opt(input.reply_to) && opt(input.forward)) throw new Error('Pass reply_to or forward, not both.');

    let to = strings(input.to);
    const cc = strings(input.cc);
    const bcc = strings(input.bcc);
    let subject = opt(input.subject) ?? '';
    const headers: Record<string, string> = {};
    let threadId: string | undefined;
    const files: MailFile[] = [];
    let text = typeof input.body === 'string' ? input.body : '';
    let html = flag(input.html) ? text : undefined;
    if (html != null) text = htmlToText(html);

    if (opt(input.reply_to)) {
      const id = gmailIdOf(input.reply_to, 'reply_to');
      const meta = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Message-ID', 'References'].map((h) => `metadataHeaders=${h}`).join('&');
      const original = await googleJson<GmailMessage>(`${GMAIL}/messages/${id}?format=metadata&${meta}`, { signal });
      const h = original.payload?.headers;
      threadId = original.threadId;
      const messageId = headerOf(h, 'Message-ID');
      if (messageId) {
        headers['In-Reply-To'] = messageId;
        headers.References = `${headerOf(h, 'References')} ${messageId}`.trim();
      }
      if (!subject) subject = reSubject('Re', headerOf(h, 'Subject'));
      if (!to.length) {
        // Replying to one's own sent message goes to its recipients, as Gmail does.
        const mine = original.labelIds?.includes('SENT');
        to = splitAddresses(mine ? headerOf(h, 'To') : headerOf(h, 'Reply-To') || headerOf(h, 'From'));
        if (flag(input.reply_all)) {
          const { emailAddress } = await googleJson<{ emailAddress: string }>(`${GMAIL}/profile`, { signal });
          const taken = new Set([emailAddress.toLowerCase(), ...to.map(bareEmail), ...cc.map(bareEmail)]);
          for (const a of splitAddresses(`${headerOf(h, 'To')},${headerOf(h, 'Cc')}`)) {
            if (!taken.has(bareEmail(a))) {
              cc.push(a);
              taken.add(bareEmail(a));
            }
          }
        }
      }
    } else if (opt(input.forward)) {
      const id = gmailIdOf(input.forward, 'forward');
      const original = await googleJson<GmailMessage>(`${GMAIL}/messages/${id}?format=full`, { signal });
      const h = original.payload?.headers;
      const content = contentOf(original.payload);
      if (!subject) subject = reSubject('Fwd', headerOf(h, 'Subject'));
      const quoted = [
        '---------- Forwarded message ---------',
        `From: ${headerOf(h, 'From')}`,
        `Date: ${headerOf(h, 'Date')}`,
        `Subject: ${headerOf(h, 'Subject')}`,
        `To: ${headerOf(h, 'To')}`,
        ...(headerOf(h, 'Cc') ? [`Cc: ${headerOf(h, 'Cc')}`] : []),
        '',
        content.text,
      ].join('\n');
      text = `${text}\n\n${quoted}`.trim();
      if (html != null) html = `${html}<br><br><pre style="white-space:pre-wrap;font-family:inherit">${quoted.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
      for (const a of content.attachments) {
        const data = a.attachmentId
          ? (await googleJson<{ data?: string }>(`${GMAIL}/messages/${original.id}/attachments/${a.attachmentId}`, { signal })).data
          : a.data;
        if (data) files.push({ name: a.name, mime: a.mime || 'application/octet-stream', bytes: fromBase64(data) });
      }
    }

    for (const path of strings(input.attachments)) {
      const up = await readUpload(ws, path);
      files.push({ name: up.name, mime: up.mime, bytes: up.bytes });
    }
    const attached = files.reduce((n, f) => n + f.bytes.length, 0);
    if (attached > MAX_MAIL_ATTACHMENTS) {
      throw new Error(`The attachments come to ${formatSize(attached)}, over Gmail’s 25 MB limit. Upload them to Drive and send a link instead.`);
    }
    if (send && !to.length && !cc.length && !bcc.length) throw new Error('Pass at least one recipient in to, cc or bcc.');
    if (!subject && !text.trim() && !files.length) throw new Error('Pass a subject or body.');

    const mime = buildMime({ to, cc, bcc, subject, text, html, headers, files });
    const raw = toBase64(utf8.encode(mime)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const message = { raw, ...(threadId ? { threadId } : {}) };

    // Large messages go through the media upload endpoint: JSON metadata, then the message itself.
    const big = mime.length > MAX_JSON_MESSAGE;
    const post = async <T>(path: 'messages/send' | 'drafts', meta: object, json: object) => {
      if (!big) return googleJson<T>(`${GMAIL}/${path}`, { method: 'POST', json, signal });
      const { body, contentType } = multipartRelated(meta, utf8.encode(mime), 'message/rfc822');
      const res = await googleFetch(`${GMAIL_UPLOAD}/${path}?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal });
      return (await res.json()) as T;
    };

    const who = [...to, ...cc, ...bcc].map(bareEmail).join(', ') || 'no recipients yet';
    const extras = files.length ? ` with ${plural(files.length, 'attachment')}` : '';
    if (send) {
      const sent = await post<GmailMessage>('messages/send', threadId ? { threadId } : {}, message);
      return { output: `Sent “${subject || '(no subject)'}” to ${who}${extras} (message id ${sent.id}, thread ${sent.threadId}). ${threadLink(sent.threadId)}` };
    }
    const meta = { message: threadId ? { threadId } : {} };
    const draft = await post<{ id: string; message: GmailMessage }>('drafts', meta, { message });
    return {
      output:
        `Saved a draft “${subject || '(no subject)'}” to ${who}${extras}. It has NOT been sent.\n` +
        `draft id ${draft.id} · message id ${draft.message.id}${draft.message.threadId ? ` · thread ${draft.message.threadId}` : ''}\n` +
        `Review it in Gmail: https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}\n` +
        'To send it as it is, call gmail_send with draft_id and send: true (only if the user asks).',
    };
  },
};

const gmailModify: Tool = {
  name: 'gmail_modify',
  description:
    'Organise Gmail messages or whole threads: add_labels / remove_labels (label names or ids; missing labels are created when adding), archive (out of the inbox), ' +
    'mark_read (true read, false unread), star (true/false), trash (moves to Gmail’s Trash, restorable for 30 days; nothing is deleted permanently). ' +
    'Use thread_ids to act on every message of a conversation (best for archiving). list_labels: true just lists the labels.',
  parameters: {
    type: 'object',
    properties: {
      message_ids: { type: 'array', items: { type: 'string' }, description: 'Message ids from gmail_search.' },
      thread_ids: { type: 'array', items: { type: 'string' }, description: 'Thread ids, to change every message in them.' },
      add_labels: { type: 'array', items: { type: 'string' } },
      remove_labels: { type: 'array', items: { type: 'string' } },
      archive: { type: 'boolean' },
      mark_read: { type: 'boolean' },
      star: { type: 'boolean' },
      trash: { type: 'boolean' },
      list_labels: { type: 'boolean' },
    },
  },
  async run(input, { signal }) {
    const labels = await getLabels(signal);
    if (flag(input.list_labels)) {
      const sorted = [...labels].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'user' ? -1 : 1));
      return { output: clip(sorted.map((l) => `- ${l.type === 'system' ? labelName(l) : l.name} (${l.type ?? 'user'}, id ${l.id})`).join('\n') || 'No labels.') };
    }
    const messageIds = strings(input.message_ids).map((id) => gmailIdOf(id, 'message_ids'));
    const threadIds = strings(input.thread_ids).map((id) => gmailIdOf(id, 'thread_ids'));
    if (!messageIds.length && !threadIds.length) throw new Error('Pass message_ids or thread_ids (or list_labels: true).');

    const find = (name: string) => labels.find((l) => l.id === name || l.name.toLowerCase() === name.toLowerCase() || labelName(l) === name.toLowerCase());
    const add: string[] = [];
    const remove: string[] = [];
    const created: string[] = [];
    for (const name of strings(input.add_labels)) {
      let label = find(name);
      if (!label) {
        label = await googleJson<GmailLabel>(`${GMAIL}/labels`, {
          method: 'POST',
          json: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
          signal,
        });
        labels.push(label);
        created.push(name);
      }
      add.push(label.id);
    }
    for (const name of strings(input.remove_labels)) {
      const label = find(name);
      if (!label) throw new Error(`There is no Gmail label “${name}”. List them with list_labels: true.`);
      remove.push(label.id);
    }
    if (flag(input.archive)) remove.push('INBOX');
    if (input.mark_read != null) (flag(input.mark_read) ? remove : add).push('UNREAD');
    if (input.star != null) (flag(input.star) ? add : remove).push('STARRED');
    const trash = flag(input.trash);
    if (!add.length && !remove.length && !trash) throw new Error('Nothing to do: pass labels to add or remove, archive, mark_read, star or trash.');

    const changes = { addLabelIds: [...new Set(add)], removeLabelIds: [...new Set(remove)] };
    if (add.length || remove.length) {
      for (let i = 0; i < messageIds.length; i += 1000) {
        await googleJson(`${GMAIL}/messages/batchModify`, { method: 'POST', json: { ids: messageIds.slice(i, i + 1000), ...changes }, signal });
      }
      await mapLimit(threadIds, 5, (id) => googleJson(`${GMAIL}/threads/${id}/modify`, { method: 'POST', json: changes, signal }));
    }
    if (trash) {
      await mapLimit(messageIds, 5, (id) => googleJson(`${GMAIL}/messages/${id}/trash`, { method: 'POST', signal }));
      await mapLimit(threadIds, 5, (id) => googleJson(`${GMAIL}/threads/${id}/trash`, { method: 'POST', signal }));
    }

    const nameOf = (id: string) => {
      const l = labels.find((x) => x.id === id);
      return l ? labelName(l) : id;
    };
    const done = [
      changes.addLabelIds.length && `added ${changes.addLabelIds.map(nameOf).join(', ')}`,
      changes.removeLabelIds.length && `removed ${changes.removeLabelIds.map(nameOf).join(', ')}`,
      trash && 'moved to Trash (restorable from Gmail’s Trash for 30 days)',
    ].filter(Boolean);
    const what = [messageIds.length && plural(messageIds.length, 'message'), threadIds.length && plural(threadIds.length, 'thread')].filter(Boolean).join(' and ');
    return { output: `${what}: ${done.join('; ')}.${created.length ? ` Created the label${created.length > 1 ? 's' : ''} ${created.join(', ')}.` : ''}` };
  },
};

// ---- Calendar -------------------------------------------------------------------------------

type EventTime = { date?: string | null; dateTime?: string | null; timeZone?: string };
type Attendee = { email?: string; displayName?: string; self?: boolean; organizer?: boolean; responseStatus?: string; optional?: boolean };
type CalEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: Attendee[];
  organizer?: { email?: string; self?: boolean };
  recurringEventId?: string;
  recurrence?: string[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[]; createRequest?: { status?: { statusCode?: string } } };
};
type CalendarEntry = { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string; timeZone?: string; selected?: boolean };

const calName = (c: CalendarEntry) => c.summaryOverride || c.summary || c.id;
const calPath = (calendarId: string) => `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}`;

async function listCalendars(signal: AbortSignal) {
  const out: CalendarEntry[] = [];
  let pageToken = '';
  do {
    const r = await googleJson<{ items?: CalendarEntry[]; nextPageToken?: string }>(
      `${CALENDAR}/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      { signal }
    );
    out.push(...(r.items ?? []));
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

/** A calendar id from an id, "primary", or a calendar's name. */
async function calendarIdOf(value: unknown, signal: AbortSignal) {
  const s = opt(value);
  if (!s || s.toLowerCase() === 'primary') return 'primary';
  if (s.includes('@')) return s;
  const cals = await listCalendars(signal);
  const hit = cals.find((c) => c.id === s || calName(c).toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`No calendar “${s}”. Its id or name must match one from calendar_events with list_calendars: true.`);
  return hit.id;
}

/** An event id, also from an event's htmlLink (…/event?eid=…). */
function eventIdOf(value: unknown) {
  const s = str(value, 'event_id').trim();
  const eid = s.match(/[?&]eid=([\w-]+)/)?.[1];
  if (!eid) return s;
  try {
    return new TextDecoder().decode(fromBase64(eid.padEnd(Math.ceil(eid.length / 4) * 4, '='))).split(' ')[0];
  } catch {
    throw new Error(`Couldn't read the event id from "${s}". Pass the id calendar_events returned.`);
  }
}

const meetLink = (e: CalEvent) => e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;

/** "Thu 2026-11-27 09:00–10:00", "Fri 2026-11-28 (all day)", in the device's time zone. */
function whenOf(e: CalEvent) {
  if (e.start?.date) {
    const last = e.end?.date ? addDays(e.end.date, -1) : e.start.date;
    return `${dayLabel(e.start.date)}${last > e.start.date ? ` – ${dayLabel(last)}` : ''} (all day)`;
  }
  if (!e.start?.dateTime) return '';
  const s = localStamp(new Date(e.start.dateTime));
  const t = e.end?.dateTime ? localStamp(new Date(e.end.dateTime)) : '';
  const day = dayLabel(s.slice(0, 10));
  return `${day} ${s.slice(11)}${t ? `–${t.slice(0, 10) === s.slice(0, 10) ? t.slice(11) : `${dayLabel(t.slice(0, 10))} ${t.slice(11)}`}` : ''}`;
}

function describeEvent(e: CalEvent, calendar?: string) {
  const guests = (e.attendees ?? []).filter((a) => !a.self);
  const me = e.attendees?.find((a) => a.self);
  const bits = [
    e.location && `at ${e.location}`,
    guests.length && `${plural(guests.length, 'guest')}`,
    me?.responseStatus && !e.organizer?.self && `your reply: ${me.responseStatus}`,
    e.recurringEventId && 'repeats',
    meetLink(e) && `Meet ${meetLink(e)}`,
  ].filter(Boolean);
  return (
    `- ${e.summary || '(no title)'} — ${whenOf(e)}${e.status === 'cancelled' ? ' [cancelled]' : ''}\n` +
    (bits.length ? `   ${bits.join(' · ')}\n` : '') +
    `   id ${e.id}${calendar ? ` · calendar ${calendar}` : ''}${e.htmlLink ? ` · ${e.htmlLink}` : ''}`
  );
}

const calendarEvents: Tool = {
  name: 'calendar_events',
  description:
    "See the user's Google Calendar: events between from and to (default now to 7 days ahead), recurring ones expanded, optionally matching query. " +
    'calendar is "primary" (default), a calendar id or name, or "all". Returns titles, times in the user’s time zone, places, guests, Meet links and event ids. ' +
    'list_calendars: true lists calendars; free_busy: true returns the busy blocks in the range instead of events (to find free time).',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO 8601 start, e.g. 2026-11-27 or 2026-11-27T09:00. Times without an offset are in the user’s time zone.' },
      to: { type: 'string', description: 'ISO 8601 end. A date alone means the end of that day.' },
      calendar: { type: 'string', description: 'Calendar id or name, "primary" (default) or "all".' },
      query: { type: 'string', description: 'Text to match in titles, descriptions, places and guests.' },
      count: { type: 'integer', description: 'Most events to return, 1-250. Default 50.' },
      page_token: { type: 'string', description: 'next_page_token from a previous call (single calendar only).' },
      list_calendars: { type: 'boolean' },
      free_busy: { type: 'boolean' },
    },
  },
  async run(input, { signal }) {
    if (flag(input.list_calendars)) {
      const cals = await listCalendars(signal);
      return {
        output: clip(
          cals.map((c) => `- ${calName(c)}${c.primary ? ' (primary)' : ''} · ${c.accessRole ?? ''}${c.timeZone ? ` · ${c.timeZone}` : ''}\n   id ${c.id}`).join('\n') ||
            'No calendars.'
        ),
      };
    }
    const from = opt(input.from) ? instant(input.from, 'from') : new Date();
    let to: Date;
    if (opt(input.to)) {
      to = instant(input.to, 'to');
      // "to: 2026-11-28" means through that day.
      if (DATE_ONLY.test(input.to.trim())) to = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    } else to = new Date(from.getTime() + 7 * 86_400_000);
    if (to <= from) throw new Error('"to" must be after "from".');
    const timeMin = from.toISOString();
    const timeMax = to.toISOString();
    const zone = deviceZone();
    const range = `${localStamp(from)} to ${localStamp(to)} (${zone})`;

    const wanted = opt(input.calendar) ?? 'primary';
    let calendars: { id: string; name: string }[];
    if (wanted.toLowerCase() === 'all') {
      calendars = (await listCalendars(signal)).filter((c) => c.selected || c.primary).map((c) => ({ id: c.id, name: calName(c) }));
    } else {
      const id = await calendarIdOf(wanted, signal);
      calendars = [{ id, name: id }];
    }

    if (flag(input.free_busy)) {
      const r = await googleJson<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> }>(
        `${CALENDAR}/freeBusy`,
        { method: 'POST', json: { timeMin, timeMax, timeZone: zone, items: calendars.slice(0, 50).map((c) => ({ id: c.id })) }, signal }
      );
      const blocks = calendars.map((c) => {
        const info = r.calendars?.[c.id];
        if (info?.errors?.length) return `${c.name}: unavailable (${info.errors.map((e) => e.reason).join(', ')})`;
        const busy = (info?.busy ?? []).map((b) => `- ${whenOf({ id: '', start: { dateTime: b.start }, end: { dateTime: b.end } })}`);
        return `${c.name}:\n${busy.join('\n') || '- free the whole time'}`;
      });
      return { output: clip(`Busy times from ${range}:\n${blocks.join('\n\n')}`) };
    }

    const count = int(input.count, 50, 1, 250);
    const single = calendars.length === 1;
    let next = '';
    const results = await mapLimit(calendars, 5, async (c) => {
      const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(count), timeZone: zone });
      if (opt(input.query)) params.set('q', input.query.trim());
      if (single && opt(input.page_token)) params.set('pageToken', input.page_token.trim());
      const r = await googleJson<{ items?: CalEvent[]; nextPageToken?: string }>(`${calPath(c.id)}/events?${params}`, { signal });
      if (single) next = r.nextPageToken ?? '';
      return (r.items ?? []).map((e) => ({ e, cal: c.name }));
    });
    const start = (e: CalEvent) => (e.start?.dateTime ? new Date(e.start.dateTime).getTime() : e.start?.date ? instant(e.start.date, 'start').getTime() : 0);
    const events = results.flat().sort((a, b) => start(a.e) - start(b.e)).slice(0, count);
    if (!events.length) return { output: `No events from ${range}${opt(input.query) ? ` matching “${input.query.trim()}”` : ''}.` };
    const more = next ? `\n\n[More events: pass page_token "${next}".]` : '';
    return {
      output: clip(`${plural(events.length, 'event')} from ${range}:\n${events.map(({ e, cal }) => describeEvent(e, single ? undefined : cal)).join('\n')}${more}`),
    };
  },
};

/** An event time for the API. Times without an offset are wall-clock times in `zone`. */
function eventTime(value: unknown, name: string, zone: string): EventTime {
  const s = str(value, name).trim().replace(' ', 'T');
  const m = s.match(NAIVE);
  if (m && m[4]) return { dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`, timeZone: zone, date: null };
  if (m) throw new Error(`${name} "${s}" is a date; pass all_day: true for an all-day event, or a time.`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} "${s}" is not an ISO 8601 date-time.`);
  return { dateTime: d.toISOString(), timeZone: zone, date: null };
}

/** An event time moved by `ms`, keeping its form (wall-clock or absolute). */
function shiftTime(t: EventTime, ms: number): EventTime {
  const m = t.dateTime?.match(NAIVE);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) + ms);
    return { ...t, dateTime: d.toISOString().slice(0, 19) };
  }
  return { ...t, dateTime: new Date(new Date(t.dateTime!).getTime() + ms).toISOString() };
}

const timeMs = (t: EventTime) => {
  const m = t.dateTime?.match(NAIVE);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : new Date(t.dateTime!).getTime();
};

function reminders(value: unknown) {
  const minutes = list(value).map((v) => Number(v));
  if (minutes.some((n) => !Number.isFinite(n) || n < 0 || n > 40320)) throw new Error('reminders are minutes before the event, 0-40320.');
  return { useDefault: false, overrides: minutes.slice(0, 5).map((n) => ({ method: 'popup', minutes: Math.round(n) })) };
}

const recurrenceOf = (value: unknown) =>
  list(value)
    .map((r) => String(r).trim())
    .filter(Boolean)
    .map((r) => (/^(RRULE|EXRULE|RDATE|EXDATE):/i.test(r) ? r : `RRULE:${r}`));

const emails = (value: unknown, name: string) =>
  strings(value).map((e) => {
    const email = bareEmail(e);
    if (!email.includes('@')) throw new Error(`${name}: "${e}" is not an email address.`);
    return email;
  });

const newMeet = () => ({ createRequest: { requestId: `clanker-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } });

const SEND_UPDATES = ['all', 'externalOnly', 'none'];
function sendUpdatesOf(value: unknown, fallback: string) {
  const s = opt(value) ?? fallback;
  if (!SEND_UPDATES.includes(s)) throw new Error(`send_updates must be one of: ${SEND_UPDATES.join(', ')}.`);
  return s;
}

/** Start and end for an event from date or date-time arguments. */
function eventSpan(input: Record<string, any>, zone: string, base?: CalEvent) {
  const allDay = flag(input.all_day) || (opt(input.start) != null && DATE_ONLY.test(input.start.trim()) && input.all_day == null);
  if (allDay) {
    const first = dateOf(input.start ?? base?.start?.date, 'start');
    // The API's end date is exclusive; ours is the last day of the event.
    const last = opt(input.end) ? dateOf(input.end, 'end') : base?.start?.date && base.end?.date ? addDays(first, (Date.parse(base.end.date) - Date.parse(base.start.date)) / 86_400_000 - 1) : first;
    if (last < first) throw new Error('end is before start.');
    return { start: { date: first, dateTime: null }, end: { date: addDays(last, 1), dateTime: null } };
  }
  const start = eventTime(input.start, 'start', zone);
  let end: EventTime;
  if (opt(input.end)) end = eventTime(input.end, 'end', zone);
  else {
    // Keep a moved event's length; new events last an hour.
    const length = base?.start?.dateTime && base.end?.dateTime ? timeMs(base.end) - timeMs(base.start) : 3_600_000;
    end = shiftTime(start, length);
  }
  if (timeMs(end) <= timeMs(start) && end.timeZone === start.timeZone) throw new Error('end must be after start.');
  return { start, end };
}

const calendarCreateEvent: Tool = {
  name: 'calendar_create_event',
  description:
    "Create an event in the user's Google Calendar. start/end are ISO 8601 (times without an offset are in time_zone, default the user's); end defaults to an hour after start. " +
    'For all-day events pass dates (YYYY-MM-DD) or all_day: true; end is the last day. meet: true adds a Google Meet link. ' +
    'Invitations are emailed to attendees by default (send_updates "all"); pass send_updates "none" to add them silently.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      start: { type: 'string', description: 'e.g. 2026-11-27T14:00 or 2026-11-27 for all day.' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      time_zone: { type: 'string', description: 'IANA zone, e.g. Europe/London. Default the user’s.' },
      description: { type: 'string' },
      location: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Guest email addresses.' },
      meet: { type: 'boolean', description: 'Add a Google Meet video call.' },
      reminders: { type: 'array', items: { type: 'integer' }, description: 'Pop-up reminders, minutes before (up to 5). [] for none. Default the calendar’s.' },
      recurrence: { type: 'array', items: { type: 'string' }, description: 'RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"].' },
      calendar: { type: 'string', description: 'Calendar id or name. Default primary.' },
      send_updates: { type: 'string', enum: SEND_UPDATES, description: 'Who gets emailed. Default "all" with attendees.' },
    },
    required: ['title', 'start'],
  },
  async run(input, { signal }) {
    const zone = opt(input.time_zone) ?? deviceZone();
    const calendarId = await calendarIdOf(input.calendar, signal);
    const attendees = emails(input.attendees, 'attendees');
    const event: Record<string, unknown> = { summary: str(input.title, 'title'), ...eventSpan(input, zone) };
    if (opt(input.description)) event.description = input.description;
    if (opt(input.location)) event.location = input.location.trim();
    if (attendees.length) event.attendees = attendees.map((email) => ({ email }));
    if (input.reminders != null) event.reminders = reminders(input.reminders);
    const recurrence = recurrenceOf(input.recurrence);
    if (recurrence.length) event.recurrence = recurrence;
    const meet = flag(input.meet);
    if (meet) event.conferenceData = newMeet();
    const sendUpdates = sendUpdatesOf(input.send_updates, attendees.length ? 'all' : 'none');
    const params = new URLSearchParams({ sendUpdates, ...(meet ? { conferenceDataVersion: '1' } : {}) });
    const e = await googleJson<CalEvent>(`${calPath(calendarId)}/events?${params}`, { method: 'POST', json: event, signal });
    const pending = meet && !meetLink(e) ? '\nThe Meet link is still being set up; it will show on the event shortly.' : '';
    const invited = attendees.length ? (sendUpdates === 'none' ? ' Guests were added without an email.' : ' Invitations were emailed.') : '';
    return { output: `Created the event${calendarId !== 'primary' ? ` in ${calendarId}` : ''}.${invited}\n${describeEvent(e)}${pending}` };
  },
};

const calendarUpdateEvent: Tool = {
  name: 'calendar_update_event',
  description:
    'Change an event in Google Calendar (find it with calendar_events first). Pass only what changes: title, start/end (moving start alone keeps its length), all_day, time_zone, ' +
    'description, location, add_attendees, remove_attendees, meet: true (add a Meet link), reminders, recurrence. ' +
    'response "accepted"|"declined"|"tentative" replies to an invitation as the user. delete: true cancels/deletes the event. ' +
    'An id of one occurrence of a repeating event changes just that occurrence. Guests are emailed about changes by default (send_updates "all") when there are any.',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'Event id (or the event’s link) from calendar_events.' },
      calendar: { type: 'string', description: 'Calendar id or name. Default primary.' },
      title: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      time_zone: { type: 'string' },
      description: { type: 'string' },
      location: { type: 'string' },
      add_attendees: { type: 'array', items: { type: 'string' } },
      remove_attendees: { type: 'array', items: { type: 'string' } },
      meet: { type: 'boolean' },
      reminders: { type: 'array', items: { type: 'integer' } },
      recurrence: { type: 'array', items: { type: 'string' } },
      response: { type: 'string', enum: ['accepted', 'declined', 'tentative'] },
      delete: { type: 'boolean' },
      send_updates: { type: 'string', enum: SEND_UPDATES },
    },
    required: ['event_id'],
  },
  async run(input, { signal }) {
    const calendarId = await calendarIdOf(input.calendar, signal);
    const url = `${calPath(calendarId)}/events/${encodeURIComponent(eventIdOf(input.event_id))}`;
    const current = await googleJson<CalEvent>(url, { signal });
    const others = (current.attendees ?? []).some((a) => !a.self);
    const sendUpdates = sendUpdatesOf(input.send_updates, others ? 'all' : 'none');

    if (flag(input.delete)) {
      await googleFetch(`${url}?sendUpdates=${sendUpdates}`, { method: 'DELETE', signal });
      const told = others && sendUpdates !== 'none' ? ' Guests were notified.' : '';
      return { output: `Deleted “${current.summary || '(no title)'}” (${whenOf(current)}).${told}` };
    }

    const patch: Record<string, unknown> = {};
    if (input.title != null) patch.summary = str(input.title, 'title');
    if (input.description != null) patch.description = String(input.description);
    if (input.location != null) patch.location = String(input.location);
    if (opt(input.start) || opt(input.end) || input.all_day != null || opt(input.time_zone)) {
      const zone = opt(input.time_zone) ?? current.start?.timeZone ?? deviceZone();
      const newStart = opt(input.start);
      const allDay = input.all_day != null ? flag(input.all_day) : newStart ? DATE_ONLY.test(newStart) : !!current.start?.date;
      if (!newStart && !allDay && current.start?.date) throw new Error('Pass start (and end) to turn an all-day event into a timed one.');
      // Without a new start, the current one stays (as a date for all-day events).
      const startArg = newStart ?? (allDay ? current.start?.date ?? current.start?.dateTime : current.start?.dateTime);
      Object.assign(patch, eventSpan({ start: startArg, end: input.end, all_day: allDay }, zone, current));
    }

    // PATCH replaces the whole attendee list, so changes are made to a copy of the current one.
    let attendees = [...(current.attendees ?? [])];
    let attendeesChanged = false;
    const adding = emails(input.add_attendees, 'add_attendees');
    const removing = new Set(emails(input.remove_attendees, 'remove_attendees'));
    if (adding.length || removing.size) {
      attendees = attendees.filter((a) => !removing.has((a.email ?? '').toLowerCase()));
      for (const email of adding) if (!attendees.some((a) => a.email?.toLowerCase() === email)) attendees.push({ email });
      attendeesChanged = true;
    }
    const response = opt(input.response);
    if (response) {
      if (!['accepted', 'declined', 'tentative'].includes(response)) throw new Error('response must be accepted, declined or tentative.');
      if (!attendees.some((a) => a.self)) throw new Error('The user is not a guest of this event, so there is no invitation to reply to.');
      attendees = attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a));
      attendeesChanged = true;
    }
    if (attendeesChanged) patch.attendees = attendees;
    if (input.reminders != null) patch.reminders = reminders(input.reminders);
    if (input.recurrence != null) patch.recurrence = recurrenceOf(input.recurrence);
    const meet = flag(input.meet) && !meetLink(current);
    if (meet) patch.conferenceData = newMeet();
    if (!Object.keys(patch).length) throw new Error('Nothing to change: pass the fields to update, response, or delete: true.');

    const params = new URLSearchParams({ sendUpdates, ...(meet ? { conferenceDataVersion: '1' } : {}) });
    const e = await googleJson<CalEvent>(`${url}?${params}`, { method: 'PATCH', json: patch, signal });
    const what = response ? `Replied “${response}” to` : 'Updated';
    const told = others && sendUpdates !== 'none' ? ' Guests were notified.' : '';
    return { output: `${what} the event.${told}\n${describeEvent(e)}` };
  },
};

// ---- Slides ---------------------------------------------------------------------------------

type SlideTextContent = { textElements?: { textRun?: { content?: string }; autoText?: { content?: string } }[] };
type PageElement = {
  objectId: string;
  shape?: { placeholder?: { type?: string; index?: number }; text?: SlideTextContent };
  table?: { tableRows?: { tableCells?: { text?: SlideTextContent }[] }[] };
  elementGroup?: { children?: PageElement[] };
  image?: object;
  video?: object;
  sheetsChart?: object;
};
type SlidePage = {
  objectId: string;
  pageElements?: PageElement[];
  slideProperties?: { isSkipped?: boolean; notesPage?: { pageElements?: PageElement[]; notesProperties?: { speakerNotesObjectId?: string } } };
};
type Presentation = { presentationId: string; title?: string; slides?: SlidePage[] };

const deckLink = (id: string) => `https://docs.google.com/presentation/d/${id}/edit`;
const textOf = (t?: SlideTextContent) =>
  (t?.textElements ?? [])
    .map((e) => e.textRun?.content ?? e.autoText?.content ?? '')
    .join('')
    .replace(/\n+$/, '')
    .trim();
const TITLE_TYPES = ['TITLE', 'CENTERED_TITLE'];

function elementLines(el: PageElement): string[] {
  if (el.shape) {
    const text = textOf(el.shape.text);
    if (!text) return [];
    const type = el.shape.placeholder?.type ?? '';
    if (TITLE_TYPES.includes(type)) return [`Title: ${text}`];
    if (type === 'SUBTITLE') return [`Subtitle: ${text}`];
    return [text];
  }
  if (el.table) return (el.table.tableRows ?? []).map((r) => `| ${(r.tableCells ?? []).map((c) => textOf(c.text).replace(/\n/g, ' / ')).join(' | ')} |`);
  if (el.elementGroup) return (el.elementGroup.children ?? []).flatMap(elementLines);
  if (el.image) return ['[image]'];
  if (el.video) return ['[video]'];
  if (el.sheetsChart) return ['[chart]'];
  return [];
}

function speakerNotes(page: SlidePage) {
  const notes = page.slideProperties?.notesPage;
  const id = notes?.notesProperties?.speakerNotesObjectId;
  const shape = notes?.pageElements?.find((e) => e.objectId === id);
  return textOf(shape?.shape?.text);
}

const SLIDE_FIELDS =
  'presentationId,title,slides(objectId,pageElements,slideProperties(isSkipped,notesPage(pageElements,notesProperties)))';

const slidesRead: Tool = {
  name: 'slides_read',
  description: 'Read a Google Slides presentation: its title, link, and for each slide its number, object id, all its text (titles marked, tables as | rows |) and speaker notes.',
  parameters: {
    type: 'object',
    properties: { presentation: { type: 'string', description: 'Presentation ID or link.' } },
    required: ['presentation'],
  },
  async run(input, { signal }) {
    const id = fileIdOf(input.presentation, 'presentation');
    const p = await googleJson<Presentation>(`${SLIDES}/${encodeURIComponent(id)}?fields=${encodeURIComponent(SLIDE_FIELDS)}`, { signal });
    const slides = (p.slides ?? []).map((s, i) => {
      const lines = (s.pageElements ?? []).flatMap(elementLines);
      const notes = speakerNotes(s);
      return [
        `## Slide ${i + 1} (id ${s.objectId})${s.slideProperties?.isSkipped ? ' [skipped]' : ''}`,
        lines.join('\n') || '[No text.]',
        ...(notes ? [`Notes: ${notes}`] : []),
      ].join('\n');
    });
    return { output: clip(`# ${p.title ?? 'Presentation'}\n${deckLink(p.presentationId)}\n${plural(slides.length, 'slide')}\n\n${slides.join('\n\n')}`) };
  },
};

const LAYOUTS = ['TITLE', 'TITLE_AND_BODY', 'SECTION_HEADER', 'TITLE_ONLY', 'BLANK', 'TITLE_AND_TWO_COLUMNS', 'MAIN_POINT', 'BIG_NUMBER'];
type SlideSpec = { title?: string; body?: string | string[]; notes?: string; layout?: string };

/** Body lines as bullet paragraphs: list marks dropped, two-space indents turned into the tabs Slides nests by. */
function bulletText(body: string | string[]) {
  const lines = (Array.isArray(body) ? body : String(body).split('\n')).map(String).filter((l) => l.trim());
  return lines
    .map((l) => {
      const indent = l.match(/^[ \t]*/)![0].replace(/\t/g, '  ').length;
      return '\t'.repeat(Math.min(4, Math.floor(indent / 2))) + l.trim().replace(/^([-*•]|\d+[.)])\s+/, '');
    })
    .join('\n');
}

const slidesCreate: Tool = {
  name: 'slides_create',
  description:
    "Create a Google Slides presentation in the user's Drive from an outline: each slide has a title, optional body (lines become bullet points; indent with two spaces to nest), " +
    'optional speaker notes and an optional layout (TITLE for a title slide with subtitle, TITLE_AND_BODY, SECTION_HEADER, TITLE_ONLY, BLANK; ' +
    'default TITLE for the first slide when it has no bullets, else TITLE_AND_BODY, or TITLE_ONLY without a body). Returns the link.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Presentation name.' },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string', description: 'Bullet points, one per line (the subtitle on a TITLE slide).' },
            notes: { type: 'string', description: 'Speaker notes.' },
            layout: { type: 'string', enum: LAYOUTS },
          },
        },
      },
    },
    required: ['title', 'slides'],
  },
  async run(input, { signal }) {
    const title = str(input.title, 'title');
    const specs = list<SlideSpec>(input.slides).map((s) => (typeof s === 'string' ? { title: s } : s));
    if (!specs.length) throw new Error('Pass at least one slide.');
    if (specs.length > 100) throw new Error('At most 100 slides at a time.');
    const layouts = specs.map((s, i) => {
      const lines = s.body == null ? 0 : bulletText(s.body).split('\n').filter(Boolean).length;
      const layout = (opt(s.layout) ?? (i === 0 && lines <= 1 ? 'TITLE' : lines ? 'TITLE_AND_BODY' : 'TITLE_ONLY')).toUpperCase();
      if (!LAYOUTS.includes(layout)) throw new Error(`Slide ${i + 1}: unknown layout "${s.layout}". Use one of: ${LAYOUTS.join(', ')}.`);
      return layout;
    });

    const created = await googleJson<Presentation>(SLIDES, { method: 'POST', json: { title }, signal });
    const id = created.presentationId;
    const link = deckLink(id);
    try {
      // 1. The slides, then drop the blank one a new presentation starts with.
      const stamp = Date.now().toString(36);
      const ids = specs.map((_, i) => `clk_${stamp}_${i}`);
      await googleJson(`${SLIDES}/${id}:batchUpdate`, {
        method: 'POST',
        json: {
          requests: [
            ...ids.map((objectId, i) => ({ createSlide: { objectId, slideLayoutReference: { predefinedLayout: layouts[i] } } })),
            ...(created.slides ?? []).map((s) => ({ deleteObject: { objectId: s.objectId } })),
          ],
        },
        signal,
      });

      // 2. Read back the placeholders each layout made, and each slide's speaker-notes shape.
      const deck = await googleJson<Presentation>(
        `${SLIDES}/${id}?fields=${encodeURIComponent('slides(objectId,pageElements(objectId,shape(placeholder)),slideProperties(notesPage(notesProperties)))')}`,
        { signal }
      );
      const pages = new Map((deck.slides ?? []).map((s) => [s.objectId, s]));
      const requests: object[] = [];
      const skipped: number[] = [];
      specs.forEach((spec, i) => {
        const page = pages.get(ids[i]);
        const shapes = (page?.pageElements ?? []).filter((e) => e.shape?.placeholder);
        const byType = (types: string[]) =>
          shapes.filter((e) => types.includes(e.shape!.placeholder!.type ?? '')).sort((a, b) => (a.shape!.placeholder!.index ?? 0) - (b.shape!.placeholder!.index ?? 0))[0];
        const titleShape = byType(TITLE_TYPES);
        const bodyShape = byType(['BODY']) ?? byType(['SUBTITLE']);
        const slideTitle = opt(spec.title);
        if (slideTitle) {
          if (titleShape) requests.push({ insertText: { objectId: titleShape.objectId, insertionIndex: 0, text: slideTitle } });
          else skipped.push(i + 1);
        }
        const body = spec.body != null ? (bodyShape?.shape?.placeholder?.type === 'BODY' ? bulletText(spec.body) : list<string>(spec.body).join('\n').trim()) : '';
        if (body) {
          if (bodyShape) {
            requests.push({ insertText: { objectId: bodyShape.objectId, insertionIndex: 0, text: body } });
            if (bodyShape.shape!.placeholder!.type === 'BODY') {
              requests.push({ createParagraphBullets: { objectId: bodyShape.objectId, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
            }
          } else skipped.push(i + 1);
        }
        const notesId = page?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
        // Inserting into the notes id creates the notes shape when it doesn't exist yet.
        if (opt(spec.notes) && notesId) requests.push({ insertText: { objectId: notesId, insertionIndex: 0, text: spec.notes!.trim() } });
      });
      if (requests.length) await googleJson(`${SLIDES}/${id}:batchUpdate`, { method: 'POST', json: { requests }, signal });
      const note = skipped.length
        ? `\nThe layout of slide${skipped.length > 1 ? 's' : ''} ${[...new Set(skipped)].join(', ')} has no place for some of the text given, so it was left out; pick a layout with a title and body.`
        : '';
      return { output: `Created the presentation “${title}” with ${plural(specs.length, 'slide')}: ${link} (id ${id}).${note}` };
    } catch (e) {
      throw new Error(`The presentation was created (${link}) but filling it failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ---- Tasks ----------------------------------------------------------------------------------

type TaskList = { id: string; title: string };
type GTask = { id: string; title?: string; notes?: string; status?: string; due?: string; completed?: string; parent?: string; position?: string; webViewLink?: string };

async function taskLists(signal: AbortSignal) {
  const r = await googleJson<{ items?: TaskList[] }>(`${TASKS}/users/@me/lists?maxResults=1000`, { signal });
  return r.items ?? [];
}

/** A task list from an id or title; undefined value means the default list. */
async function taskListOf(value: unknown, signal: AbortSignal): Promise<TaskList> {
  const s = opt(value);
  if (!s || s === '@default') return googleJson<TaskList>(`${TASKS}/users/@me/lists/@default`, { signal });
  const lists = await taskLists(signal);
  const hit = lists.find((l) => l.id === s) ?? lists.find((l) => l.title.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`No task list “${s}”. Lists: ${lists.map((l) => `${l.title} (${l.id})`).join(', ')}.`);
  return hit;
}

const tasksPath = (listId: string) => `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`;
/** The API wants a due date as midnight UTC of that day; it ignores the time. */
const dueValue = (value: unknown) => `${dateOf(value, 'due')}T00:00:00.000Z`;

function taskLine(t: GTask, today: string, depth = 0) {
  const due = t.due?.slice(0, 10);
  const bits = [
    due && `due ${dayLabel(due)}${t.status !== 'completed' && due < today ? ' (overdue)' : ''}`,
    t.status === 'completed' && t.completed && `done ${t.completed.slice(0, 10)}`,
    `id ${t.id}`,
  ].filter(Boolean);
  const notes = t.notes?.trim() ? `\n${'  '.repeat(depth)}    ${short(t.notes.trim().replace(/\s+/g, ' '), 160)}` : '';
  return `${'  '.repeat(depth)}- [${t.status === 'completed' ? 'x' : ' '}] ${t.title || '(untitled)'} · ${bits.join(' · ')}${notes}`;
}

const tasksList: Tool = {
  name: 'tasks_list',
  description:
    "See the user's Google Tasks: every list (or one, by id or title) with its tasks, subtasks indented under their parents, with due dates and ids. " +
    'Completed tasks are left out unless show_completed: true. due_after / due_before (dates, inclusive) keep only tasks due in that range.',
  parameters: {
    type: 'object',
    properties: {
      list: { type: 'string', description: 'Task list id or title. Default all lists.' },
      show_completed: { type: 'boolean' },
      due_after: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      due_before: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
    },
  },
  async run(input, { signal }) {
    const lists = opt(input.list) ? [await taskListOf(input.list, signal)] : await taskLists(signal);
    const showCompleted = flag(input.show_completed);
    const today = localDate(new Date());
    const filtered = opt(input.due_after) || opt(input.due_before);
    const sections = await mapLimit(lists, 4, async (l) => {
      const tasks: GTask[] = [];
      let pageToken = '';
      do {
        const params = new URLSearchParams({ maxResults: '100', showCompleted: String(showCompleted), showHidden: String(showCompleted) });
        if (opt(input.due_after)) params.set('dueMin', `${dateOf(input.due_after, 'due_after')}T00:00:00.000Z`);
        if (opt(input.due_before)) params.set('dueMax', `${dateOf(input.due_before, 'due_before')}T23:59:59.999Z`);
        if (pageToken) params.set('pageToken', pageToken);
        const r = await googleJson<{ items?: GTask[]; nextPageToken?: string }>(`${tasksPath(l.id)}?${params}`, { signal });
        tasks.push(...(r.items ?? []));
        pageToken = r.nextPageToken ?? '';
      } while (pageToken && tasks.length < 500);

      // Parents first by position, each followed by its subtasks.
      const byPos = (a: GTask, b: GTask) => (a.position ?? '').localeCompare(b.position ?? '');
      const ids = new Set(tasks.map((t) => t.id));
      const top = tasks.filter((t) => !t.parent || !ids.has(t.parent)).sort(byPos);
      const lines = top.flatMap((t) => [
        taskLine(t, today),
        ...tasks
          .filter((c) => c.parent === t.id)
          .sort(byPos)
          .map((c) => taskLine(c, today, 1)),
      ]);
      const empty = filtered ? '(nothing due in that range)' : showCompleted ? '(empty)' : '(no open tasks)';
      return `## ${l.title} (list id ${l.id})\n${lines.join('\n') || empty}`;
    });
    return { output: clip(sections.join('\n\n') || 'No task lists.') };
  },
};

type TaskSpec = { title?: string; notes?: string; due?: string; parent?: string };

const tasksAdd: Tool = {
  name: 'tasks_add',
  description:
    'Add tasks to Google Tasks: title, optional notes, due date (YYYY-MM-DD; Google Tasks keeps dates only, no times) and parent (a task id, to make a subtask). ' +
    'Pass tasks: [...] to add several at once, in order. list is a list id or title (default the user’s default list).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      notes: { type: 'string' },
      due: { type: 'string', description: 'YYYY-MM-DD.' },
      parent: { type: 'string', description: 'Parent task id, for a subtask.' },
      list: { type: 'string', description: 'Task list id or title. Default the default list.' },
      tasks: {
        type: 'array',
        description: 'Several tasks to add instead of one.',
        items: { type: 'object', properties: { title: { type: 'string' }, notes: { type: 'string' }, due: { type: 'string' }, parent: { type: 'string' } }, required: ['title'] },
      },
    },
  },
  async run(input, { signal }) {
    const specs = input.tasks != null ? list<TaskSpec>(input.tasks).map((t) => (typeof t === 'string' ? { title: t } : t)) : [input as TaskSpec];
    if (!specs.length) throw new Error('Pass a title, or tasks to add.');
    const tasks = specs.map((t, i) => {
      const title = str(t.title, specs.length > 1 ? `tasks[${i}].title` : 'title');
      return { body: { title, ...(opt(t.notes) ? { notes: t.notes } : {}), ...(opt(t.due) ? { due: dueValue(t.due) } : {}) }, parent: opt(t.parent) };
    });
    const tasklist = await taskListOf(input.list, signal);
    const today = localDate(new Date());
    const added: GTask[] = [];
    // New tasks go first among their siblings unless placed after one, so chain them to keep their order.
    const lastUnder = new Map<string, string>();
    for (const t of tasks) {
      const params = new URLSearchParams();
      if (t.parent) params.set('parent', t.parent);
      const previous = lastUnder.get(t.parent ?? '');
      if (previous) params.set('previous', previous);
      const task = await googleJson<GTask>(`${tasksPath(tasklist.id)}${String(params) ? `?${params}` : ''}`, { method: 'POST', json: t.body, signal });
      lastUnder.set(t.parent ?? '', task.id);
      added.push(task);
    }
    const lines = added.map((t) => `${taskLine(t, today, t.parent ? 1 : 0)}${t.webViewLink ? `\n    ${t.webViewLink}` : ''}`);
    return { output: `Added ${plural(added.length, 'task')} to “${tasklist.title}” (list id ${tasklist.id}):\n${lines.join('\n')}` };
  },
};

const notFound = (e: unknown) => e instanceof PluginApiError && (e.status === 404 || e.status === 400);

/** Finds which list a task is in, trying the default list first. */
async function locateTask(taskId: string, listArg: unknown, signal: AbortSignal): Promise<{ list: TaskList; task: GTask }> {
  if (opt(listArg)) {
    const l = await taskListOf(listArg, signal);
    return { list: l, task: await googleJson<GTask>(`${tasksPath(l.id)}/${encodeURIComponent(taskId)}`, { signal }) };
  }
  const lists = await taskLists(signal);
  const fallback = await googleJson<TaskList>(`${TASKS}/users/@me/lists/@default`, { signal });
  const order = [fallback, ...lists.filter((l) => l.id !== fallback.id)];
  for (const l of order) {
    try {
      return { list: l, task: await googleJson<GTask>(`${tasksPath(l.id)}/${encodeURIComponent(taskId)}`, { signal }) };
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  }
  throw new Error(`No task with id ${taskId} in any list. Find it with tasks_list.`);
}

const tasksUpdate: Tool = {
  name: 'tasks_update',
  description:
    'Change a Google Tasks task by id (from tasks_list): title, notes, due (YYYY-MM-DD, or "none" to clear), completed (true ticks it off, false reopens it), or delete: true to delete it. ' +
    'list is optional; the task is found in any list.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task id.' },
      list: { type: 'string', description: 'Task list id or title, if known.' },
      title: { type: 'string' },
      notes: { type: 'string' },
      due: { type: 'string' },
      completed: { type: 'boolean' },
      delete: { type: 'boolean' },
    },
    required: ['task'],
  },
  async run(input, { signal }) {
    const taskId = str(input.task, 'task').trim();
    const { list: tasklist, task } = await locateTask(taskId, input.list, signal);
    const url = `${tasksPath(tasklist.id)}/${encodeURIComponent(task.id)}`;
    if (flag(input.delete)) {
      await googleFetch(url, { method: 'DELETE', signal });
      return { output: `Deleted the task “${task.title || '(untitled)'}” from “${tasklist.title}”.` };
    }
    const patch: Record<string, unknown> = {};
    if (input.title != null) patch.title = str(input.title, 'title');
    if (input.notes != null) patch.notes = String(input.notes);
    if (input.due === null || (typeof input.due === 'string' && /^(none|null|clear)$/i.test(input.due.trim()))) patch.due = null;
    else if (opt(input.due)) patch.due = dueValue(input.due);
    if (input.completed != null) {
      const done = flag(input.completed);
      patch.status = done ? 'completed' : 'needsAction';
      if (!done) patch.completed = null;
    }
    if (!Object.keys(patch).length) throw new Error('Nothing to change: pass title, notes, due, completed or delete: true.');
    const updated = await googleJson<GTask>(url, { method: 'PATCH', json: patch, signal });
    const verb = input.completed != null ? (flag(input.completed) ? 'Completed' : 'Reopened') : 'Updated';
    return { output: `${verb} the task in “${tasklist.title}”:\n${taskLine(updated, localDate(new Date()))}` };
  },
};

export const GOOGLE_MORE_TOOLS: Tool[] = [
  gmailSearch,
  gmailRead,
  gmailSend,
  gmailModify,
  calendarEvents,
  calendarCreateEvent,
  calendarUpdateEvent,
  slidesRead,
  slidesCreate,
  tasksList,
  tasksAdd,
  tasksUpdate,
];

const recipients = (i: Record<string, unknown>) => short(strings(i.to).join(', '), 40);

export const GOOGLE_MORE_LABELS: ToolLabels = {
  gmail_search: (i) => (field(i, 'query') ? `Search Gmail “${short(field(i, 'query'))}”` : 'List recent Gmail'),
  gmail_read: (i) => {
    const save = i.save_attachments != null && i.save_attachments !== false ? ' and save attachments' : '';
    return `${field(i, 'thread_id') ? 'Read an email thread' : 'Read an email'}${save}`;
  },
  gmail_send: (i) => {
    if (field(i, 'draft_id') && flag(i.send)) return 'Send a Gmail draft';
    const verb = flag(i.send) ? 'Send' : 'Draft';
    const subject = field(i, 'subject');
    const what = subject ? `“${short(subject, 40)}”` : field(i, 'reply_to') ? 'a reply' : field(i, 'forward') ? 'a forward' : 'an email';
    const to = recipients(i);
    return `${verb} ${what}${to ? ` to ${to}` : ''}`;
  },
  gmail_modify: (i) => {
    if (flag(i.list_labels)) return 'List Gmail labels';
    const n = strings(i.message_ids).length + strings(i.thread_ids).length;
    const target = n > 1 ? `${n} emails` : 'an email';
    if (flag(i.trash)) return `Move ${target} to Trash`;
    if (flag(i.archive)) return `Archive ${target}`;
    if (i.mark_read != null) return `Mark ${target} ${flag(i.mark_read) ? 'read' : 'unread'}`;
    const add = strings(i.add_labels);
    if (add.length) return `Label ${target} “${short(add.join(', '), 30)}”`;
    return `Organise ${target}`;
  },
  calendar_events: (i) =>
    flag(i.list_calendars)
      ? 'List calendars'
      : flag(i.free_busy)
        ? 'Check free time'
        : field(i, 'query')
          ? `Find events “${short(field(i, 'query'))}”`
          : 'Check the calendar',
  calendar_create_event: (i) => `Create event “${short(field(i, 'title'))}”`,
  calendar_update_event: (i) =>
    flag(i.delete)
      ? 'Cancel an event'
      : field(i, 'response')
        ? `${({ accepted: 'Accept', declined: 'Decline', tentative: 'Maybe' } as Record<string, string>)[field(i, 'response')] ?? 'Reply to'} an invitation`
        : field(i, 'start')
          ? 'Move an event'
          : 'Update an event',
  slides_read: () => 'Read a presentation',
  slides_create: (i) => `Create presentation “${short(field(i, 'title'))}”`,
  tasks_list: (i) => (field(i, 'list') ? `See tasks in “${short(field(i, 'list'))}”` : 'See tasks'),
  tasks_add: (i) => {
    const n = list(i.tasks).length;
    return n > 1 ? `Add ${n} tasks` : `Add task “${short(field(i, 'title') || String((list<TaskSpec>(i.tasks)[0] ?? {}).title ?? ''))}”`;
  },
  tasks_update: (i) => (flag(i.delete) ? 'Delete a task' : i.completed != null ? (flag(i.completed) ? 'Complete a task' : 'Reopen a task') : 'Update a task'),
};
