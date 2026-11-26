import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { messageText, type Conversation } from '@/store/chats';
import { attachmentUri, sanitize } from './attachments';
import type { AttachmentPart } from './providers';
import { splitQuotes } from './quotes';

const dir = new Directory(Paths.cache, 'share');

/** A fresh file in the share folder, named for the person it is shown to. */
function shareFile(name: string) {
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, sanitize(name));
  if (file.exists) file.delete();
  return file;
}

function attachmentName(part: AttachmentPart) {
  return part.type === 'image' ? `image${part.file.match(/\.[^./]+$/)?.[0] ?? '.jpg'}` : part.name;
}

/** The chat as Markdown: what was said, with attachments named; tool calls and thinking are left out. */
export function chatMarkdown(c: Conversation) {
  const out = [`# ${c.title}`, ''];
  for (const m of c.messages) {
    const raw = messageText(m).trim();
    const { quotes, text } = m.role === 'user' ? splitQuotes(raw) : { quotes: [], text: raw };
    const attached = m.content.filter((p): p is AttachmentPart => p.type === 'image' || p.type === 'file');
    if (!text && !attached.length && !quotes.length) continue;
    out.push(m.role === 'user' ? '## You' : `## ${m.model ?? 'Assistant'}`, '');
    for (const q of quotes) out.push(...q.split('\n').map((l) => `> ${l}`), '');
    for (const a of attached) out.push(`📎 ${attachmentName(a)}`);
    if (attached.length) out.push('');
    if (text) out.push(text, '');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Shows the share sheet for the chat, as a Markdown file. */
export async function shareChat(c: Conversation) {
  const file = shareFile(`${c.title.trim() || 'Chat'}.md`);
  file.writeSync(chatMarkdown(c));
  await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: c.title, UTI: 'net.daringfireball.markdown' });
}

export type Upload = { key: string; part: AttachmentPart; name: string; messageId: string; at: number };

/** The files and images the user attached to the chat's messages, newest first. */
export function chatUploads(c: Conversation): Upload[] {
  const out: Upload[] = [];
  for (const m of c.messages) {
    if (m.role !== 'user') continue;
    m.content.forEach((p, i) => {
      if (p.type !== 'image' && p.type !== 'file') return;
      out.push({ key: `${m.id}:${i}`, part: p, name: attachmentName(p), messageId: m.id, at: m.createdAt });
    });
  }
  return out.reverse();
}

/** The upload as a file on disk: its stored copy, or its inlined text written out under its name. */
function uploadFile(u: Upload) {
  const stored = u.part.file ? new File(attachmentUri(u.part.file)) : null;
  if (stored?.exists) return stored;
  if (u.part.type === 'file' && u.part.text != null) {
    const file = shareFile(u.name);
    file.writeSync(u.part.text);
    return file;
  }
  throw new Error(`"${u.name}" is no longer on this device.`);
}

export async function shareUpload(u: Upload) {
  const file = uploadFile(u);
  await Sharing.shareAsync(file.uri, { mimeType: u.part.mimeType || undefined, dialogTitle: u.name });
}

/** Opens the upload in the system previewer, or the share sheet when nothing can preview it. */
export async function openUpload(u: Upload) {
  const file = uploadFile(u);
  try {
    if (await file.canPreview()) return await file.preview({ title: u.name });
  } catch {
    // No previewer for the type (on Android, say); sharing still lets the user pick an app.
  }
  await Sharing.shareAsync(file.uri, { mimeType: u.part.mimeType || undefined, dialogTitle: u.name });
}
