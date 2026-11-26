import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Files may have Windows line endings.
const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const TOOL_FILES = ['google', 'googleMore', 'microsoft', 'developer', 'productivity', 'media'].map((f) => `src/lib/tools/${f}.ts`);

/** Tool names in the catalog, by plugin. */
function catalogTools() {
  const source = read('src/lib/plugins/catalog.ts');
  const plugins = {};
  for (const block of source.split(/\n {2}\{\n {4}id: '/).slice(1)) {
    const id = block.slice(0, block.indexOf("'"));
    plugins[id] = [...block.matchAll(/\{ name: '([a-z_]+)'/g)].map((m) => m[1]);
  }
  return plugins;
}

/** Names of Tool objects a file defines (`name: '...'` right after `const x: Tool = {`). */
const implemented = (source) => [...source.matchAll(/: Tool = \{\s*name: '([a-z_]+)'/g)].map((m) => m[1]);

/** Keys of a file's ToolLabels map. */
function labelled(source) {
  const start = source.search(/_LABELS: ToolLabels = \{/);
  if (start < 0) return [];
  return [...source.slice(start).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
}

test('every catalog tool is implemented once and labelled, and nothing else is', () => {
  const plugins = catalogTools();
  const listed = Object.values(plugins).flat();
  assert.ok(Object.keys(plugins).length >= 20, `only ${Object.keys(plugins).length} plugins in the catalog`);
  assert.equal(new Set(listed).size, listed.length, 'a tool name is listed twice in the catalog');

  const tools = TOOL_FILES.flatMap((f) => implemented(read(f)));
  const labels = new Set(TOOL_FILES.flatMap((f) => labelled(read(f))));
  assert.equal(new Set(tools).size, tools.length, 'a tool is implemented twice');

  const missing = listed.filter((n) => !tools.includes(n));
  const extra = tools.filter((n) => !listed.includes(n));
  const unlabelled = listed.filter((n) => !labels.has(n));
  assert.deepEqual(missing, [], `catalog tools without an implementation: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `implemented tools missing from the catalog: ${extra.join(', ')}`);
  assert.deepEqual(unlabelled, [], `tools without a chat label: ${unlabelled.join(', ')}`);
});

test('plugin tools are registered and every file is in the registry', () => {
  const registry = read('src/lib/tools/plugins.ts');
  for (const f of ['GOOGLE', 'GOOGLE_MORE', 'MICROSOFT', 'DEVELOPER', 'PRODUCTIVITY', 'MEDIA']) {
    assert.match(registry, new RegExp(`\\.\\.\\.${f}_TOOLS,`));
    assert.match(registry, new RegExp(`\\.\\.\\.${f}_LABELS,`));
  }
  assert.match(read('src/lib/tools/index.ts'), /\.\.\.PLUGIN_TOOLS,/);
});

test('tool schemas avoid constructs some model providers reject', () => {
  for (const f of TOOL_FILES) {
    const source = read(f);
    assert.doesNotMatch(source, /type: \[/, `${f} uses a JSON-schema type array`);
    assert.doesNotMatch(source, /\banyOf\b|\boneOf\b/, `${f} uses anyOf/oneOf`);
  }
});

test('every provider a plugin uses is defined', () => {
  const catalog = read('src/lib/plugins/catalog.ts');
  const providers = read('src/lib/plugins/providers.ts');
  for (const [, provider] of catalog.matchAll(/provider: '([a-z0-9]+)'/g)) {
    assert.match(providers, new RegExp(`\\n {2}${provider}: \\{`), `provider ${provider} is not defined`);
  }
});

test('every plugin has an icon', () => {
  const catalog = read('src/lib/plugins/catalog.ts');
  const icon = read('src/components/PluginIcon.tsx');
  const ids = [...catalog.matchAll(/\n {4}id: '([a-z0-9-]+)',/g)].map((m) => m[1]);
  const block = (name) => icon.slice(icon.indexOf(name), icon.indexOf('};', icon.indexOf(name)));
  const keyed = (text) => new Set([...text.matchAll(/^\s+'?([a-z0-9-]+)'?: /gm)].map((m) => m[1]));
  const marks = keyed(block('const SIMPLE_ICON'));
  const images = keyed(block('const IMAGES'));
  const drawn = new Set([...icon.matchAll(/case '([a-z0-9-]+)':/g)].map((m) => m[1]));
  const missing = ids.filter((id) => !marks.has(id) && !images.has(id) && !drawn.has(id));
  assert.deepEqual(missing, [], `plugins without an icon: ${missing.join(', ')}`);

  // Simple Icons marks must exist in marks.ts, and bundled images on disk.
  const markData = read('src/lib/plugins/marks.ts');
  for (const [, key] of block('const SIMPLE_ICON').matchAll(/: '([a-z0-9]+)',/g)) {
    assert.match(markData, new RegExp(`\n  ${key}: \{`), `marks.ts has no ${key}`);
  }
  for (const [, file] of icon.matchAll(/require\('\.\.\/\.\.\/(assets\/plugins\/[a-z0-9-]+\.png)'\)/g)) {
    assert.doesNotThrow(() => read(file), `missing ${file}`);
  }
});
