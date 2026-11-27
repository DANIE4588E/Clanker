import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeRequire = createRequire(path.join(root, 'package.json'));
const ts = nodeRequire('typescript');

// ---- expo-file-system on a temp folder, counting writes ------------------------------------------

function fileSystem(base) {
  const writes = [];
  const reads = [];
  /** Paths (relative to base) whose reads fail, as an I/O error would. */
  const unreadable = new Set();
  const resolve = (parts) => path.join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)));
  class File {
    constructor(...parts) {
      this.uri = resolve(parts);
    }
    get name() {
      return path.basename(this.uri);
    }
    get exists() {
      return fs.existsSync(this.uri) && fs.statSync(this.uri).isFile();
    }
    // Asynchronous since SDK 58: storage must use writeSync, or writes land out of order.
    write() {
      throw new Error('File.write() is asynchronous; storage must use writeSync()');
    }
    writeSync(text) {
      writes.push(path.relative(base, this.uri).replaceAll('\\', '/'));
      fs.writeFileSync(this.uri, text);
    }
    textSync() {
      const rel = path.relative(base, this.uri).replaceAll('\\', '/');
      if (unreadable.has(rel)) throw new Error(`I/O error reading ${rel}`);
      reads.push(rel);
      return fs.readFileSync(this.uri, 'utf8');
    }
    rename(name) {
      const to = path.join(path.dirname(this.uri), name);
      fs.renameSync(this.uri, to);
      this.uri = to;
    }
    delete() {
      fs.rmSync(this.uri);
    }
  }
  class Directory {
    constructor(...parts) {
      this.uri = resolve(parts);
    }
    get name() {
      return path.basename(this.uri);
    }
    get exists() {
      return fs.existsSync(this.uri) && fs.statSync(this.uri).isDirectory();
    }
    create() {
      fs.mkdirSync(this.uri, { recursive: true });
    }
    list() {
      return fs.readdirSync(this.uri, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? new Directory(this.uri, e.name) : new File(this.uri, e.name)
      );
    }
    delete() {
      fs.rmSync(this.uri, { recursive: true });
    }
  }
  return { module: { File, Directory, Paths: { document: base } }, writes, reads, unreadable };
}

/** A fresh copy of lib/storage on its own temp folder. */
function load() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-storage-'));
  const files = fileSystem(base);
  const source = fs.readFileSync(path.join(root, 'src/lib/storage.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const stubs = {
    'expo-file-system': files.module,
    'expo-secure-store': {},
    'react-native': { AppState: { addEventListener: () => {} } },
  };
  const module = { exports: {} };
  const require = (name) => {
    if (name in stubs) return stubs[name];
    throw new Error(`storage.ts imports ${name}, which the test doesn't stub`);
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: 'storage.ts' })(
    require,
    module,
    module.exports
  );
  const data = path.join(base, 'data');
  return {
    lib: module.exports,
    writes: files.writes,
    data,
    read: (name) => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8')),
    exists: (name) => fs.existsSync(path.join(data, name)),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const chat = (id, text) => ({ id, title: id, messages: [{ id: 'm', content: [{ type: 'text', text }] }] });

test('moves the single chats file to a file per chat, and deletes it once done', (t) => {
  const s = load();
  t.after(s.cleanup);
  fs.mkdirSync(s.data, { recursive: true });
  const legacy = { version: 2, state: { conversations: { a: chat('a', 'hi'), b: chat('b', 'yo') } } };
  fs.writeFileSync(path.join(s.data, 'chats.json'), JSON.stringify(legacy));

  const storage = s.lib.splitJsonFileStorage('conversations');
  const loaded = storage.getItem('chats');
  assert.deepEqual(loaded, legacy);

  storage.setItem('chats', loaded);
  s.lib.flushJsonStorage();
  assert.deepEqual(s.read('chats/a.json'), chat('a', 'hi'));
  assert.deepEqual(s.read('chats/b.json'), chat('b', 'yo'));
  assert.deepEqual(s.read('chats.meta.json'), { version: 2, state: {}, keys: ['a', 'b'] });
  assert.equal(s.exists('chats.json'), false);
});

test('reads the split back, in the order it was saved', (t) => {
  const s = load();
  t.after(s.cleanup);
  const storage = s.lib.splitJsonFileStorage('conversations');
  const value = { version: 2, state: { conversations: { z: chat('z', '1'), a: chat('a', '2'), m: chat('m', '3') } } };
  storage.setItem('chats', value);
  s.lib.flushJsonStorage();

  const again = load();
  t.after(again.cleanup);
  // A fresh module on the same folder: copy the files over.
  fs.cpSync(s.data, again.data, { recursive: true });
  const loaded = again.lib.splitJsonFileStorage('conversations').getItem('chats');
  assert.deepEqual(loaded, value);
  assert.deepEqual(Object.keys(loaded.state.conversations), ['z', 'a', 'm']);
});

test('writes only the chats that changed, and removes deleted ones', (t) => {
  const s = load();
  t.after(s.cleanup);
  const storage = s.lib.splitJsonFileStorage('conversations');
  const a = chat('a', 'hi');
  const b = chat('b', 'yo');
  storage.setItem('chats', { version: 2, state: { conversations: { a, b } } });
  s.lib.flushJsonStorage();
  s.writes.length = 0;

  const b2 = chat('b', 'yo there');
  storage.setItem('chats', { version: 2, state: { conversations: { a, b: b2 } } });
  s.lib.flushJsonStorage();
  assert.deepEqual(s.writes, ['data/chats/b.json', 'data/chats.meta.json']);
  assert.deepEqual(s.read('chats/b.json'), b2);

  s.writes.length = 0;
  storage.setItem('chats', { version: 2, state: { conversations: { b: b2 } } });
  s.lib.flushJsonStorage();
  assert.deepEqual(s.writes, ['data/chats.meta.json']);
  assert.equal(s.exists('chats/a.json'), false);
});

test('after loading, a save leaves the chats it read alone', (t) => {
  const s = load();
  t.after(s.cleanup);
  fs.mkdirSync(path.join(s.data, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'chats/a.json'), JSON.stringify(chat('a', 'hi')));
  fs.writeFileSync(path.join(s.data, 'chats/b.json'), JSON.stringify(chat('b', 'yo')));
  fs.writeFileSync(path.join(s.data, 'chats.meta.json'), JSON.stringify({ version: 2, state: {}, keys: ['a', 'b'] }));

  const storage = s.lib.splitJsonFileStorage('conversations');
  const loaded = storage.getItem('chats');
  const a2 = chat('a', 'changed');
  storage.setItem('chats', { version: 2, state: { conversations: { ...loaded.state.conversations, a: a2 } } });
  s.lib.flushJsonStorage();
  assert.deepEqual(s.writes, ['data/chats/a.json', 'data/chats.meta.json']);
});

test('a new version writes every chat, since migrating may change them in place', (t) => {
  const s = load();
  t.after(s.cleanup);
  const storage = s.lib.splitJsonFileStorage('conversations');
  const a = chat('a', 'hi');
  storage.setItem('chats', { version: 2, state: { conversations: { a } } });
  s.lib.flushJsonStorage();
  s.writes.length = 0;

  a.backendId = 'local';
  storage.setItem('chats', { version: 3, state: { conversations: { a } } });
  s.lib.flushJsonStorage();
  assert.deepEqual(s.writes, ['data/chats/a.json', 'data/chats.meta.json']);
  assert.equal(s.read('chats/a.json').backendId, 'local');
});

test('a damaged chat file loses only that chat', (t) => {
  const s = load();
  t.after(s.cleanup);
  fs.mkdirSync(path.join(s.data, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'chats/a.json'), JSON.stringify(chat('a', 'hi')));
  fs.writeFileSync(path.join(s.data, 'chats/b.json'), '{"id":"b","mess');
  fs.writeFileSync(path.join(s.data, 'chats.meta.json'), JSON.stringify({ version: 2, state: {}, keys: ['a', 'b'] }));

  const loaded = s.lib.splitJsonFileStorage('conversations').getItem('chats');
  assert.deepEqual(loaded.state.conversations, { a: chat('a', 'hi') });
});

test('an unfinished move is ignored in favour of the single file', (t) => {
  const s = load();
  t.after(s.cleanup);
  const legacy = { version: 2, state: { conversations: { a: chat('a', 'hi') } } };
  fs.mkdirSync(path.join(s.data, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'chats.json'), JSON.stringify(legacy));
  // Killed after writing a chat file but before the meta file.
  fs.writeFileSync(path.join(s.data, 'chats/a.json'), JSON.stringify(chat('a', 'hi')));

  assert.deepEqual(s.lib.splitJsonFileStorage('conversations').getItem('chats'), legacy);
});

test('other stores still save to a single file', (t) => {
  const s = load();
  t.after(s.cleanup);
  s.lib.jsonFileStorage.setItem('memory', { version: 0, state: { memories: [1] } });
  s.lib.flushJsonStorage();
  assert.deepEqual(s.read('memory.json'), { version: 0, state: { memories: [1] } });
});

// ---- the chats store on top of it: chats load on demand ------------------------------------------

/**
 * lib/storage, lib/chatIndex and store/chats (with the real zustand) on the temp folder `base`, as
 * the app would launch on it. Each call is a fresh launch.
 */
function launch(base) {
  const files = fileSystem(base);
  const cache = new Map();
  const { File } = files.module;
  const stubs = {
    'expo-file-system': files.module,
    'expo-secure-store': {},
    'expo-sharing': {},
    'react-native': { AppState: { addEventListener: () => {} }, Platform: { OS: 'android' } },
    '@/lib/attachments': { deleteAttachment() {}, attachmentUri: (name) => path.join(base, 'attachments', name) },
    '@/lib/workspace': {
      chatWorkspace: () => ({ remove() {} }),
      Workspace: class {
        constructor(key) {
          this.key = key;
        }
        fileAt(rel) {
          return new File(base, 'workspaces', this.key.replace(':', '_'), rel);
        }
      },
    },
    '@/lib/remote/cache': { removeRemoteCache() {} },
    '@/lib/chatExport': {},
    '@/lib/projects': { workspaceKeyOf: (c) => (c.projectId ? `project:${c.projectId}` : c.workspace === 'shared' ? 'shared' : `chat:${c.id}`) },
    '@/store/library': { useLibrary: {} },
    '@/store/backends': {},
    '@/store/settings': {},
  };
  const real = ['@/lib/storage', '@/lib/chatIndex', '@/store/chats', '@/lib/library', '@/lib/activity'];
  const load = (spec) => {
    if (cache.has(spec)) return cache.get(spec);
    const file = path.join(root, spec.replace(/^@\//, 'src/') + '.ts');
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    cache.set(spec, module.exports);
    const require = (name) => {
      if (name.startsWith('./')) name = path.posix.join(path.posix.dirname(spec), name);
      if (name in stubs) return stubs[name];
      if (real.includes(name)) return load(name);
      if (name.startsWith('@/') || name.startsWith('.')) throw new Error(`${spec} imports ${name}, which the test doesn't stub`);
      return nodeRequire(name);
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(require, module, module.exports);
    cache.set(spec, module.exports);
    return module.exports;
  };
  const storage = load('@/lib/storage');
  const chats = load('@/store/chats');
  const data = path.join(base, 'data');
  return {
    base,
    load,
    storage,
    chats,
    store: chats.useChats,
    state: () => chats.useChats.getState(),
    writes: files.writes,
    reads: files.reads,
    unreadable: files.unreadable,
    flush: () => storage.flushJsonStorage(),
    file: (name) => path.join(data, name),
    read: (name) => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8')),
    exists: (name) => fs.existsSync(path.join(data, name)),
  };
}

function tempBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-chats-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

const say = (app, id, role, text, extra = {}) =>
  app.state().addMessage(id, { role, status: 'done', content: [{ type: 'text', text }], ...extra });

/** Two chats with a few messages each, saved, on a fresh folder. */
function twoChats(t) {
  const base = tempBase(t);
  const app = launch(base);
  const a = app.state().create('endpoint', 'model');
  say(app, a, 'user', 'first question');
  say(app, a, 'assistant', 'first answer', { steps: [{ tokens: 10, ms: 100, input: 50, cached: 20 }] });
  const b = app.state().create('endpoint', 'model');
  say(app, b, 'user', 'about the trip\nwith details');
  say(app, b, 'assistant', 'the trip answer');
  app.state().rename(b, 'Trip');
  app.flush();
  return { base, a, b, before: app.state().conversations };
}

const plain = (c) => JSON.parse(JSON.stringify(c));

test('chats come back as they were saved, without reading any chat file at launch', (t) => {
  const { base, a, b, before } = twoChats(t);
  const app = launch(base);
  const { conversations } = app.state();
  assert.deepEqual(Object.keys(conversations), [a, b]);
  assert.deepEqual(app.reads, ['data/chats.meta.json']);
  // What lists show needs no chat file either.
  assert.equal(conversations[b].title, 'Trip');
  assert.equal(app.chats.messageCount(conversations[a]), 2);
  assert.equal(app.chats.chatPreview(conversations[b]), 'about the trip');
  assert.equal(app.chats.isWorking(conversations[a]), false);
  assert.deepEqual(app.reads, ['data/chats.meta.json']);
  // Reading a chat's messages reads its file, and only its file.
  assert.deepEqual(conversations[a].messages, before[a].messages);
  assert.deepEqual(app.reads, ['data/chats.meta.json', `data/chats/${a}.json`]);
  assert.deepEqual(plain(conversations[b]), plain(before[b]));
});

test('saving never writes a chat that was not loaded', (t) => {
  const { base, a, b } = twoChats(t);
  const bFile = fs.readFileSync(path.join(base, 'data/chats', `${b}.json`), 'utf8');
  const app = launch(base);
  say(app, a, 'user', 'another question');
  app.flush();
  assert.deepEqual(app.writes, [`data/chats/${a}.json`, 'data/chats.meta.json']);
  assert.equal(fs.readFileSync(path.join(base, 'data/chats', `${b}.json`), 'utf8'), bFile);
  assert.equal(app.reads.includes(`data/chats/${b}.json`), false);

  const again = launch(base);
  assert.equal(again.state().conversations[a].messages.length, 3);
  assert.equal(again.state().conversations[b].messages.length, 2);
});

test('renaming, pinning and archiving a chat not loaded changes only the chat list', (t) => {
  const { base, b, before } = twoChats(t);
  const app = launch(base);
  app.state().rename(b, 'Trip to Rome');
  app.state().setPinned(b, true);
  app.state().setArchived(b, true);
  app.flush();
  assert.deepEqual(app.writes, ['data/chats.meta.json']);
  assert.deepEqual(app.reads, ['data/chats.meta.json']);
  assert.equal(app.storage.isStub(app.state().conversations[b]), true);

  const again = launch(base);
  const c = again.state().conversations[b];
  assert.equal(c.title, 'Trip to Rome');
  assert.ok(c.archivedAt);
  assert.equal(c.pinnedAt, undefined);
  assert.deepEqual(c.messages, before[b].messages);
});

test('deleting a chat not loaded deletes its file', (t) => {
  const { base, a, b } = twoChats(t);
  const app = launch(base);
  app.state().remove(b);
  app.flush();
  assert.equal(app.exists(`chats/${b}.json`), false);
  const again = launch(base);
  assert.deepEqual(Object.keys(again.state().conversations), [a]);
});

test('moving a chat not loaded keeps its messages', (t) => {
  const { base, b, before } = twoChats(t);
  const app = launch(base);
  app.state().moveTo(b, 'project1');
  app.flush();
  const again = launch(base);
  const c = again.state().conversations[b];
  assert.equal(c.projectId, 'project1');
  assert.deepEqual(c.messages, before[b].messages);
});

test('a copy of a chat not loaded is a whole chat', (t) => {
  const { base, b, before } = twoChats(t);
  const app = launch(base);
  const copy = { ...app.state().conversations[b], id: 'copy' };
  app.state().insert(copy);
  app.flush();
  assert.deepEqual(app.read('chats/copy.json').messages, before[b].messages);
});

test('the chat list summarises usage, uploads and handed-over files', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('endpoint', 'model');
  app.state().addMessage(id, {
    role: 'user',
    status: 'done',
    content: [{ type: 'file', name: 'notes.txt', mimeType: 'text/plain', text: 'hello there' }, { type: 'text', text: 'read this' }],
  });
  app.state().addMessage(id, {
    role: 'assistant',
    status: 'done',
    model: 'other',
    content: [{ type: 'tool', id: 't', name: 'write_file', input: {}, status: 'done', files: ['report.md', 'test_check.py'] }],
    steps: [{ tokens: 5, ms: 10, input: 100 }],
  });
  app.flush();
  const { index } = app.read('chats.meta.json');
  const s = index[id].s;
  assert.equal(s.n, 2);
  assert.equal(s.p, 'read this');
  assert.deepEqual(s.f.map(([p]) => p), ['report.md']);
  assert.equal(s.up.length, 1);
  assert.equal(s.up[0].part.text, undefined);
  assert.equal(s.up[0].t, 1);
  assert.equal(s.up[0].z, 'hello there'.length);
  assert.deepEqual(s.u.map((u) => u.slice(1)), [['other', 100, 5, 0, 0, 1]]);
  // Kept out of the chat list: the messages and the inlined text.
  assert.equal(index[id].e.messages, undefined);
  assert.equal(JSON.stringify(index).includes('hello there'), false);
});

test('moves the single chats file to the chat list and a file per chat', (t) => {
  const base = tempBase(t);
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  const old = (id, text) => ({ id, title: id, titled: true, createdAt: 1, updatedAt: 1, endpointId: 'e', model: 'm', messages: [{ id: 'm', role: 'user', status: 'done', createdAt: 1, content: [{ type: 'text', text }] }] });
  fs.writeFileSync(path.join(base, 'data/chats.json'), JSON.stringify({ version: 2, state: { conversations: { a: old('a', 'hi'), b: old('b', 'yo') } } }));
  const app = launch(base);
  assert.equal(app.state().conversations.a.messages[0].content[0].text, 'hi');
  say(app, 'a', 'user', 'more');
  app.flush();
  assert.equal(app.exists('chats.json'), false);
  assert.deepEqual(app.read('chats.meta.json').keys, ['a', 'b']);

  const again = launch(base);
  assert.equal(again.storage.isStub(again.state().conversations.b), true);
  assert.equal(again.state().conversations.b.messages[0].content[0].text, 'yo');
  assert.equal(again.state().conversations.a.messages.length, 2);
});

test('a split from before the chat list is read whole once, then listed without rewriting the chats', (t) => {
  const base = tempBase(t);
  const old = { id: 'a', title: 'A', titled: true, createdAt: 1, updatedAt: 1, endpointId: 'e', model: 'm', backendId: 'local', messages: [{ id: 'm', role: 'user', status: 'done', createdAt: 1, content: [{ type: 'text', text: 'hi' }] }] };
  fs.mkdirSync(path.join(base, 'data/chats'), { recursive: true });
  fs.writeFileSync(path.join(base, 'data/chats/a.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(base, 'data/chats.meta.json'), JSON.stringify({ version: 2, state: {}, keys: ['a'] }));
  const app = launch(base);
  assert.deepEqual(plain(app.state().conversations.a), old);
  app.state().rename('a', 'Renamed');
  app.flush();
  assert.deepEqual(app.writes, ['data/chats.meta.json']);
  const again = launch(base);
  assert.equal(again.storage.isStub(again.state().conversations.a), true);
  assert.equal(again.state().conversations.a.title, 'Renamed');
  assert.deepEqual(again.state().conversations.a.messages, old.messages);
});

test('an unfinished move from the single file still falls back to it', (t) => {
  const base = tempBase(t);
  const old = { id: 'a', title: 'A', titled: true, createdAt: 1, updatedAt: 1, endpointId: 'e', model: 'm', messages: [] };
  fs.mkdirSync(path.join(base, 'data/chats'), { recursive: true });
  fs.writeFileSync(path.join(base, 'data/chats.json'), JSON.stringify({ version: 2, state: { conversations: { a: old } } }));
  fs.writeFileSync(path.join(base, 'data/chats/a.json'), JSON.stringify({ ...old, title: 'half-written' }));
  const app = launch(base);
  assert.equal(app.state().conversations.a.title, 'A');
});

test('a chat written just before the app died, ahead of the chat list, is kept', (t) => {
  const { base, a, b } = twoChats(t);
  const orphan = { id: 'late', title: 'Late', titled: true, createdAt: 1, updatedAt: 1, endpointId: 'e', model: 'm', backendId: 'local', messages: [] };
  fs.writeFileSync(path.join(base, 'data/chats/late.json'), JSON.stringify(orphan));
  const app = launch(base);
  assert.deepEqual(Object.keys(app.state().conversations), [a, b, 'late']);
  assert.equal(app.state().conversations.late.title, 'Late');
});

test('a chat deleted just before the app died stays deleted', (t) => {
  const { base, a, b } = twoChats(t);
  fs.rmSync(path.join(base, 'data/chats', `${b}.json`));
  const app = launch(base);
  assert.deepEqual(Object.keys(app.state().conversations), [a]);
});

test('a damaged chat file is set aside rather than overwritten', (t) => {
  const { base, a, b } = twoChats(t);
  fs.writeFileSync(path.join(base, 'data/chats', `${b}.json`), '{"id":"b","mess');
  const app = launch(base);
  assert.deepEqual(app.state().conversations[b].messages, []);
  assert.equal(app.exists(`chats/${b}.json.damaged`), true);
  assert.equal(app.state().conversations[a].messages.length, 2);
});

test('a streaming reply saves only itself, and is folded into the chat when done', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('endpoint', 'model');
  for (let i = 0; i < 30; i++) say(app, id, i % 2 ? 'assistant' : 'user', `message ${i}`);
  say(app, id, 'user', 'go on');
  app.flush();
  app.writes.length = 0;

  const reply = app.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  app.state().appendText(id, reply, 'Hello');
  app.flush();
  app.state().appendText(id, reply, ', world');
  app.flush();
  assert.deepEqual(
    app.writes.filter((w) => w.startsWith('data/chats/')),
    [`data/chats/${id}.tail`, `data/chats/${id}.tail`]
  );
  assert.equal(app.read(`chats/${id}.json`).messages.length, 31);
  assert.equal(JSON.parse(fs.readFileSync(app.file(`chats/${id}.tail`), 'utf8')).item.content[0].text, 'Hello, world');

  app.writes.length = 0;
  app.state().updateMessage(id, reply, { status: 'done' });
  app.flush();
  assert.deepEqual(app.writes, [`data/chats/${id}.json`, 'data/chats.meta.json']);
  assert.equal(app.exists(`chats/${id}.tail`), false);
  const again = launch(base);
  const last = again.state().conversations[id].messages.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.content[0].text, 'Hello, world');
  assert.equal(last.interrupted, undefined);
});

test('a reply cut off by the app dying comes back settled, with what streamed, and is picked up again', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('endpoint', 'model');
  say(app, id, 'user', 'tell me a story');
  app.flush();
  const reply = app.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  app.state().appendText(id, reply, 'Once upon');
  app.state().putDrafts(id, reply, [{ type: 'tool', id: 'd', name: 'web_search', input: {}, status: 'writing' }]);
  app.flush();
  app.state().appendText(id, reply, ' a time');
  app.flush();
  // Killed here: nothing more is written.
  const other = launch(base);
  const c = other.state().conversations[id];
  assert.equal(other.storage.isStub(c), true);
  assert.deepEqual(other.chats.takeCutOffReplies(), [id]);
  // The chat list knows without reading the chat, and doesn't show it as working.
  assert.equal(other.chats.isWorking(c), false);
  const last = c.messages.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.interrupted, 'Interrupted when the app closed');
  assert.deepEqual(last.content.map((p) => p.type), ['text', 'text']);
  assert.equal(last.content.map((p) => p.text).join(''), 'Once upon a time');
});

test('a chat whose file fails to read is moved aside, never written over', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('endpoint', 'model');
  say(app, id, 'user', 'keep me');
  say(app, id, 'assistant', 'and me');
  app.flush();
  const original = fs.readFileSync(app.file(`chats/${id}.json`), 'utf8');

  const again = launch(base);
  again.unreadable.add(`data/chats/${id}.json`);
  // Loads empty, since its file can't be read; then the user writes in it.
  assert.deepEqual(again.state().conversations[id].messages, []);
  again.unreadable.clear();
  say(again, id, 'user', 'new');
  again.flush();

  const aside = fs.readdirSync(app.file('chats')).filter((n) => n.startsWith(`${encodeURIComponent(id)}.json.unreadable-`));
  assert.equal(aside.length, 1, 'the unreadable file is kept beside the chat');
  assert.equal(fs.readFileSync(app.file(`chats/${aside[0]}`), 'utf8'), original);
});

test('a tail left from before its chat was rewritten is ignored', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('endpoint', 'model');
  say(app, id, 'user', 'hi');
  app.flush();
  const reply = app.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  app.state().appendText(id, reply, 'partial');
  app.flush();
  const stale = fs.readFileSync(app.file(`chats/${id}.tail`), 'utf8');
  app.state().appendText(id, reply, ' and finished');
  app.state().updateMessage(id, reply, { status: 'done' });
  app.flush();
  // Killed between writing the chat and deleting its tail.
  fs.writeFileSync(app.file(`chats/${id}.tail`), stale);
  const again = launch(base);
  const last = again.state().conversations[id].messages.at(-1);
  assert.equal(last.content[0].text, 'partial and finished');
  assert.equal(last.status, 'done');
});

test('a remote reply not loaded still shows as working', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('', 'agent', { backendId: 'remote1', remote: { bridgeId: 'b' } });
  say(app, id, 'user', 'hi');
  app.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  app.flush();
  const again = launch(base);
  const c = again.state().conversations[id];
  assert.equal(again.chats.isWorking(c), true);
  assert.deepEqual(again.chats.takeCutOffReplies(), []);
  assert.equal(c.messages.at(-1).status, 'streaming');
});

test('migrations reach chats that are loaded later', (t) => {
  const { base, b } = twoChats(t);
  const meta = JSON.parse(fs.readFileSync(path.join(base, 'data/chats.meta.json'), 'utf8'));
  meta.version = 0;
  delete meta.index[b].e.workspace;
  fs.writeFileSync(path.join(base, 'data/chats.meta.json'), JSON.stringify(meta));
  const app = launch(base);
  const c = app.state().conversations[b];
  assert.equal(c.workspace, 'shared');
  assert.equal(c.messages.length, 2);
  app.flush();
  assert.equal(app.read('chats.meta.json').version, 2);
  // The chat's own file is left alone; the list carries the change.
  assert.equal(app.writes.includes(`data/chats/${b}.json`), false);
  assert.equal(launch(base).state().conversations[b].workspace, 'shared');
});

test('settling at launch rebuilds only the messages that need it', (t) => {
  const app = launch(tempBase(t));
  const done = { id: 'd', role: 'user', status: 'done', createdAt: 1, content: [{ type: 'text', text: 'q' }] };
  const job = { id: 'j', role: 'assistant', status: 'done', createdAt: 2, content: [{ type: 'tool', id: 't', name: 'run', input: {}, status: 'done', background: { job: 'x', status: 'running' } }] };
  const merged = app.store.persist.getOptions().merge({ conversations: { c: { id: 'c', backendId: 'local', messages: [done, job] } } }, app.state());
  const out = merged.conversations.c.messages;
  assert.equal(out[0], done);
  assert.equal(out[1].content[0].background.status, 'lost');

  const untouched = [done];
  const again = app.store.persist.getOptions().merge({ conversations: { c: { id: 'c', backendId: 'local', messages: untouched } } }, app.state());
  assert.equal(again.conversations.c.messages, untouched);
});

test('reading every chat in the background loads them all', async (t) => {
  const { base, a, b } = twoChats(t);
  const app = launch(base);
  let progress = 0;
  await new Promise((resolve) => app.chats.hydrateChats({ onProgress: () => progress++, onDone: resolve }));
  assert.ok(progress >= 1);
  assert.equal(app.storage.stubLoaded(app.state().conversations[a]), true);
  assert.equal(app.storage.stubLoaded(app.state().conversations[b]), true);
  assert.ok(app.reads.includes(`data/chats/${b}.json`));
});

test('a chat file keeps the version it was written at, for migrating it when it is read', (t) => {
  const s = load();
  t.after(s.cleanup);
  // Written before the listing, at version 1, without saying so.
  fs.mkdirSync(path.join(s.data, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'chats/a.json'), JSON.stringify(chat('a', 'hi')));
  fs.writeFileSync(path.join(s.data, 'chats.meta.json'), JSON.stringify({ version: 1, state: {}, keys: ['a'] }));
  const revived = [];
  const lazy = { heavy: ['messages'], summarize: (c) => ({ n: c.messages.length }), revive: (c, v) => revived.push([c.id, v]) };
  const first = s.lib.splitJsonFileStorage('conversations', lazy);
  first.setItem('chats', first.getItem('chats'));
  s.lib.flushJsonStorage();
  assert.equal(s.read('chats.meta.json').index.a.v, 1);

  // The store moves to version 2 without reading the chat: its file stays at 1.
  const again = load();
  t.after(again.cleanup);
  fs.cpSync(s.data, again.data, { recursive: true });
  const second = again.lib.splitJsonFileStorage('conversations', lazy);
  const value = second.getItem('chats');
  second.setItem('chats', { ...value, version: 2 });
  again.lib.flushJsonStorage();
  assert.deepEqual(again.writes, ['data/chats.meta.json']);
  assert.equal(again.read('chats.meta.json').version, 2);

  const third = load();
  t.after(third.cleanup);
  fs.cpSync(again.data, third.data, { recursive: true });
  const stub = third.lib.splitJsonFileStorage('conversations', lazy).getItem('chats').state.conversations.a;
  assert.equal(stub.messages[0].content[0].text, 'hi');
  assert.deepEqual(revived, [['a', 1]]);
});

test('after a cut-off reply is read back, the next reply is not saved on top of the stale file', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  const id = app.state().create('endpoint', 'model');
  say(app, id, 'user', 'first');
  app.flush();
  const cut = app.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  app.state().appendText(id, cut, 'cut off');
  app.flush();
  // Killed. Next launch reads the chat (settling the reply) and a new reply streams straight after it.
  const next = launch(base);
  assert.equal(next.state().conversations[id].messages.length, 2);
  const reply = next.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  next.state().appendText(id, reply, 'second');
  next.flush();
  assert.ok(next.writes.includes(`data/chats/${id}.json`));
  next.state().appendText(id, reply, ' reply');
  next.flush();
  // Killed again.
  const third = launch(base);
  const messages = third.state().conversations[id].messages;
  assert.deepEqual(messages.map((m) => m.content[0]?.text), ['first', 'cut off', 'second reply']);
  assert.deepEqual(messages.map((m) => m.status), ['done', 'done', 'done']);
});

test('the Library and usage come out the same from the chat list as from the chats', (t) => {
  const base = tempBase(t);
  const app = launch(base);
  fs.mkdirSync(path.join(base, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(base, 'attachments', 'photo.png'), 'png');
  const id = app.state().create('endpoint', 'model');
  app.state().addMessage(id, {
    role: 'user',
    status: 'done',
    content: [
      { type: 'image', file: 'photo.png', mimeType: 'image/png' },
      { type: 'file', name: 'notes.txt', mimeType: 'text/plain', text: 'inlined notes' },
      { type: 'file', name: 'gone.pdf', mimeType: 'application/pdf', file: 'gone.pdf' },
      { type: 'text', text: 'look' },
    ],
  });
  const ws = path.join(base, 'workspaces', `chat_${id}`);
  fs.mkdirSync(ws, { recursive: true });
  for (const name of ['report.md', 'draft.md', 'deleted.md']) fs.writeFileSync(path.join(ws, name), name);
  fs.rmSync(path.join(ws, 'deleted.md'));
  app.state().addMessage(id, {
    role: 'assistant',
    status: 'done',
    model: 'big',
    content: [{ type: 'tool', id: 't1', name: 'write_file', input: {}, status: 'done', files: ['report.md', 'deleted.md'] }],
    steps: [{ tokens: 40, ms: 100, input: 900, cached: 300 }, { tokens: 10, ms: 50, input: 950 }],
  });
  const other = app.state().create('endpoint', 'small');
  say(app, other, 'user', 'hello');
  say(app, other, 'assistant', 'a reply without numbers, estimated from its text');
  const cut = app.state().addMessage(id, { role: 'assistant', status: 'streaming', content: [] });
  app.state().appendStream(id, cut, { text: 'writing', drafts: [] });
  app.state().putDrafts(id, cut, [{ type: 'tool', id: 't2', name: 'write_file', input: {}, status: 'writing' }]);
  app.state().settleDrafts(id, cut, [{ type: 'tool', id: 't2', name: 'write_file', input: {}, status: 'running', files: ['draft.md'] }]);
  app.flush();

  const shape = (items) => JSON.parse(JSON.stringify(items));
  const provider = (c) => `provider of ${c.id}`;
  // Killed mid-reply, then launched: everything from the chat list...
  const next = launch(base);
  const library = next.load('@/lib/library');
  const activity = next.load('@/lib/activity');
  const fromList = library.libraryItems(next.state().conversations);
  const usageFromList = activity.usageEvents(next.state().conversations, provider);
  assert.deepEqual(next.reads, ['data/chats.meta.json']);
  // ...is what the chats themselves give once read.
  for (const c of Object.values(next.state().conversations)) next.storage.loadStub(c);
  library.forgetLibraryStats();
  assert.deepEqual(shape(fromList), shape(library.libraryItems(next.state().conversations)));
  assert.deepEqual(usageFromList, activity.usageEvents(next.state().conversations, provider));

  assert.deepEqual(fromList.map((i) => i.name).sort(), ['IMG_' + fromList.find((i) => i.kind === 'image').name.slice(4), 'draft.md', 'notes.txt', 'report.md'].sort());
  assert.equal(fromList.find((i) => i.name === 'notes.txt').upload.part.text, 'inlined notes');
  const totals = (events) => events.reduce((n, e) => n + e.input + e.output, 0);
  assert.equal(totals(usageFromList), 900 + 950 + 50 + Math.ceil('a reply without numbers, estimated from its text'.length / 4) + Math.ceil('writing'.length / 4));
  assert.deepEqual([...new Set(usageFromList.map((e) => e.model))].sort(), ['big', 'model', 'small']);

  // The Usage page's numbers match counting reply by reply, as it used to.
  const perReply = [];
  for (const c of Object.values(next.state().conversations)) {
    for (const m of c.messages) {
      if (m.role !== 'assistant') continue;
      const steps = m.steps ?? [];
      let input = 0, output = 0, cached = 0, cacheable = 0;
      for (const st of steps) {
        output += st.tokens;
        input += st.input ?? 0;
        if (st.input && st.cached != null) {
          cached += st.cached;
          cacheable += st.input;
        }
      }
      if (!steps.length) output = Math.ceil(next.chats.messageText(m).length / 4);
      if (!input && !output) continue;
      perReply.push({ at: m.createdAt, day: activity.startOfDay(m.createdAt), conversationId: c.id, model: m.model ?? c.model, provider: provider(c), input, output, cached, cacheable, requests: Math.max(steps.length, 1) });
    }
  }
  perReply.sort((a, b) => a.at - b.at);
  assert.deepEqual(activity.summarize(usageFromList, -Infinity), activity.summarize(perReply, -Infinity));
  assert.deepEqual([...activity.dailyTotals(usageFromList)], [...activity.dailyTotals(perReply)]);
});
