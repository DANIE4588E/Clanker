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
    write(text) {
      writes.push(path.relative(base, this.uri).replaceAll('\\', '/'));
      fs.writeFileSync(this.uri, text);
    }
    textSync() {
      return fs.readFileSync(this.uri, 'utf8');
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
  return { module: { File, Directory, Paths: { document: base } }, writes };
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
