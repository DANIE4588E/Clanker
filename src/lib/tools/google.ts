import { googleFetch, googleJson } from '../plugins/auth';
import { GOOGLE_SCOPES, hasScope } from '../plugins/catalog';
import { formatSize } from '../workspace';
import type { Tool } from './index';
import { requireObserved } from './observe';
import { clip, EXT_MIME, field, MAX_OUTPUT_CHARS, MAX_TRANSFER_BYTES, multipartRelated as multipart, opt, safeName, short, str, type ToolLabels } from './pluginUtil';

/**
 * Tools for the Google Drive, Docs and Sheets plugins. They act on the user's real files through
 * Google's APIs; the plugin catalog decides which are offered.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents,shortcutDetails(targetId,targetMimeType)';
const ALL_DRIVES = 'supportsAllDrives=true';

const G = 'application/vnd.google-apps.';
const MIME = {
  document: `${G}document`,
  spreadsheet: `${G}spreadsheet`,
  presentation: `${G}presentation`,
  folder: `${G}folder`,
  drawing: `${G}drawing`,
  form: `${G}form`,
  shortcut: `${G}shortcut`,
  pdf: 'application/pdf',
};




/** A file or folder ID from an ID or any Google Drive/Docs/Sheets/Slides link. */
export function fileIdOf(input: unknown, name = 'file'): string {
  const s = str(input, name).trim();
  if (s === 'root') return s;
  const m =
    s.match(/\/(?:d|folders)\/([\w-]{10,})/) ?? s.match(/[?&]id=([\w-]{10,})/) ?? (s.match(/^([\w-]{10,})$/) as RegExpMatchArray | null);
  if (!m) throw new Error(`"${s}" is not a Google file ID or link.`);
  return m[1];
}

const quoteQ = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function kindOf(mime: string) {
  switch (mime) {
    case MIME.document:
      return 'Google Doc';
    case MIME.spreadsheet:
      return 'Google Sheet';
    case MIME.presentation:
      return 'Google Slides';
    case MIME.folder:
      return 'Folder';
    case MIME.drawing:
      return 'Google Drawing';
    case MIME.form:
      return 'Google Form';
    case MIME.shortcut:
      return 'Shortcut';
    case MIME.pdf:
      return 'PDF';
    default:
      return mime;
  }
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  shortcutDetails?: { targetId: string; targetMimeType: string };
};

function describeFile(f: DriveFile) {
  const bits = [kindOf(f.mimeType), f.size && formatSize(Number(f.size)), f.modifiedTime && `modified ${f.modifiedTime.slice(0, 10)}`];
  return `${f.name} (${bits.filter(Boolean).join(', ')})\n   id ${f.id}${f.webViewLink ? ` · ${f.webViewLink}` : ''}`;
}

const getFile = (id: string, signal?: AbortSignal) =>
  googleJson<DriveFile>(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}&${ALL_DRIVES}`, { signal });



// ---- Drive ---------------------------------------------------------------------------------

const TYPE_FILTERS: Record<string, string> = {
  document: `mimeType = '${MIME.document}'`,
  spreadsheet: `mimeType = '${MIME.spreadsheet}'`,
  presentation: `mimeType = '${MIME.presentation}'`,
  folder: `mimeType = '${MIME.folder}'`,
  pdf: `mimeType = '${MIME.pdf}'`,
  image: "mimeType contains 'image/'",
  video: "mimeType contains 'video/'",
};

const driveSearch: Tool = {
  name: 'drive_search',
  description:
    "Search the user's Google Drive. Matches file names (name) and/or full text inside files (query), optionally of one type or in one folder. " +
    'With no filters, lists the most recently modified files. Returns names, types, IDs and links; pass an ID to the other drive_/docs_/sheets_ tools.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to find in file contents and names.' },
      name: { type: 'string', description: 'Text the file name must contain.' },
      type: { type: 'string', enum: Object.keys(TYPE_FILTERS), description: 'Only files of this type.' },
      folder: { type: 'string', description: 'Only files directly in this folder (ID or link; "root" for My Drive).' },
      count: { type: 'integer', description: 'How many results, 1-100. Default 20.' },
      page_token: { type: 'string', description: 'next_page_token from a previous search, for more results.' },
    },
  },
  async run(input, { signal }) {
    const clauses = ['trashed = false'];
    const query = opt(input.query);
    const name = opt(input.name);
    if (query) clauses.push(`fullText contains ${quoteQ(query)}`);
    if (name) clauses.push(`name contains ${quoteQ(name)}`);
    if (input.type) {
      const filter = TYPE_FILTERS[String(input.type)];
      if (!filter) throw new Error(`Unknown type "${input.type}". Use one of: ${Object.keys(TYPE_FILTERS).join(', ')}.`);
      clauses.push(filter);
    }
    if (input.folder) clauses.push(`${quoteQ(fileIdOf(input.folder, 'folder'))} in parents`);
    const params = new URLSearchParams({
      q: clauses.join(' and '),
      pageSize: String(Math.min(100, Math.max(1, Number(input.count) || 20))),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: 'allDrives',
    });
    // Drive refuses to sort full-text searches; it ranks those by relevance.
    if (!query) params.set('orderBy', 'modifiedTime desc');
    if (opt(input.page_token)) params.set('pageToken', input.page_token);
    const data = await googleJson<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}/files?${params}`, { signal });
    const files = data.files ?? [];
    if (!files.length) return { output: 'No matching files in Google Drive.' };
    const more = data.nextPageToken ? `\n\n[More results: pass page_token "${data.nextPageToken}".]` : '';
    return { output: clip(files.map((f, i) => `${i + 1}. ${describeFile(f)}`).join('\n') + more) };
  },
};

/** Export formats for Google's own file types: format → [MIME type, extension]. The first is the default. */
const EXPORTS: Record<string, Record<string, [string, string]>> = {
  [MIME.document]: {
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    pdf: ['application/pdf', '.pdf'],
    md: ['text/markdown', '.md'],
    txt: ['text/plain', '.txt'],
    html: ['application/zip', '.zip'],
    odt: ['application/vnd.oasis.opendocument.text', '.odt'],
    rtf: ['application/rtf', '.rtf'],
    epub: ['application/epub+zip', '.epub'],
  },
  [MIME.spreadsheet]: {
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    csv: ['text/csv', '.csv'],
    tsv: ['text/tab-separated-values', '.tsv'],
    pdf: ['application/pdf', '.pdf'],
    ods: ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
  },
  [MIME.presentation]: {
    pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
    pdf: ['application/pdf', '.pdf'],
    txt: ['text/plain', '.txt'],
    odp: ['application/vnd.oasis.opendocument.presentation', '.odp'],
  },
  [MIME.drawing]: {
    png: ['image/png', '.png'],
    svg: ['image/svg+xml', '.svg'],
    pdf: ['application/pdf', '.pdf'],
    jpg: ['image/jpeg', '.jpg'],
  },
};

const driveDownload: Tool = {
  name: 'drive_download',
  description:
    'Download a Google Drive file into the workspace (under drive/ unless save_as is given), to read with read_file or process with a script. ' +
    'Google Docs export as docx by default (also pdf, md, txt, html, odt, rtf, epub), Sheets as xlsx (also csv/tsv of the first sheet, pdf, ods), ' +
    'Slides as pptx (also pdf, txt, odp), Drawings as png (also svg, pdf, jpg). Other files download as they are. ' +
    'To read a Doc or Sheet, docs_read and sheets_read are quicker.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File ID or link.' },
      format: { type: 'string', description: 'Export format for Google Docs, Sheets, Slides and Drawings.' },
      save_as: { type: 'string', description: 'Workspace path to save to.' },
    },
    required: ['file'],
  },
  async run(input, { conversationId, signal, workspace: ws }) {
    let file = await getFile(fileIdOf(input.file), signal);
    if (file.mimeType === MIME.shortcut && file.shortcutDetails) file = await getFile(file.shortcutDetails.targetId, signal);
    if (file.mimeType === MIME.folder) throw new Error(`"${file.name}" is a folder. List it with drive_search folder="${file.id}".`);

    const exports = EXPORTS[file.mimeType];
    let url: string;
    let ext = '';
    if (exports) {
      const format = (opt(input.format) ?? Object.keys(exports)[0]).toLowerCase().replace(/^\./, '');
      const target = exports[format];
      if (!target) throw new Error(`A ${kindOf(file.mimeType)} can be exported as: ${Object.keys(exports).join(', ')}.`);
      url = `${DRIVE}/files/${file.id}/export?mimeType=${encodeURIComponent(target[0])}`;
      ext = target[1];
    } else if (file.mimeType.startsWith(G)) {
      throw new Error(`${kindOf(file.mimeType)} files can't be downloaded.`);
    } else {
      if (Number(file.size) > MAX_TRANSFER_BYTES) throw new Error(`"${file.name}" is ${formatSize(Number(file.size))}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);
      url = `${DRIVE}/files/${file.id}?alt=media&${ALL_DRIVES}`;
    }

    const saveAs = opt(input.save_as) ? ws.normalizePath(input.save_as) : '';
    if (saveAs) {
      if (ws.dirAt(saveAs).exists) throw new Error(`"${saveAs}" is a folder.`);
      requireObserved(conversationId, saveAs, 'overwrite');
    }
    const res = await googleFetch(url, { signal, headers: { Accept: '*/*' } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = safeName(file.name);
    const path = saveAs || ws.freePath(ext && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name, 'drive');
    ws.ensureParent(path);
    const out = ws.fileAt(path);
    await out.write(bytes);
    return { output: `Saved “${file.name}” (${kindOf(file.mimeType)}) to ${path} (${formatSize(out.size)}).`, files: [path] };
  },
};


/** What a file converts to when uploaded with convert: true. */
const CONVERT_TO: Record<string, string> = {
  docx: MIME.document,
  doc: MIME.document,
  odt: MIME.document,
  rtf: MIME.document,
  txt: MIME.document,
  md: MIME.document,
  html: MIME.document,
  htm: MIME.document,
  xlsx: MIME.spreadsheet,
  xls: MIME.spreadsheet,
  ods: MIME.spreadsheet,
  csv: MIME.spreadsheet,
  tsv: MIME.spreadsheet,
  pptx: MIME.presentation,
  ppt: MIME.presentation,
  odp: MIME.presentation,
};

const driveUpload: Tool = {
  name: 'drive_upload',
  description:
    "Upload a workspace file to the user's Google Drive. With convert: true, Office, OpenDocument, Markdown, HTML, text and CSV files become Google Docs, Sheets or Slides. " +
    "Pass replace to overwrite an existing Drive file's content instead (it keeps its ID, link and sharing; a Google Doc/Sheet/Slides is replaced by the converted upload). " +
    'Returns the new file’s ID and link.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace path of the file to upload.' },
      folder: { type: 'string', description: 'Folder ID or link to upload into. Default My Drive.' },
      name: { type: 'string', description: 'Name in Drive. Default the file name (without extension when converting).' },
      convert: { type: 'boolean', description: 'Convert to a Google Doc, Sheet or Slides. Default false.' },
      replace: { type: 'string', description: 'ID or link of an existing Drive file whose content to replace.' },
    },
    required: ['path'],
  },
  async run(input, { signal, workspace: ws }) {
    const path = ws.normalizePath(str(input.path, 'path'));
    const file = ws.fileAt(path);
    if (!file.exists) throw new Error(`No such file: "${path}".`);
    if (file.size > MAX_TRANSFER_BYTES) throw new Error(`${path} is ${formatSize(file.size)}, over the ${formatSize(MAX_TRANSFER_BYTES)} limit.`);
    const base = path.split('/').pop()!;
    const ext = base.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
    const mime = EXT_MIME[ext] || file.type || 'application/octet-stream';
    const bytes = await file.bytes();
    const fields = `fields=${FILE_FIELDS}&${ALL_DRIVES}`;

    if (opt(input.replace)) {
      const id = fileIdOf(input.replace, 'replace');
      const meta = opt(input.name) ? { name: input.name.trim() } : {};
      const { body, contentType } = multipart(meta, bytes, mime);
      const res = await googleFetch(`${DRIVE_UPLOAD}/files/${id}?uploadType=multipart&${fields}`, {
        method: 'PATCH',
        headers: { 'Content-Type': contentType },
        body,
        signal,
      });
      const f = (await res.json()) as DriveFile;
      return { output: `Replaced the content of “${f.name}” with ${path}.\n${describeFile(f)}` };
    }

    const target = input.convert ? CONVERT_TO[ext] : undefined;
    if (input.convert && !target) throw new Error(`.${ext || base} files can't be converted to a Google format; upload without convert.`);
    const name = opt(input.name) ?? (target ? base.replace(/\.[^.]+$/, '') : base);
    const meta = {
      name,
      ...(target ? { mimeType: target } : {}),
      ...(input.folder ? { parents: [fileIdOf(input.folder, 'folder')] } : {}),
    };
    const { body, contentType } = multipart(meta, bytes, mime);
    const res = await googleFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&${fields}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal,
    });
    const f = (await res.json()) as DriveFile;
    return { output: `Uploaded ${path} to Google Drive${target ? ` as a ${kindOf(target)}` : ''}.\n${describeFile(f)}` };
  },
};

const driveManage: Tool = {
  name: 'drive_manage',
  description:
    "Organise the user's Google Drive: create_folder (name, optional folder as parent), rename (file, name), move (file, folder), " +
    'copy (file, optional name and folder), trash (file: moves it to Drive’s trash, where the user can restore it), or untrash (file).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create_folder', 'rename', 'move', 'copy', 'trash', 'untrash'] },
      file: { type: 'string', description: 'ID or link of the file or folder to act on.' },
      name: { type: 'string', description: 'New name (create_folder, rename, copy).' },
      folder: { type: 'string', description: 'Destination or parent folder ID or link ("root" for My Drive).' },
    },
    required: ['action'],
  },
  async run(input, { signal }) {
    const action = str(input.action, 'action');
    const q = `fields=${FILE_FIELDS}&${ALL_DRIVES}`;
    const folder = input.folder ? fileIdOf(input.folder, 'folder') : undefined;
    const patch = (id: string, json: object, extra = '') =>
      googleJson<DriveFile>(`${DRIVE}/files/${id}?${q}${extra}`, { method: 'PATCH', json, signal });

    switch (action) {
      case 'create_folder': {
        const f = await googleJson<DriveFile>(`${DRIVE}/files?${q}`, {
          method: 'POST',
          json: { name: str(input.name, 'name'), mimeType: MIME.folder, ...(folder ? { parents: [folder] } : {}) },
          signal,
        });
        return { output: `Created folder.\n${describeFile(f)}` };
      }
      case 'rename': {
        const f = await patch(fileIdOf(input.file), { name: str(input.name, 'name') });
        return { output: `Renamed to “${f.name}”.\n${describeFile(f)}` };
      }
      case 'move': {
        if (!folder) throw new Error('Pass the destination folder.');
        const current = await getFile(fileIdOf(input.file), signal);
        const f = await patch(current.id, {}, `&addParents=${folder}&removeParents=${(current.parents ?? []).join(',')}`);
        return { output: `Moved “${f.name}”.\n${describeFile(f)}` };
      }
      case 'copy': {
        const f = await googleJson<DriveFile>(`${DRIVE}/files/${fileIdOf(input.file)}/copy?${q}`, {
          method: 'POST',
          json: { ...(opt(input.name) ? { name: input.name.trim() } : {}), ...(folder ? { parents: [folder] } : {}) },
          signal,
        });
        return { output: `Made a copy.\n${describeFile(f)}` };
      }
      case 'trash':
      case 'untrash': {
        const f = await patch(fileIdOf(input.file), { trashed: action === 'trash' });
        return {
          output: action === 'trash' ? `Moved “${f.name}” to the Drive trash (restorable for 30 days).` : `Restored “${f.name}” from the trash.\n${describeFile(f)}`,
        };
      }
      default:
        throw new Error(`Unknown action "${action}".`);
    }
  },
};

// ---- Docs ----------------------------------------------------------------------------------

type DocParagraph = {
  elements?: { startIndex?: number; endIndex?: number; textRun?: { content?: string } }[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { nestingLevel?: number };
};
type DocElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocParagraph;
  table?: { tableRows?: { tableCells?: { content?: DocElement[] }[] }[] };
  tableOfContents?: { content?: DocElement[] };
};
type GoogleDoc = { documentId: string; title: string; revisionId?: string; body?: { content?: DocElement[] } };

const docLink = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** The document's text as one string, with each character's index in the document. */
function flatten(content: DocElement[] = []) {
  let text = '';
  const index: number[] = [];
  const visit = (elements: DocElement[]) => {
    for (const el of elements) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          const run = pe.textRun?.content;
          if (!run || pe.startIndex == null) continue;
          text += run;
          for (let i = 0; i < run.length; i++) index.push(pe.startIndex + i);
        }
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) for (const cell of row.tableCells ?? []) visit(cell.content ?? []);
      } else if (el.tableOfContents) visit(el.tableOfContents.content ?? []);
    }
  };
  visit(content);
  return { text, index };
}

const HEADING_MARK: Record<string, string> = {
  TITLE: '# ',
  SUBTITLE: '## ',
  HEADING_1: '# ',
  HEADING_2: '## ',
  HEADING_3: '### ',
  HEADING_4: '#### ',
  HEADING_5: '##### ',
  HEADING_6: '###### ',
};

const paragraphText = (p: DocParagraph) => (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('').replace(/\n$/, '');

/** The document as readable text: headings marked with #, list items with -, tables as | rows |. */
function renderDoc(content: DocElement[] = []): string {
  const out: string[] = [];
  for (const el of content) {
    if (el.paragraph) {
      const p = el.paragraph;
      const text = paragraphText(p);
      const style = p.paragraphStyle?.namedStyleType ?? '';
      const mark = p.bullet ? `${'  '.repeat(p.bullet.nestingLevel ?? 0)}- ` : HEADING_MARK[style] ?? '';
      out.push(style === 'TITLE' ? `${mark}${text}  (title)` : `${mark}${text}`);
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => renderDoc(c.content ?? []).replace(/\n+/g, ' / ').trim());
        out.push(`| ${cells.join(' | ')} |`);
      }
    } else if (el.tableOfContents) out.push('[Table of contents]');
  }
  return out.join('\n');
}

const getDoc = (id: string, signal?: AbortSignal) => googleJson<GoogleDoc>(`${DOCS}/${encodeURIComponent(id)}`, { signal });

const docsRead: Tool = {
  name: 'docs_read',
  description:
    'Read a Google Doc: its title, link and text, with headings marked by #, list items by - and table rows as | cells |. ' +
    'Those marks show structure and are not in the text itself. Long documents come in parts: pass start to read on.',
  parameters: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document ID or link.' },
      start: { type: 'integer', description: 'Character offset to read from. Default 0.' },
    },
    required: ['document'],
  },
  async run(input, { signal }) {
    const doc = await getDoc(fileIdOf(input.document, 'document'), signal);
    const text = renderDoc(doc.body?.content);
    const start = Math.max(0, Number(input.start) || 0);
    const page = text.slice(start, start + MAX_OUTPUT_CHARS - 1000);
    const end = start + page.length;
    const range =
      start > 0 || end < text.length ? `\n[Characters ${start}-${end} of ${text.length}.${end < text.length ? ` Pass start=${end} to read on.` : ''}]` : '';
    return { output: `# ${doc.title}\n${docLink(doc.documentId)}${range}\n\n${page || '[The document is empty.]'}` };
  },
};

const PARAGRAPH_STYLES = ['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'BULLET', 'NUMBERED'];

/** Requests that give the paragraphs in [start, end) a style (or make them a list). */
function styleRequests(style: string, start: number, end: number): object[] {
  if (end <= start) return [];
  const range = { startIndex: start, endIndex: end };
  if (style === 'BULLET' || style === 'NUMBERED') {
    return [
      {
        createParagraphBullets: {
          range,
          bulletPreset: style === 'BULLET' ? 'BULLET_DISC_CIRCLE_SQUARE' : 'NUMBERED_DECIMAL_ALPHA_ROMAN',
        },
      },
    ];
  }
  return [
    { deleteParagraphBullets: { range } },
    { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType' } },
  ];
}

type DocEdit = { type?: string; find?: string; text?: string; all?: boolean; after?: string; before?: string; style?: string };

const docsEdit: Tool = {
  name: 'docs_edit',
  description:
    'Edit a Google Doc in place. Read it with docs_read first and quote its text exactly (without the #, - and | marks docs_read adds). ' +
    'Edits, applied together: ' +
    '{"type":"replace","find","text"} replaces text; ' +
    '{"type":"delete","find"} deletes text; ' +
    '{"type":"insert","text","after"|"before"?} inserts text after or before a quoted passage, or with neither at the end of the document as new paragraphs; ' +
    '{"type":"style","find","style"} restyles the paragraphs containing the passage. ' +
    '"find", "after" and "before" must match exactly once unless "all": true (replace/delete every match). Use \\n in text to start new paragraphs. ' +
    `"style" on insert or style edits: ${PARAGRAPH_STYLES.join(', ')}.`,
  parameters: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document ID or link.' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['replace', 'delete', 'insert', 'style'] },
            find: { type: 'string' },
            text: { type: 'string' },
            all: { type: 'boolean' },
            after: { type: 'string' },
            before: { type: 'string' },
            style: { type: 'string', enum: PARAGRAPH_STYLES },
          },
          required: ['type'],
        },
      },
    },
    required: ['document', 'edits'],
  },
  async run(input, { signal }) {
    const edits: DocEdit[] = typeof input.edits === 'string' ? JSON.parse(input.edits) : input.edits;
    if (!Array.isArray(edits) || !edits.length) throw new Error('Pass at least one edit.');
    const doc = await getDoc(fileIdOf(input.document, 'document'), signal);
    const { text, index } = flatten(doc.body?.content);
    const content = doc.body?.content ?? [];
    const bodyEnd = content[content.length - 1]?.endIndex ?? 1;

    const matches = (needle: string, all: boolean | undefined, label: string, n: number) => {
      if (!needle) throw new Error(`Edit ${n}: "${label}" is empty.`);
      const found: number[] = [];
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) found.push(at);
      if (!found.length) {
        throw new Error(`Edit ${n}: "${needle.slice(0, 80)}" was not found. Read the document with docs_read and quote its text exactly, without # or - marks.`);
      }
      if (found.length > 1 && !all) {
        throw new Error(`Edit ${n}: "${needle.slice(0, 80)}" occurs ${found.length} times. Quote more of the text around it, or set all: true.`);
      }
      // Document range of each match.
      return found.map((at) => ({ start: index[at], end: index[at + needle.length - 1] + 1 }));
    };

    type Group = { start: number; end: number; order: number; requests: object[] };
    const groups: Group[] = [];
    edits.forEach((edit, i) => {
      const n = i + 1;
      const type = edit.type ?? (edit.find != null ? 'replace' : 'insert');
      const style = edit.style ? String(edit.style).toUpperCase() : undefined;
      if (style && !PARAGRAPH_STYLES.includes(style)) throw new Error(`Edit ${n}: unknown style "${edit.style}".`);
      switch (type) {
        case 'replace':
        case 'delete': {
          const replacement = type === 'delete' ? '' : (edit.text ?? '');
          for (const r of matches(edit.find ?? '', edit.all, 'find', n)) {
            groups.push({
              start: r.start,
              end: r.end,
              order: i,
              requests: [
                { deleteContentRange: { range: { startIndex: r.start, endIndex: r.end } } },
                ...(replacement ? [{ insertText: { location: { index: r.start }, text: replacement } }] : []),
                ...(style && replacement ? styleRequests(style, r.start, r.start + replacement.length) : []),
              ],
            });
          }
          break;
        }
        case 'insert': {
          let insert = edit.text ?? '';
          if (!insert) throw new Error(`Edit ${n}: "text" is empty.`);
          let at: number;
          let styleFrom: number;
          let defaultStyle: string | undefined;
          if (edit.after != null || edit.before != null) {
            const [r] = matches((edit.after ?? edit.before)!, false, edit.after != null ? 'after' : 'before', n);
            at = edit.after != null ? r.end : r.start;
            styleFrom = at;
          } else {
            // New paragraphs at the end: start one unless the document's last paragraph is empty.
            at = bodyEnd - 1;
            insert = insert.replace(/\n$/, '');
            const lastChar = text[text.length - 2];
            const lead = text.length > 1 && lastChar !== '\n' ? '\n' : '';
            insert = lead + insert;
            styleFrom = at + lead.length;
            // Otherwise the new paragraphs would take the style of the last one, often a heading.
            defaultStyle = 'NORMAL_TEXT';
          }
          const applied = style ?? defaultStyle;
          groups.push({
            start: at,
            end: at,
            order: i,
            requests: [
              { insertText: { location: { index: at }, text: insert } },
              ...(applied ? styleRequests(applied, styleFrom, at + insert.length) : []),
            ],
          });
          break;
        }
        case 'style': {
          if (!style) throw new Error(`Edit ${n}: pass the style.`);
          for (const r of matches(edit.find ?? '', edit.all, 'find', n)) {
            groups.push({ start: r.start, end: r.end, order: i, requests: styleRequests(style, r.start, r.end) });
          }
          break;
        }
        default:
          throw new Error(`Edit ${n}: unknown type "${type}".`);
      }
    });

    // Applied from the end of the document backwards, so each edit's positions are still right
    // when it runs. At the same spot, a replacement goes before an insertion there (or deleting
    // the replaced text would take the inserted text with it), and insertions keep their order.
    groups.sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start) || b.order - a.order);
    for (let i = 1; i < groups.length; i++) {
      const later = groups[i - 1];
      const earlier = groups[i];
      if (earlier.end > later.start && !(earlier.start === earlier.end && later.start === later.end)) {
        throw new Error(`Edits ${earlier.order + 1} and ${later.order + 1} overlap. Combine them into one edit.`);
      }
    }
    await googleJson(`${DOCS}/${doc.documentId}:batchUpdate`, {
      method: 'POST',
      json: {
        requests: groups.flatMap((g) => g.requests),
        ...(doc.revisionId ? { writeControl: { requiredRevisionId: doc.revisionId } } : {}),
      },
      signal,
    });
    return {
      output: `Made ${edits.length} edit${edits.length === 1 ? '' : 's'} (${groups.length} change${groups.length === 1 ? '' : 's'}) to “${doc.title}”: ${docLink(doc.documentId)}`,
    };
  },
};

const docsCreate: Tool = {
  name: 'docs_create',
  description:
    "Create a Google Doc in the user's Drive from Markdown (default) or plain text. Markdown headings, bold/italic, lists, tables, links and code come out formatted. " +
    'Returns the new document’s ID and link.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string', description: 'The document body.' },
      format: { type: 'string', enum: ['markdown', 'text'], description: 'How content is written. Default markdown.' },
      folder: { type: 'string', description: 'Folder ID or link to create it in. Default My Drive.' },
    },
    required: ['title'],
  },
  async run(input, { signal }) {
    const title = str(input.title, 'title');
    const content = typeof input.content === 'string' ? input.content : '';
    const folder = input.folder ? fileIdOf(input.folder, 'folder') : undefined;

    // Through Drive, which converts Markdown on import; the Docs API alone only takes plain text.
    if (hasScope('google', GOOGLE_SCOPES.drive) || hasScope('google', GOOGLE_SCOPES.driveFile)) {
      const mime = input.format === 'text' ? 'text/plain' : 'text/markdown';
      const meta = { name: title, mimeType: MIME.document, ...(folder ? { parents: [folder] } : {}) };
      const { body, contentType } = multipart(meta, new TextEncoder().encode(content), `${mime}; charset=UTF-8`);
      const res = await googleFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}&${ALL_DRIVES}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
        signal,
      });
      const f = (await res.json()) as DriveFile;
      return { output: `Created the Google Doc “${f.name}”.\n${describeFile(f)}` };
    }

    const doc = await googleJson<GoogleDoc>(DOCS, { method: 'POST', json: { title }, signal });
    if (content) {
      await googleJson(`${DOCS}/${doc.documentId}:batchUpdate`, {
        method: 'POST',
        json: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
        signal,
      });
    }
    const note = [
      input.format !== 'text' && content ? 'Without Google Drive access, the content went in as plain text.' : '',
      folder ? 'It is in My Drive: without Google Drive access it could not be put in the folder.' : '',
    ].filter(Boolean);
    return { output: `Created the Google Doc “${doc.title}”: ${docLink(doc.documentId)} (id ${doc.documentId}).${note.length ? `\n${note.join(' ')}` : ''}` };
  },
};

// ---- Sheets --------------------------------------------------------------------------------

type SheetProps = { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } };
type Spreadsheet = { spreadsheetId: string; spreadsheetUrl?: string; properties?: { title?: string }; sheets?: { properties: SheetProps }[] };

const sheetLink = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

const getSpreadsheet = (id: string, signal?: AbortSignal) =>
  googleJson<Spreadsheet>(
    `${SHEETS}/${encodeURIComponent(id)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`,
    { signal }
  );

const quoteSheet = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** Column letters for a 1-based column number: 1 → A, 27 → AA. */
function columnName(n: number) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function columnNumber(letters: string) {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64;
  return n;
}

/** The sheet title in an A1 range ("'My sheet'!A1:B2" → "My sheet"), if it names one. */
function sheetOf(range: string) {
  const bang = range.lastIndexOf('!');
  if (bang < 0) return /^[A-Z]{1,3}\d*(:[A-Z]{1,3}\d*)?$|^\d+:\d+$/i.test(range) ? undefined : range.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  return range.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
}

/** Cells as a grid with their row numbers and column letters, starting where `range` starts. */
function renderValues(range: string, values: unknown[][]) {
  const corner = range.split('!').pop()!.split(':')[0];
  const m = corner.match(/^([A-Z]*)(\d*)$/i);
  const col0 = m?.[1] ? columnNumber(m[1]) : 1;
  const row0 = m?.[2] ? Number(m[2]) : 1;
  const width = Math.max(0, ...values.map((r) => r.length));
  if (!values.length || !width) return '[No values in this range.]';
  const header = ['', ...Array.from({ length: width }, (_, i) => columnName(col0 + i))].join('\t');
  const rows = values.map((r, i) => [String(row0 + i), ...r.map((v) => String(v ?? '').replace(/[\t\n]/g, ' '))].join('\t'));
  return `${header}\n${rows.join('\n')}`;
}

const sheetsRead: Tool = {
  name: 'sheets_read',
  description:
    'Read a Google Sheet. Without a range, lists its sheets with their sizes and shows the first 200 rows of the first sheet. ' +
    'With an A1 range (e.g. "Sales!A1:F50", "Sheet1", "B:D"), shows those cells with their row numbers and column letters. formulas: true shows formulas instead of values.',
  parameters: {
    type: 'object',
    properties: {
      spreadsheet: { type: 'string', description: 'Spreadsheet ID or link.' },
      range: { type: 'string', description: 'A1 range to read.' },
      formulas: { type: 'boolean', description: 'Show formulas instead of their results. Default false.' },
    },
    required: ['spreadsheet'],
  },
  async run(input, { signal }) {
    const id = fileIdOf(input.spreadsheet, 'spreadsheet');
    const meta = await getSpreadsheet(id, signal);
    const sheets = meta.sheets ?? [];
    const range = opt(input.range) ?? (sheets[0] ? `${quoteSheet(sheets[0].properties.title)}!1:200` : 'A1:Z200');
    const render = input.formulas ? 'FORMULA' : 'FORMATTED_VALUE';
    const data = await googleJson<{ range: string; values?: unknown[][] }>(
      `${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=${render}`,
      { signal }
    );
    const list = sheets
      .map((s) => `- ${s.properties.title} (${s.properties.gridProperties?.rowCount ?? '?'} rows × ${s.properties.gridProperties?.columnCount ?? '?'} columns)`)
      .join('\n');
    return {
      output: clip(
        `# ${meta.properties?.title ?? 'Spreadsheet'}\n${meta.spreadsheetUrl ?? sheetLink(id)}\nSheets:\n${list}\n\n${data.range}:\n${renderValues(data.range, data.values ?? [])}`
      ),
    };
  },
};

function valuesOf(input: unknown): unknown[][] {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(raw)) throw new Error('values must be an array of rows, each an array of cells.');
  return raw.map((row) => (Array.isArray(row) ? row : [row]));
}

const sheetsWrite: Tool = {
  name: 'sheets_write',
  description:
    'Change cells in a Google Sheet. mode "update" (default) writes values into a range starting at its top-left cell; "append" adds rows after the table in the range; "clear" empties the range. ' +
    'Values are entered as if typed, so "=SUM(B2:B9)" becomes a formula and "3/4/2026" a date. ' +
    'create_sheet: true adds the sheet named in the range first when it does not exist.',
  parameters: {
    type: 'object',
    properties: {
      spreadsheet: { type: 'string', description: 'Spreadsheet ID or link.' },
      range: { type: 'string', description: 'A1 range, e.g. "Sheet1!A1" or "Budget!A2:D".' },
      values: { type: 'array', items: { type: 'array', items: {} }, description: 'Rows of cells, e.g. [["Name","Total"],["Ana",12]].' },
      mode: { type: 'string', enum: ['update', 'append', 'clear'] },
      create_sheet: { type: 'boolean' },
    },
    required: ['spreadsheet', 'range'],
  },
  async run(input, { signal }) {
    const id = fileIdOf(input.spreadsheet, 'spreadsheet');
    const range = str(input.range, 'range').trim();
    const mode = opt(input.mode) ?? 'update';
    let added = '';
    if (input.create_sheet) {
      const title = sheetOf(range);
      if (!title) throw new Error('create_sheet needs the sheet named in the range, e.g. "New sheet!A1".');
      const meta = await getSpreadsheet(id, signal);
      if (!meta.sheets?.some((s) => s.properties.title === title)) {
        await googleJson(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', json: { requests: [{ addSheet: { properties: { title } } }] }, signal });
        added = `Added the sheet “${title}”. `;
      }
    }
    const base = `${SHEETS}/${id}/values/${encodeURIComponent(range)}`;
    if (mode === 'clear') {
      const r = await googleJson<{ clearedRange?: string }>(`${base}:clear`, { method: 'POST', json: {}, signal });
      return { output: `${added}Cleared ${r.clearedRange ?? range}. ${sheetLink(id)}` };
    }
    const values = valuesOf(input.values);
    if (!values.length) throw new Error('Pass the values to write.');
    if (mode === 'append') {
      const r = await googleJson<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
        `${base}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', json: { values }, signal }
      );
      return { output: `${added}Appended ${r.updates?.updatedRows ?? values.length} rows at ${r.updates?.updatedRange ?? range}. ${sheetLink(id)}` };
    }
    if (mode !== 'update') throw new Error(`Unknown mode "${mode}".`);
    const r = await googleJson<{ updatedRange?: string; updatedCells?: number }>(`${base}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      json: { values },
      signal,
    });
    return { output: `${added}Wrote ${r.updatedCells ?? 0} cells in ${r.updatedRange ?? range}. ${sheetLink(id)}` };
  },
};

const sheetsCreate: Tool = {
  name: 'sheets_create',
  description:
    "Create a Google Sheet in the user's Drive, optionally with named sheets and their first rows (entered as if typed, so formulas work). Returns its ID and link.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, values: { type: 'array', items: { type: 'array', items: {} } } },
          required: ['title'],
        },
        description: 'Sheets to make, in order. Default one sheet named Sheet1.',
      },
      folder: { type: 'string', description: 'Folder ID or link to create it in. Default My Drive.' },
    },
    required: ['title'],
  },
  async run(input, { signal }) {
    const title = str(input.title, 'title');
    const sheets: { title: string; values?: unknown }[] =
      typeof input.sheets === 'string' ? JSON.parse(input.sheets) : Array.isArray(input.sheets) ? input.sheets : [];
    const created = await googleJson<Spreadsheet>(SHEETS, {
      method: 'POST',
      json: {
        properties: { title },
        ...(sheets.length ? { sheets: sheets.map((s) => ({ properties: { title: str(s.title, 'sheets[].title') } })) } : {}),
      },
      signal,
    });
    const data = sheets
      .filter((s) => s.values != null)
      .map((s) => ({ range: `${quoteSheet(s.title)}!A1`, values: valuesOf(s.values) }))
      .filter((d) => d.values.length);
    if (data.length) {
      await googleJson(`${SHEETS}/${created.spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        json: { valueInputOption: 'USER_ENTERED', data },
        signal,
      });
    }
    let note = '';
    if (input.folder) {
      const folder = fileIdOf(input.folder, 'folder');
      if (hasScope('google', GOOGLE_SCOPES.drive) || hasScope('google', GOOGLE_SCOPES.driveFile)) {
        await googleJson(`${DRIVE}/files/${created.spreadsheetId}?addParents=${folder}&removeParents=root&${ALL_DRIVES}`, {
          method: 'PATCH',
          json: {},
          signal,
        });
      } else note = '\nIt is in My Drive: without Google Drive access it could not be put in the folder.';
    }
    const link = created.spreadsheetUrl ?? sheetLink(created.spreadsheetId);
    return { output: `Created the Google Sheet “${title}”: ${link} (id ${created.spreadsheetId}).${note}` };
  },
};

export const GOOGLE_TOOLS: Tool[] = [
  driveSearch,
  driveDownload,
  driveUpload,
  driveManage,
  docsRead,
  docsCreate,
  docsEdit,
  sheetsRead,
  sheetsWrite,
  sheetsCreate,
];

export const GOOGLE_LABELS: ToolLabels = {
  drive_search: (i) => (field(i, 'query') || field(i, 'name') ? `Search Drive “${short(field(i, 'query') || field(i, 'name'))}”` : 'List recent Drive files'),
  drive_download: (i) => (field(i, 'format') ? `Download from Drive as ${field(i, 'format').toUpperCase()}` : 'Download from Drive'),
  drive_upload: (i) => (field(i, 'replace') ? `Replace a Drive file with ${field(i, 'path')}` : `Upload ${field(i, 'path')} to Drive`),
  drive_manage: (i) =>
    ({
      create_folder: `Create Drive folder “${short(field(i, 'name'))}”`,
      rename: `Rename to “${short(field(i, 'name'))}”`,
      move: 'Move a Drive file',
      copy: field(i, 'name') ? `Copy as “${short(field(i, 'name'))}”` : 'Copy a Drive file',
      trash: 'Move a Drive file to the trash',
      untrash: 'Restore a Drive file',
    })[field(i, 'action')] ?? 'Organise Drive',
  docs_read: () => 'Read a Google Doc',
  docs_create: (i) => `Create Google Doc “${short(field(i, 'title'))}”`,
  docs_edit: (i) => (Array.isArray(i.edits) && i.edits.length > 1 ? `Edit a Google Doc (${i.edits.length} edits)` : 'Edit a Google Doc'),
  sheets_read: (i) => (field(i, 'range') ? `Read ${field(i, 'range')}` : 'Read a Google Sheet'),
  sheets_write: (i) => `${field(i, 'mode') === 'append' ? 'Append to' : field(i, 'mode') === 'clear' ? 'Clear' : 'Write'} ${field(i, 'range') || 'cells'}`,
  sheets_create: (i) => `Create Google Sheet “${short(field(i, 'title'))}”`,
};
