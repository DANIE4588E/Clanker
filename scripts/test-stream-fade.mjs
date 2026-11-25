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

function loadStreamFade() {
  const source = readFileSync(path.join(root, 'src/lib/streamFade.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: 'src/lib/streamFade.ts' })(
    require,
    module,
    module.exports
  );
  return module.exports;
}

const {
  FADE_DURATION_MS,
  INITIAL_FADE_MAX_CHARS,
  MAX_BATCH_SPREAD_MS,
  MAX_QUEUE_AHEAD_MS,
  advanceFadeState,
  colorWithAlpha,
  createFadeState,
  fadeEndTime,
  fadeOpacity,
  pruneFadeState,
  splitFadeUnits,
} = loadStreamFade();

test('splitFadeUnits is lossless across prose, CJK, emojis, and long tokens', () => {
  const samples = [
    'Hello world! This is a test.',
    '  leading and trailing  ',
    '你好世界今天天气真好',
    'Mix 🚀🔥 emojis and supercalifragilisticexpialidocious!',
    'line1\n\nline2',
  ];
  for (const sample of samples) {
    const units = splitFadeUnits(sample);
    const rebuilt = units.map((u) => sample.slice(u.start, u.end)).join('');
    assert.equal(rebuilt, sample);
  }
  const cjk = splitFadeUnits('你好世界今天');
  assert.equal(cjk.length, 6);
  const longWord = splitFadeUnits('abcdefghijklmnopqrstuvwxyz');
  assert.ok(longWord.length >= 2);
});

test('fadeOpacity eases smoothly from 0 to 1 with soft start and end', () => {
  assert.equal(fadeOpacity(100, 90), 0);
  assert.equal(fadeOpacity(100, 100), 0);
  const q1 = fadeOpacity(100, 100 + FADE_DURATION_MS * 0.25);
  const mid = fadeOpacity(100, 100 + FADE_DURATION_MS * 0.5);
  const q3 = fadeOpacity(100, 100 + FADE_DURATION_MS * 0.75);
  assert.ok(q1 > 0 && q1 < 0.25, `expected soft start < 0.25, got ${q1}`);
  assert.equal(mid, 0.5);
  assert.ok(q3 > 0.75 && q3 < 1, `expected soft finish > 0.75, got ${q3}`);
  assert.equal(fadeOpacity(100, 100 + FADE_DURATION_MS), 1);
  assert.equal(fadeOpacity(100, 100 + FADE_DURATION_MS + 50), 1);
});

test('createFadeState skips fading for non-live, disabled, or huge initial blocks', () => {
  assert.deepEqual(createFadeState('Historical reply', false, 0).runs, []);
  assert.deepEqual(createFadeState('Split chunk', true, 0, false).runs, []);
  assert.deepEqual(createFadeState('a'.repeat(INITIAL_FADE_MAX_CHARS + 1), true, 0).runs, []);

  const live = createFadeState('Hello world', true, 100);
  assert.equal(live.runs.length, 2);
  assert.equal(live.runs[0].bornAt, 100);
  assert.ok(live.runs[1].bornAt > 100);
});

test('advanceFadeState appends new words without disturbing earlier runs', () => {
  let state = createFadeState('Hello ', true, 100);
  assert.equal(state.runs.length, 1);

  state = advanceFadeState(state, 'Hello world again', true, 140);
  assert.equal(state.runs.length, 3);
  assert.equal(state.runs[0].start, 0);
  assert.equal(state.runs[0].end, 6);
  assert.equal(state.runs[0].bornAt, 100);
  assert.equal(state.runs[1].start, 6);
  assert.ok(state.runs[1].bornAt >= 140);
  assert.ok(state.runs[2].bornAt > state.runs[1].bornAt);
});

test('advanceFadeState preserves fade progress when markdown syntax closes', () => {
  // Bold closing: "The **quick" -> "The quick fox"
  let state = createFadeState('The ', true, 0);
  state = advanceFadeState(state, 'The **quick', true, 40);
  const boldRuns = state.runs.filter((r) => r.start >= 4);
  assert.ok(boldRuns.length >= 1);

  const closed = advanceFadeState(state, 'The quick fox', true, 80);
  // "quick" shifted left by 2 chars from [6, 11) to [4, 9) and keeps its original bornAt (< 80)
  const carried = closed.runs.filter((r) => r.start >= 4 && r.end <= 9);
  assert.ok(carried.length >= 1, 'expected carried runs for "quick"');
  assert.equal(carried[0].start, 4);
  assert.equal(carried[carried.length - 1].end, 9);
  assert.ok(carried.every((r) => r.bornAt < 80));
  // Only " fox" is newly scheduled at >= 80
  const added = closed.runs.find((r) => r.start >= 9);
  assert.ok(added);
  assert.ok(added.bornAt >= 80);

  // Link closing: "See [React](https://react" -> "See React now"
  const linkState = createFadeState('See [React](https://react', true, 0);
  const linkClosed = advanceFadeState(linkState, 'See React now', true, 120);
  const carriedLink = linkClosed.runs.filter((r) => r.start >= 4 && r.end <= 9);
  assert.ok(carriedLink.length >= 1);
  assert.equal(carriedLink[0].start, 4);
  assert.equal(carriedLink[carriedLink.length - 1].end, 9);
  assert.ok(carriedLink.every((r) => r.bornAt < 120));
});

test('live true -> false lets active runs finish without adding new fades', () => {
  let state = createFadeState('Hello world', true, 100);
  const settled = advanceFadeState(state, 'Hello world!', false, 150);
  assert.equal(settled.live, false);
  // Existing runs still present to finish fading smoothly, no new run for "!"
  assert.equal(settled.runs.length, 2);
  assert.equal(fadeEndTime(settled.runs), settled.runs[1].bornAt + FADE_DURATION_MS);

  const pruned = pruneFadeState(settled, fadeEndTime(settled.runs));
  assert.deepEqual(pruned.runs, []);
});

test('resuming a settled block (live false -> true) only fades newly appended text', () => {
  let state = createFadeState('', false, 0);
  state = advanceFadeState(state, 'Existing text', true, 100);
  assert.deepEqual(state.runs, []);
  assert.equal(state.text, 'Existing text');

  state = advanceFadeState(state, 'Existing text continues', true, 140);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].start, 'Existing text '.length);
  assert.equal(state.runs[0].bornAt, 140);
});

test('rapid bursts keep monotonic order and bounded queue-ahead latency', () => {
  let state = createFadeState('', true, 0);
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `word${i}a word${i}b word${i}c word${i}d `;
    const now = i * 20;
    state = advanceFadeState(state, text, true, now);
    for (let j = 1; j < state.runs.length; j++) {
      assert.ok(state.runs[j].bornAt >= state.runs[j - 1].bornAt, 'runs must remain monotonic');
    }
    const last = state.runs[state.runs.length - 1];
    assert.ok(
      last.bornAt - now <= MAX_QUEUE_AHEAD_MS + MAX_BATCH_SPREAD_MS + 20,
      `queue ahead exceeded bound: ${last.bornAt - now}`
    );
  }
});

test('colorWithAlpha handles hex, short hex, rgb, and rgba colors', () => {
  assert.equal(colorWithAlpha('#0D0D0D', 0), 'rgba(13, 13, 13, 0)');
  assert.equal(colorWithAlpha('#ECECEC', 0.5), 'rgba(236, 236, 236, 0.5)');
  assert.equal(colorWithAlpha('#fff', 0.25), 'rgba(255, 255, 255, 0.25)');
  assert.equal(colorWithAlpha('rgba(10, 20, 30, 0.5)', 0.5), 'rgba(10, 20, 30, 0.25)');
  assert.equal(colorWithAlpha('rgb(10, 20, 30)', 1), 'rgba(10, 20, 30, 1)');
});
