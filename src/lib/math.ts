import type { LiteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor';
import type { MathDocument } from 'mathjax-full/js/core/MathDocument';

/** A typeset formula: SVG markup drawn in currentColor, with its size in em. */
export type MathSvg = {
  xml: string;
  width: number;
  height: number;
  /** How far the formula reaches below the text baseline. */
  depth: number;
};

let jax: { adaptor: LiteAdaptor; doc: MathDocument<any, any, any> } | null = null;

// MathJax is a large module set, so it loads the first time a reply has math rather than at launch.
/* eslint-disable @typescript-eslint/no-require-imports */
function load() {
  if (jax) return jax;
  // MathJax reads its version from this global, which its own bundles define; without it, it
  // falls back to eval('require') to read package.json, which only exists in Node and crashed the app.
  // A module that throws while loading is fatal in React Native, so a try/catch around it can't help.
  (globalThis as { PACKAGE_VERSION?: string }).PACKAGE_VERSION ??= require('mathjax-full/package.json').version;
  const { mathjax } = require('mathjax-full/js/mathjax') as typeof import('mathjax-full/js/mathjax');
  const { TeX } = require('mathjax-full/js/input/tex') as typeof import('mathjax-full/js/input/tex');
  const { SVG } = require('mathjax-full/js/output/svg') as typeof import('mathjax-full/js/output/svg');
  const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor') as typeof import('mathjax-full/js/adaptors/liteAdaptor');
  const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html') as typeof import('mathjax-full/js/handlers/html');
  const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages') as typeof import('mathjax-full/js/input/tex/AllPackages');
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  // Without a font cache every glyph is a path of its own, so each formula's SVG stands alone.
  const doc = mathjax.document('', { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: 'none' }) });
  jax = { adaptor, doc };
  return jax;
}
/* eslint-enable @typescript-eslint/no-require-imports */

const cache = new Map<string, MathSvg | null>();
const CACHE_MAX = 300;

/** Typesets TeX, or null when it can't be drawn. Results are cached, since streaming re-renders replies. */
export function texToSvg(tex: string, display: boolean): MathSvg | null {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out: MathSvg | null = null;
  try {
    const { adaptor, doc } = load();
    const markup = adaptor.innerHTML(doc.convert(tex, { display }) as any);
    // The viewBox is in thousandths of an em; MathJax gives the depth in ex, against a height in ex.
    const box = markup.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
    const heightEx = parseFloat(markup.match(/height="([\d.]+)ex"/)?.[1] ?? '');
    const alignEx = parseFloat(markup.match(/vertical-align: ([-\d.]+)ex/)?.[1] ?? '0');
    if (box) {
      const width = parseFloat(box[3]) / 1000;
      const height = parseFloat(box[4]) / 1000;
      out = {
        // Sized by the component instead; react-native-svg doesn't know ex units.
        xml: markup.replace(/ style="[^"]*"/, '').replace(/ width="[^"]*"/, '').replace(/ height="[^"]*"/, ''),
        width,
        height,
        depth: heightEx > 0 ? (-alignEx / heightEx) * height : 0,
      };
    }
  } catch {
    // Leave it to the caller to show the source instead.
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

/** Prefixes TeX handed to the markdown parser as inline code, so the renderer draws it as math. */
export const INLINE_MATH = '';
/** The fence language of display math lifted out of the text, and of display math still streaming. */
export const MATH_LANG = 'math';
export const PENDING_MATH_LANG = 'math-pending';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Fence for TeX moved into a block of its own, indented to stay in the list item or quote it was in. */
function displayBlock(tex: string, line: string, lang = MATH_LANG) {
  const quote = line.match(/^(?:\s*>)+\s?/)?.[0] ?? '';
  const rest = line.slice(quote.length);
  const item = rest.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
  const indent = quote + (item ? ' '.repeat(item[0].length) : (rest.match(/^\s*/)?.[0] ?? ''));
  const body = tex
    .trim()
    .split('\n')
    .map((l) => indent + l)
    .join('\n');
  return `\n${indent}\`\`\`${lang}\n${body}\n${indent}\`\`\`\n${indent}`;
}

function inlineCode(tex: string) {
  const runs = tex.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  // Padded with a space each side, which the parser strips, so TeX that starts or ends in a backtick survives.
  return `${fence} ${INLINE_MATH}${tex.replace(/\n/g, ' ')} ${fence}`;
}

/** The line of `text` that `at` falls in, up to `at`. */
const lineBefore = (text: string, at: number) => text.slice(text.lastIndexOf('\n', at - 1) + 1, at);

/** A $ closing inline math: TeX right before it, and no digit after it, so "$5 and $10" stays text. */
function closingDollar(text: string, from: number) {
  for (let i = from; i < text.length && text[i] !== '\n'; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$') return /\s/.test(text[i - 1]) || /\d/.test(text[i + 1] ?? '') ? -1 : i;
  }
  return -1;
}

/**
 * A place in a text, just before a line break, where it can be cut so that what comes before
 * prepares the same whatever follows: `raw` in the text, `out` in what it prepares to.
 */
type Cut = { raw: number; out: number };

/** Where the prose being rewritten starts, in the text and in the output, and the last cut found. */
type Tracker = { raw: number; out: number; cut: Cut | null };

/** Rewrites the math in a stretch of text outside code fences. */
function rewriteProse(text: string, live: boolean, track?: Tracker) {
  let out = '';
  let i = 0;
  // Something opened that doesn't close in the text. Text still to come may close it, past any
  // line break, so no line break after it is a cut.
  let open = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      // Inline code is copied as is, up to the matching run of backticks.
      let j = i + 1;
      while (text[j] === '`') j++;
      const run = text.slice(i, j);
      const end = text.indexOf(run, i + run.length);
      if (end < 0) open = true;
      const stop = end < 0 ? i + run.length : end + run.length;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    const display = text.startsWith('$$', i) ? '$$' : text.startsWith('\\[', i) ? '\\]' : null;
    if (display) {
      const end = text.indexOf(display, i + 2);
      if (end >= 0 && text.slice(i + 2, end).trim()) {
        out += displayBlock(text.slice(i + 2, end), lineBefore(text, i));
        i = end + 2;
        // The line after resumes as text of its own.
        while (text[i] === ' ') i++;
        continue;
      }
      if (end < 0 && live) {
        // Still streaming: a placeholder rather than raw TeX that turns into math a moment later.
        return out + displayBlock('', lineBefore(text, i), PENDING_MATH_LANG);
      }
      if (end < 0) open = true;
      // Not math after all; copied whole so the second $ doesn't open inline math.
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text.startsWith('\\(', i)) {
      const end = text.indexOf('\\)', i + 2);
      if (end >= 0 && text.slice(i + 2, end).trim()) {
        out += inlineCode(text.slice(i + 2, end).trim());
        i = end + 2;
        continue;
      }
      if (end < 0) open = true;
    }
    if (c === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '$' && text[i + 1] && !/\s/.test(text[i + 1])) {
      const end = closingDollar(text, i + 1);
      if (end >= 0) {
        out += inlineCode(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    if (track && c === '\n' && !open) track.cut = { raw: track.raw + i, out: track.out + out.length };
    out += c;
    i++;
  }
  return out;
}

/**
 * Turns the TeX in markdown into what the chat renderer draws as math: display math ($$…$$ and
 * \[…\]) into fenced blocks and inline math ($…$ and \(…\)) into marked inline code. Code is left
 * alone. While `live`, display math that hasn't closed yet becomes a placeholder.
 */
export function prepareMath(markdown: string, live: boolean) {
  return prepare(markdown, live).out;
}

/** prepareMath, with the last cut in the text (see Cut). */
function prepare(markdown: string, live: boolean): { out: string; cut: Cut | null } {
  // Text without math prepares to itself (rewriting would only copy it); its cuts aren't looked for.
  if (!/\$|\\\(|\\\[/.test(markdown)) return { out: markdown, cut: null };
  const lines = markdown.split('\n');
  let out = '';
  let prose: string[] = [];
  let proseAt = 0;
  let fence: string | null = null;
  const track: Tracker = { raw: 0, out: 0, cut: null };
  const flush = () => {
    if (prose.length) {
      track.raw = proseAt;
      track.out = out.length;
      out += rewriteProse(prose.join('\n'), live, track) + '\n';
    }
    prose = [];
  };
  let at = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const open = line.match(FENCE)?.[1];
    if (fence) {
      out += line + '\n';
      if (open && open[0] === fence[0] && open.length >= fence.length && !line.trim().slice(open.length).trim()) {
        fence = null;
        // Prose can't reach past a fence, so what follows a closed one starts afresh.
        if (k < lines.length - 1) track.cut = { raw: at + line.length, out: out.length - 1 };
      }
    } else if (open) {
      flush();
      fence = open;
      out += line + '\n';
    } else {
      if (!prose.length) proseAt = at;
      prose.push(line);
    }
    at += line.length + 1;
  }
  flush();
  return { out: out.slice(0, -1), cut: track.cut };
}

/** A text prepared by prepareMathFrom, to pick up from as it grows. */
export type PreparedMath = { raw: string; live: boolean; out: string; cut: Cut | null; head: string };

/**
 * prepareMath(markdown, live), as `out`, for text that streams in. Given what the text so far
 * prepared to, only the text after its last cut is prepared again: before a cut the output is
 * final, and after it the text prepares as if it stood alone, so the two join to the same.
 */
export function prepareMathFrom(markdown: string, live: boolean, prev: PreparedMath | null): PreparedMath {
  if (prev && prev.raw === markdown && prev.live === live) return prev;
  if (prev?.cut && prev.live === live && markdown.startsWith(prev.raw)) {
    const base = prev.cut;
    const rest = prepare(markdown.slice(base.raw + 1), live);
    const out = `${prev.head}\n${rest.out}`;
    const cut = rest.cut ? { raw: base.raw + 1 + rest.cut.raw, out: base.out + 1 + rest.cut.out } : base;
    return { raw: markdown, live, out, cut, head: rest.cut ? out.slice(0, cut.out) : prev.head };
  }
  const { out, cut } = prepare(markdown, live);
  return { raw: markdown, live, out, cut, head: cut ? out.slice(0, cut.out) : '' };
}
