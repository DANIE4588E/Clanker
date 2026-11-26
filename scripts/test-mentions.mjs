import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeRequire = createRequire(path.join(root, 'package.json'));
const ts = nodeRequire('typescript');

/** Loads a TypeScript module from src/lib with its imports answered from `stubs`. */
function load(file, stubs) {
  const source = readFileSync(path.join(root, 'src/lib', file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name in stubs) return stubs[name];
    throw new Error(`${file} imports ${name}, which the test doesn't stub`);
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(require, module, module.exports);
  return module.exports;
}

// ---- a small world: one chat with a workspace, two earlier chats, a skill and a plugin ----------

const toolsOn = new Set(['read_chat', 'skill_view']);
const workspace = {
  key: 'chat:current',
  entries: () => [
    { path: 'reports', folder: true, modified: 0 },
    { path: 'reports/Morning brief.pdf', folder: false, modified: 1 },
    { path: 'notes.md', folder: false, modified: 2 },
  ],
};
const conversations = {
  current: { id: 'current', title: 'Now', messages: [{}], updatedAt: 3 },
  standup: { id: 'standup', title: 'Morning standup', messages: [{}], updatedAt: 2 },
  trip: { id: 'trip', title: 'Trip ideas', messages: [{}], updatedAt: 1 },
  temp: { id: 'temp', title: 'Morning secret', messages: [{}], updatedAt: 4, memory: false },
};
const plugins = [{ id: 'gmail', title: 'Gmail', summary: 'Mail' }];
const pluginTools = { gmail_send: true, gmail_search: false };

const quotes = load('quotes.ts', {});
const catalog = {
  PLUGINS: plugins,
  pluginReady: () => true,
  pluginOfTool: (name) => (name in pluginTools ? plugins[0] : undefined),
  pluginTools: () => Object.entries(pluginTools).map(([name, write]) => ({ name, write })),
};
const commands = load('commands.ts', { './plugins/catalog': catalog, './quotes': quotes });
const mentions = load('mentions.ts', {
  '@/store/chats': { useChats: { getState: () => ({ conversations }) } },
  '@/store/library': { useLibrary: { getState: () => ({ deleted: {}, purged: {} }) } },
  '@/store/skills': {
    useSkills: { getState: () => ({ skills: { 'pdf-tools': { name: 'pdf-tools', description: 'PDFs', enabled: true } } }) },
  },
  './commands': commands,
  './quotes': quotes,
  './library': {
    KIND_LABEL: { pdf: 'PDF' },
    libraryItems: () => [{ key: 'u:trip:1', name: 'Itinerary.pdf', kind: 'pdf', chatTitle: 'Trip ideas', workspace: 'chat:trip' }],
  },
  './memory': { readChat: (_from, id) => `TRANSCRIPT OF ${id}` },
  './plugins/catalog': catalog,
  './projects': { memoryPool: () => undefined, projectOf: () => undefined, workspaceFor: () => workspace },
  './skills': { readSkillMd: (name) => `INSTRUCTIONS FOR ${name}` },
  './tools': { toolOn: (name) => toolsOn.has(name) },
  './workspace': { projectWorkspace: () => workspace },
});

const titles = (sections) => sections.flatMap((s) => s.data.map((o) => o.title));

// ---- typing ----------------------------------------------------------------------------------

test('finds the "@" or "/" being typed before the cursor', () => {
  assert.deepEqual(mentions.mentionTrigger('@Morn', 5), { char: '@', start: 0, query: 'Morn' });
  assert.deepEqual(mentions.mentionTrigger('look at @reports/mo', 19), { char: '@', start: 8, query: 'reports/mo' });
  assert.deepEqual(mentions.mentionTrigger('/pl', 3), { char: '/', start: 0, query: 'pl' });
  // Spaces may be part of a name ("@Morning standup").
  assert.deepEqual(mentions.mentionTrigger('@Morning st', 11), { char: '@', start: 0, query: 'Morning st' });
});

test('ignores email addresses, "and/or", other lines and text past the cursor', () => {
  assert.equal(mentions.mentionTrigger('mail me at a@b', 14), null);
  assert.equal(mentions.mentionTrigger('this and/or that', 11), null);
  assert.equal(mentions.mentionTrigger('@a\nb', 4), null);
  assert.equal(mentions.mentionTrigger('hi @there', 2), null);
});

test('"@" alone shows everything; "@Morn" only what starts with morn, case aside', () => {
  const all = mentions.atSections('current', false);
  assert.deepEqual(
    all.map((s) => s.title),
    ['Workspace', 'Library', 'Chats']
  );
  assert.deepEqual(titles(mentions.filterSections(all, '')), [
    'reports',
    'Morning brief.pdf',
    'notes.md',
    'Itinerary.pdf',
    'Morning standup',
    'Trip ideas',
  ]);
  // Temporary chats can't be read from other chats, so they aren't offered.
  assert.deepEqual(titles(mentions.filterSections(all, 'Morn')), ['Morning brief.pdf', 'Morning standup']);
  assert.deepEqual(titles(mentions.filterSections(all, 'MORN')), ['Morning brief.pdf', 'Morning standup']);
  // A file matches by its name or by its path.
  assert.deepEqual(titles(mentions.filterSections(all, 'reports/m')), ['Morning brief.pdf']);
  assert.deepEqual(mentions.filterSections(all, 'zzz'), []);
});

test('remote chats offer only Library files', () => {
  assert.deepEqual(mentions.atSections('current', true).map((s) => s.title), ['Library']);
});

test('"/" offers commands only at the start, then skills and plugins', () => {
  assert.deepEqual(titles(mentions.slashSections(true)), ['/goal', '/plan', '/pdf-tools', '/Gmail']);
  assert.deepEqual(titles(mentions.slashSections(false)), ['/pdf-tools', '/Gmail']);
  assert.deepEqual(titles(mentions.filterSections(mentions.slashSections(true), 'G')), ['/goal', '/Gmail']);
  assert.equal(mentions.atStart('  /plan', 2), true);
  assert.equal(mentions.atStart('do /plan', 3), false);
});

// ---- sending ---------------------------------------------------------------------------------

test('resolves mentions in a sent message for the model', () => {
  const note = mentions.resolveMentions('current', 'Summarise @reports/Morning brief.pdf and compare with @Morning standup.').context;
  assert.match(note, /@reports\/Morning brief\.pdf: the file "reports\/Morning brief\.pdf" in the workspace/);
  assert.match(note, /@Morning standup: the earlier chat "Morning standup" \(chat_id standup\)\. Read it with read_chat/);
  assert.match(mentions.resolveMentions('current', 'what is in @reports/').context, /the folder "reports\/" in the workspace/);
  assert.match(mentions.resolveMentions('current', 'what is in @reports?').context, /the folder "reports\/"/);
});

test('picks the longest name a mention could be', () => {
  // "@reports" is a folder too, but the file is the longer match.
  const note = mentions.resolveMentions('current', '@reports/Morning brief.pdf').context;
  assert.doesNotMatch(note, /folder/);
});

test('resolves skills and plugins after "/", and plugins after "@" as before', () => {
  assert.match(mentions.resolveMentions('current', '/pdf-tools merge these').context, /\/pdf-tools: use the skill "pdf-tools"\. Load it with skill_view/);
  assert.match(mentions.resolveMentions('current', '/gmail find receipts').context, /\/gmail: use Gmail for this/);
  assert.match(mentions.resolveMentions('current', '@Gmail find receipts').context, /@Gmail: use Gmail for this/);
});

test('inlines chats and skills when there is no tool to read them with', () => {
  toolsOn.clear();
  try {
    assert.match(mentions.resolveMentions('current', '@Trip ideas').context, /<chat>\nTRANSCRIPT OF trip\n<\/chat>/);
    assert.match(mentions.resolveMentions('current', '/pdf-tools').context, /<skill name="pdf-tools">\nINSTRUCTIONS FOR pdf-tools/);
  } finally {
    toolsOn.add('read_chat').add('skill_view');
  }
});

test('leaves messages without mentions alone', () => {
  assert.equal(mentions.resolveMentions('current', 'mail a@b.com about and/or').context, undefined);
  assert.equal(mentions.resolveMentions('current', '@nobody here').context, undefined);
  assert.equal(mentions.resolveMentions('current', '@Morning standupish').context, undefined);
});

test('lists the mentions as written, for coloring', () => {
  assert.deepEqual(
    mentions.resolveMentions('current', '/plan merge @reports/ and @notes.md with /PDF-tools').mentions,
    ['@reports/', '@notes.md', '/PDF-tools', '/plan']
  );
  assert.deepEqual(mentions.resolveMentions('current', '/goal Ship it').mentions, ['/goal']);
  assert.deepEqual(mentions.resolveMentions('current', 'nothing here').mentions, []);
  // A file sent with the message can be named too.
  const sent = mentions.resolveMentions('current', 'read @Itinerary.pdf', ['Itinerary.pdf']);
  assert.deepEqual(sent.mentions, ['@Itinerary.pdf']);
  assert.match(sent.context, /the file "Itinerary\.pdf" attached to this message/);
});

test('cuts text into plain runs and mentions', () => {
  const labels = mentions.mentionLabels('current', false);
  const spans = (text) => mentions.mentionSpans(text, labels).map((s) => (s.mention ? `[${s.text}]` : s.text)).join('');
  assert.equal(spans('/plan sort @reports/Morning brief.pdf, then /gmail it'), '[/plan] sort [@reports/Morning brief.pdf], then [/gmail] it');
  assert.equal(spans('see @Morning standup.'), 'see [@Morning standup].');
  assert.equal(spans('see @reports and @reports/'), 'see [@reports] and [@reports/]');
  // Commands only count at the start; unknown names and emails stay plain.
  assert.equal(spans('do /plan now'), 'do /plan now');
  assert.equal(spans('@nobody mail a@b.com'), '@nobody mail a@b.com');
  // A sent message colors what it was found to have.
  assert.equal(
    mentions.mentionSpans('/goal fix @notes.md', mentions.sentLabels(['@notes.md', '/goal'])).filter((s) => s.mention).map((s) => s.text).join('|'),
    '/goal|@notes.md'
  );
});

test('adds the /plan and /goal instructions', () => {
  assert.match(mentions.resolveMentions('current', '/plan rename the files').context, /^\[\/plan: Plan mode is on for this chat/);
  assert.match(mentions.resolveMentions('current', '/goal Get every test passing').context, /The user set a goal for this chat: "Get every test passing"/);
});

// ---- commands --------------------------------------------------------------------------------

test('reads /goal', () => {
  assert.deepEqual(commands.goalCommand('/goal Ship v2'), { goal: 'Ship v2' });
  assert.deepEqual(commands.goalCommand('/GOAL  Ship v2 '), { goal: 'Ship v2' });
  assert.deepEqual(commands.goalCommand('/goal'), { status: true });
  assert.deepEqual(commands.goalCommand('/goal clear'), { clear: true });
  assert.deepEqual(commands.goalCommand('/goal Stop'), { clear: true });
  assert.deepEqual(commands.goalCommand('/goal pause'), { pause: true });
  assert.deepEqual(commands.goalCommand('/goal Resume'), { resume: true });
  // Only the bare word counts; a goal that happens to start with one is still a goal.
  assert.deepEqual(commands.goalCommand('/goal pause the music when I leave'), { goal: 'pause the music when I leave' });
  assert.equal(commands.goalControl('/goal clear'), true);
  assert.equal(commands.goalControl('/goal'), true);
  assert.equal(commands.goalControl('/goal ship it'), false);
  assert.equal(commands.goalCommand('/goals are nice'), null);
  assert.equal(commands.goalCommand('my /goal x'), null);
  // Quotes picked from the chat go ahead of the text.
  assert.deepEqual(commands.goalCommand('> some reply\n\n/goal Fix it'), { goal: 'Fix it' });
});

test('reads /plan', () => {
  assert.equal(commands.isPlanRequest('/plan the move'), true);
  assert.equal(commands.isPlanRequest('/PLAN'), true);
  assert.equal(commands.isPlanRequest('/planet'), false);
  assert.equal(commands.isPlanRequest('make a /plan'), false);
});

test('reads /plan as plan mode being switched', () => {
  assert.deepEqual(commands.planCommand('/plan move the files'), { start: 'move the files' });
  assert.deepEqual(commands.planCommand('/plan'), { start: '' });
  assert.deepEqual(commands.planCommand('/PLAN exit'), { exit: true });
  assert.deepEqual(commands.planCommand('/plan off'), { exit: true });
  assert.equal(commands.planCommand('/planet'), null);
  assert.equal(commands.planCommand('make a /plan'), null);
  // On its own, or leaving, it sends nothing; with a task it goes to the model.
  assert.equal(commands.planControl('/plan'), true);
  assert.equal(commands.planControl('/plan exit'), true);
  assert.equal(commands.planControl('/plan move the files'), false);
  assert.equal(commands.planControl('hello'), false);
  assert.deepEqual(commands.planCommand('> an earlier reply\n\n/plan fix it'), { start: 'fix it' });
});

test('plan mode tells looking from changing', () => {
  for (const name of ['write_file', 'edit_file', 'delete_path', 'run_python', 'run_shell', 'phone_tap', 'gmail_send', 'skill_manage', 'goal_start', 'goal_edit', 'goal_delete', 'goal_done']) {
    assert.equal(commands.changesThings(name), true, name);
  }
  for (const name of ['read_file', 'list_files', 'web_search', 'phone_screen', 'gmail_search', 'skill_view', 'ask_user', 'todo_write', 'exit_plan_mode']) {
    assert.equal(commands.changesThings(name), false, name);
  }
});
