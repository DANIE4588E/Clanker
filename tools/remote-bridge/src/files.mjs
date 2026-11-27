import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, realpath, lstat, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_FILE_BYTES, UNSIGNED_PAYLOAD, assertId } from './protocol.mjs';

const inside = (root, candidate) => { const rel = path.relative(root, candidate); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const VERSION = /^[a-f0-9]{64}$/;
/** Dependency, VCS and cache directories: never deliverables, and often huge. */
export const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', '.next', '.nuxt', '.turbo', '.cache',
  '.parcel-cache', '.expo', '.dart_tool', 'Pods',
]);
const tooLarge = () => Object.assign(new Error('File exceeds 20 MB.'), { status: 413 });
/** Counts and hashes the bytes passing through, refusing more than 20 MB. */
const meter = (state) => new Transform({
  transform(chunk, _encoding, callback) {
    state.size += chunk.length;
    if (state.size > MAX_FILE_BYTES) return callback(tooLarge());
    state.hash.update(chunk); callback(null, chunk);
  },
});
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export class WorkspaceFiles {
  constructor(root, objects) {
    this.root = path.resolve(root); this.objects = path.resolve(objects);
    /** `${session}\0${path}` → the file's stat identity and content version, so unchanged files aren't re-read. */
    this.hashes = new Map();
    /** Versions present in the object store. */
    this.stored = new Set();
    /** Versions handed out recently, which garbage collection must not race. */
    this.recent = new Map();
  }
  async init() {
    await mkdir(this.root, { recursive: true }); await mkdir(this.objects, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink() || (await lstat(this.objects)).isSymbolicLink()) throw new Error('Workspace and object roots must not be symlinks.');
    this.root = await realpath(this.root); this.objects = await realpath(this.objects);
    for (const name of await readdir(this.objects)) if (VERSION.test(name)) this.stored.add(name);
  }
  async directory(sessionId) {
    const dir = path.join(this.root, assertId(sessionId));
    await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink() || !inside(this.root, await realpath(dir))) throw new Error('Unsafe workspace directory.');
    return dir;
  }
  async safeFile(sessionId, relative) {
    const dir = await this.directory(sessionId);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Unsafe file path.');
    const file = path.resolve(dir, relative);
    if (!inside(dir, file)) throw new Error('File escapes workspace.');
    let current = dir;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symlink file transfer is not allowed.');
    }
    if (!inside(dir, await realpath(file))) throw new Error('File escapes workspace.');
    return file;
  }
  async object(version) {
    if (!VERSION.test(version)) throw new Error('Invalid file version.');
    const file = path.join(this.objects, version);
    if ((await lstat(file)).isSymbolicLink() || !inside(this.objects, await realpath(file))) throw new Error('Unsafe stored file.');
    return file;
  }
  /** Moves a fully written temporary file into the store under its version, unless already there. */
  async commit(temp, version) {
    const target = path.join(this.objects, version);
    try { await lstat(target); await rm(temp, { force: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await rename(temp, target); }
    this.stored.add(version);
  }
  /** Reads a file once for its content version, without copying it. */
  async hash(file) {
    const state = { size: 0, hash: createHash('sha256') };
    await pipeline(createReadStream(file, { flags: readFlags }), meter(state), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    return { version: state.hash.digest('hex'), size: state.size };
  }
  /** Copies a file into the store, versioned by the bytes actually copied. */
  async store(file) {
    const temp = path.join(this.objects, `.part-${randomUUID()}`);
    const state = { size: 0, hash: createHash('sha256') };
    try {
      await pipeline(createReadStream(file, { flags: readFlags }), meter(state), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const version = state.hash.digest('hex');
      await this.commit(temp, version);
      return { version, size: state.size };
    } finally { await rm(temp, { force: true }); }
  }
  touch(version) { this.recent.set(version, Date.now()); }
  async snapshot(sessionId, relative, id) {
    const file = await this.safeFile(sessionId, relative);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const key = `${sessionId}\0${relative}`;
    const cached = this.hashes.get(key);
    let version, size;
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs && cached.ino === info.ino && this.stored.has(cached.version)) {
      ({ version, size } = cached);
    } else {
      try {
        ({ version, size } = await this.hash(file));
        // A changed stat with unchanged bytes (a touch, a rewrite) needs no new copy.
        if (!this.stored.has(version)) ({ version, size } = await this.store(file));
      } catch (error) { if (error.status === 413) return null; throw error; }
      // The stat taken before reading: a write during the read changes it, so the next listing re-reads.
      this.hashes.set(key, { size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, version });
    }
    this.touch(version);
    return { id: id ?? createHash('sha256').update(relative).digest('hex'), name: path.basename(relative), path: relative, size, version };
  }
  /**
   * Stores an upload in the chat's directory. `expectedSha256` is the signed body hash: a body that
   * doesn't match it is refused before anything is kept.
   */
  async upload(sessionId, uploadId, name, source, { expectedSha256 } = {}) {
    assertId(uploadId);
    const safeName = String(name ?? 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-140) || 'file';
    const relative = `${uploadId}_${safeName}`;
    const dir = await this.directory(sessionId);
    const temp = path.join(this.objects, `.part-${randomUUID()}`);
    const copy = path.join(this.objects, `.part-${randomUUID()}`);
    const state = { size: 0, hash: createHash('sha256') };
    try {
      await pipeline(source, meter(state), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const version = state.hash.digest('hex');
      if (expectedSha256 && expectedSha256 !== UNSIGNED_PAYLOAD && expectedSha256 !== version) throw Object.assign(new Error('Upload does not match its signature.'), { status: 401 });
      if (!this.stored.has(version)) { await copyFile(temp, copy, constants.COPYFILE_EXCL); await this.commit(copy, version); }
      await this.directory(sessionId);
      const target = path.join(dir, relative);
      try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Unsafe upload destination.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temp, target);
      const info = await stat(target);
      this.hashes.set(`${sessionId}\0${relative}`, { size: state.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, version });
      return await this.snapshot(sessionId, relative, uploadId);
    } finally { await rm(temp, { force: true }); await rm(copy, { force: true }); }
  }
  async list(sessionId) {
    const dir = await this.directory(sessionId); const files = [];
    const visit = async (relative = '') => {
      const entries = await readdir(path.join(dir, relative), { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= 1000) throw new Error('Workspace has more than 1000 transferable files.');
        if (entry.isSymbolicLink() || entry.name === '.git') continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (SKIPPED_DIRECTORIES.has(entry.name)) continue; await this.safeFile(sessionId, rel); await visit(rel); }
        else if (entry.isFile()) { const file = await this.snapshot(sessionId, rel); if (file) files.push(file); }
      }
    };
    await visit();
    // Forget hashes of files that are gone from this chat.
    const prefix = `${sessionId}\0`, present = new Set(files.map((file) => prefix + file.path));
    for (const key of this.hashes.keys()) if (key.startsWith(prefix) && !present.has(key)) this.hashes.delete(key);
    return files;
  }
  /**
   * Deletes stored versions nothing references any more, and abandoned partial files. Versions
   * handed out within `graceMs` are kept, as their references may not be saved yet.
   */
  async collect(keep, { graceMs = 60 * 60 * 1000, now = Date.now() } = {}) {
    for (const [version, at] of this.recent) if (now - at > graceMs) this.recent.delete(version);
    let removed = 0;
    for (const name of await readdir(this.objects)) {
      const file = path.join(this.objects, name);
      try {
        if (VERSION.test(name)) {
          if (keep.has(name) || this.recent.has(name)) continue;
          this.stored.delete(name); await rm(file, { force: true }); removed++;
        } else if (name.startsWith('.part-') && now - (await lstat(file)).mtimeMs > graceMs) await rm(file, { force: true });
      } catch { /* A file in use (Windows) stays until the next collection. */ }
    }
    return removed;
  }
}
