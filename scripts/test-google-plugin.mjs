import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

/** Transpiles a TypeScript module and runs it with `stubs` in place of its imports. */
function load(file, stubs) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(
    (name) => stubs[name] ?? require(name),
    module,
    module.exports
  );
  return module.exports;
}

const common = {
  '../workspace': { formatSize: (n) => `${n} B` },
  './observe': { requireObserved() {} },
};

/** Loads src/lib/tools/google.ts with the Google API layer replaced by `api`. */
function loadTools(api) {
  const pluginUtil = load('src/lib/tools/pluginUtil.ts', { ...common, './web': { htmlToMarkdown: (html) => ({ text: html }) } });
  return load('src/lib/tools/google.ts', {
    ...common,
    '../plugins/catalog': { GOOGLE_SCOPES: { drive: 'drive', driveFile: 'drive.file' }, hasScope: () => true },
    '../plugins/auth': api,
    './pluginUtil': pluginUtil,
  });
}

/** A Google Doc body from paragraphs, with indexes as the Docs API numbers them (body starts at 1). */
function makeDoc(paragraphs) {
  const content = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
  let at = 1;
  for (const p of paragraphs) {
    const text = typeof p === 'string' ? p : p.text;
    const runs = typeof p === 'string' ? [text] : (p.runs ?? [text]);
    const elements = [];
    let i = at;
    for (const run of runs) {
      elements.push({ startIndex: i, endIndex: i + run.length, textRun: { content: run } });
      i += run.length;
    }
    content.push({
      startIndex: at,
      endIndex: at + text.length,
      paragraph: { elements, paragraphStyle: { namedStyleType: p.style ?? 'NORMAL_TEXT' } },
    });
    at += text.length;
  }
  return { documentId: 'doc1234567890', title: 'Test', revisionId: 'rev1', body: { content } };
}

/** Applies batchUpdate requests to the doc's text in order, as Docs does; checks style ranges stay inside it. */
function apply(doc, requests) {
  let text = doc.body.content.slice(1).map((el) => el.paragraph.elements.map((e) => e.textRun.content).join('')).join('');
  const inBounds = (start, end) => {
    assert.ok(start >= 1 && end <= text.length + 1 && start <= end, `range ${start}-${end} outside 1-${text.length + 1}`);
  };
  for (const r of requests) {
    if (r.insertText) {
      const at = r.insertText.location.index;
      assert.ok(at >= 1 && at <= text.length, `insert at ${at} outside the body`);
      text = text.slice(0, at - 1) + r.insertText.text + text.slice(at - 1);
    } else if (r.deleteContentRange) {
      const { startIndex, endIndex } = r.deleteContentRange.range;
      inBounds(startIndex, endIndex);
      assert.ok(endIndex <= text.length, 'deletes the final newline');
      text = text.slice(0, startIndex - 1) + text.slice(endIndex - 1);
    } else {
      const range = (r.updateParagraphStyle ?? r.deleteParagraphBullets ?? r.createParagraphBullets).range;
      inBounds(range.startIndex, range.endIndex);
      // A style range may not take in the body's final newline.
      assert.ok(range.endIndex <= text.length, 'style range covers the final newline');
    }
  }
  return text;
}

function fakeApi(doc) {
  const calls = [];
  return {
    calls,
    api: {
      async googleJson(url, init = {}) {
        calls.push({ url, ...init });
        if (url.endsWith(':batchUpdate')) return {};
        if (url.includes('docs.googleapis.com')) return doc;
        throw new Error(`unexpected ${url}`);
      },
      async googleFetch() {
        throw new Error('not used');
      },
    },
  };
}

async function edit(paragraphs, edits) {
  const doc = makeDoc(paragraphs);
  const { calls, api } = fakeApi(doc);
  const { GOOGLE_TOOLS } = loadTools(api);
  const tool = GOOGLE_TOOLS.find((t) => t.name === 'docs_edit');
  const outcome = await tool.run({ document: `https://docs.google.com/document/d/${doc.documentId}/edit`, edits }, {});
  const batch = calls.find((c) => c.url.endsWith(':batchUpdate'));
  assert.equal(batch.json.writeControl.requiredRevisionId, 'rev1');
  return { text: apply(doc, batch.json.requests), requests: batch.json.requests, outcome };
}

test('replaces a unique passage', async () => {
  const { text } = await edit(['Title\n', 'Hello world.\n'], [{ type: 'replace', find: 'world', text: 'there' }]);
  assert.equal(text, 'Title\nHello there.\n');
});

test('refuses an ambiguous passage unless all is set', async () => {
  await assert.rejects(edit(['a cat and a cat\n'], [{ type: 'replace', find: 'cat', text: 'dog' }]), /occurs 2 times/);
  const { text } = await edit(['a cat and a cat\n'], [{ type: 'replace', find: 'cat', text: 'dog', all: true }]);
  assert.equal(text, 'a dog and a dog\n');
});

test('applies several edits against the original positions', async () => {
  const { text } = await edit(
    ['Intro line\n', 'Second line here\n', 'Third\n'],
    [
      { type: 'replace', find: 'Intro', text: 'Opening' },
      { type: 'delete', find: ' here' },
      { type: 'insert', after: 'Third', text: ' and last' },
      { type: 'insert', before: 'Second', text: '>> ' },
    ]
  );
  assert.equal(text, 'Opening line\n>> Second line\nThird and last\n');
});

test('appends new paragraphs at the end, in normal text', async () => {
  const { text, requests } = await edit([{ text: 'Heading\n', style: 'HEADING_1' }], [{ type: 'insert', text: 'Body one\nBody two\n' }]);
  assert.equal(text, 'Heading\nBody one\nBody two\n');
  const style = requests.find((r) => r.updateParagraphStyle);
  assert.equal(style.updateParagraphStyle.paragraphStyle.namedStyleType, 'NORMAL_TEXT');
  // Starts after the heading's newline, so the heading keeps its style.
  assert.equal(style.updateParagraphStyle.range.startIndex, 1 + 'Heading\n'.length);
});

test('inserts before and replaces at the same spot without eating the insertion', async () => {
  const { text } = await edit(
    ['foo bar\n'],
    [
      { type: 'insert', before: 'foo', text: 'NEW ' },
      { type: 'replace', find: 'foo', text: 'baz' },
    ]
  );
  assert.equal(text, 'NEW baz bar\n');
});

test('keeps the order of insertions at the same spot', async () => {
  const { text } = await edit(['end\n'], [
    { type: 'insert', after: 'end', text: ' one' },
    { type: 'insert', after: 'end', text: ' two' },
  ]);
  assert.equal(text, 'end one two\n');
});

test('matches text split across runs', async () => {
  const { text } = await edit([{ text: 'Bold and plain\n', runs: ['Bold', ' and plain\n'] }], [{ type: 'replace', find: 'Bold and', text: 'Now' }]);
  assert.equal(text, 'Now plain\n');
});

test('refuses overlapping edits', async () => {
  await assert.rejects(
    edit(['one two three\n'], [
      { type: 'replace', find: 'one two', text: 'x' },
      { type: 'delete', find: 'two three' },
    ]),
    /overlap/
  );
});

test('reports text that is not there', async () => {
  await assert.rejects(edit(['Hello\n'], [{ type: 'delete', find: '# Hello' }]), /not found/);
});

test('reads a doc with structure marks', async () => {
  const doc = makeDoc([{ text: 'Plan\n', style: 'HEADING_1' }, 'Body text\n']);
  const { api } = fakeApi(doc);
  const { GOOGLE_TOOLS } = loadTools(api);
  const out = await GOOGLE_TOOLS.find((t) => t.name === 'docs_read').run({ document: doc.documentId }, {});
  assert.match(out.output, /# Test\nhttps:\/\/docs\.google\.com\/document\/d\/doc1234567890\/edit\n\n# Plan\nBody text/);
});

test('takes IDs and links', () => {
  const { fileIdOf } = loadTools(fakeApi(makeDoc([])).api);
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-012345';
  assert.equal(fileIdOf(id), id);
  assert.equal(fileIdOf(`https://docs.google.com/document/d/${id}/edit?tab=t.0`), id);
  assert.equal(fileIdOf(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(fileIdOf(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(fileIdOf(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(fileIdOf('root'), 'root');
  assert.throws(() => fileIdOf('my report'), /not a Google file ID/);
});

test('shows sheet cells with their positions', async () => {
  const api = {
    async googleJson(url) {
      if (url.includes('/values/')) return { range: "'Q3'!B2:C3", values: [['Name', 'Total'], ['Ana', '12']] };
      return { spreadsheetId: 's1', properties: { title: 'Budget' }, sheets: [{ properties: { sheetId: 0, title: 'Q3', gridProperties: { rowCount: 10, columnCount: 4 } } }] };
    },
    async googleFetch() {},
  };
  const { GOOGLE_TOOLS } = loadTools(api);
  const out = await GOOGLE_TOOLS.find((t) => t.name === 'sheets_read').run({ spreadsheet: 'spreadsheet1234' }, {});
  assert.match(out.output, /\tB\tC\n2\tName\tTotal\n3\tAna\t12/);
  assert.match(out.output, /- Q3 \(10 rows × 4 columns\)/);
});
