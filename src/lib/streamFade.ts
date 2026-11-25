/** Duration (ms) for each newly streamed text unit to fade from transparent to opaque. */
export const FADE_DURATION_MS = 360;

/** Default stagger (ms) between consecutive text units (both within and across bursts). */
export const STAGGER_MS = 20;

/** Cap on how far a single burst of tokens is spread out, so fast/polled streams never lag. */
export const MAX_BATCH_SPREAD_MS = 300;

/** Cap on how far ahead of wall time consecutive bursts may queue. */
export const MAX_QUEUE_AHEAD_MS = 220;

/**
 * Maximum initial length to fade on mount when a block starts live. Larger initial blocks (such
 * as opening an already-streaming chat mid-paragraph) mount settled instead of flashing blank.
 */
export const INITIAL_FADE_MAX_CHARS = 240;

export type FadeRun = {
  /** Inclusive character offset in the rendered text. */
  start: number;
  /** Exclusive character offset in the rendered text. */
  end: number;
  /** Monotonic timestamp (ms) when this run starts fading in. */
  bornAt: number;
};

export type FadeState = {
  /** The rendered text that `runs` offsets refer to. */
  text: string;
  /** Active (not yet fully opaque) runs, ordered by `start` and non-overlapping. */
  runs: FadeRun[];
  /** Whether the source was live on the previous update. */
  live: boolean;
};

export type TextUnit = {
  start: number;
  end: number;
  visible: boolean;
};

// Splits on word boundaries (capped at 16 code points for long URLs/identifiers) and single CJK
// characters so spans never break intra-word kerning or ligatures while fading.
const UNIT_RE =
  /(?:[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]|[^\s\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]{1,16})\s*|\s+/gu;

// Markdown syntax openers that disappear from rendered text once their closing delimiter arrives.
const SYNTAX_OPENER_RE = /^(?:\d{1,9}[.)]\s+|[*_`~\[#>-]+\s*)/;

export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Smooth S-curve (cubic smoothstep) opacity in `[0, 1]` with zero abrupt pop at start or end. */
export function fadeOpacity(bornAt: number, now: number): number {
  const elapsed = now - bornAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= FADE_DURATION_MS) return 1;
  const t = elapsed / FADE_DURATION_MS;
  const eased = t * t * (3 - 2 * t);
  return Math.round(eased * 1000) / 1000;
}

/** Splits `text` losslessly into small word / CJK units for sequential fade-in. */
export function splitFadeUnits(text: string): TextUnit[] {
  if (!text) return [];
  const units: TextUnit[] = [];
  for (const match of text.matchAll(UNIT_RE)) {
    const value = match[0];
    const start = match.index ?? 0;
    units.push({ start, end: start + value.length, visible: /\S/.test(value) });
  }
  return units;
}

function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * When markdown syntax closes (e.g. `**bold` → `bold`, `` `code `` → `code`, `[a](b` → `a`),
 * leading opener characters vanish from the rendered text. Detect the shifted match so text that
 * was already visible keeps its fade progress instead of blinking back to opacity 0.
 */
function alignSyntaxClosure(prev: string, next: string, common: number): { skip: number; matched: number } {
  if (common >= prev.length || common >= next.length) return { skip: 0, matched: 0 };
  const prevTail = prev.slice(common);
  const opener = prevTail.match(SYNTAX_OPENER_RE)?.[0];
  if (!opener) return { skip: 0, matched: 0 };
  const skip = opener.length;
  const matched = commonPrefixLength(prevTail.slice(skip), next.slice(common));
  return matched > 0 ? { skip, matched } : { skip: 0, matched: 0 };
}

function scheduleUnits(delta: string, offset: number, baseTime: number): FadeRun[] {
  const visible = splitFadeUnits(delta).filter((u) => u.visible);
  if (!visible.length) return [];
  const step = visible.length > 1 ? Math.min(STAGGER_MS, MAX_BATCH_SPREAD_MS / (visible.length - 1)) : 0;
  return visible.map((u, i) => ({
    start: offset + u.start,
    end: offset + u.end,
    bornAt: baseTime + i * step,
  }));
}

/** Compresses future-queued runs if bursts pile up beyond `MAX_QUEUE_AHEAD_MS`, preserving order. */
function compressQueue(runs: FadeRun[], now: number): FadeRun[] {
  const last = runs[runs.length - 1];
  if (!last || last.bornAt - now <= MAX_QUEUE_AHEAD_MS) return runs;
  const targetAhead = MAX_QUEUE_AHEAD_MS * 0.7;
  const span = last.bornAt - now;
  const scale = targetAhead / span;
  return runs.map((r) => (r.bornAt > now ? { ...r, bornAt: now + (r.bornAt - now) * scale } : r));
}

export function createFadeState(text: string, live: boolean, now: number, fadeInitial = true): FadeState {
  if (!live || !fadeInitial || !text || text.length > INITIAL_FADE_MAX_CHARS) {
    return { text, runs: [], live };
  }
  return { text, runs: scheduleUnits(text, 0, now), live };
}

export function pruneFadeState(state: FadeState, now: number): FadeState {
  if (!state.runs.length) return state;
  const runs = state.runs.filter((r) => now - r.bornAt < FADE_DURATION_MS);
  if (runs.length === state.runs.length) return state;
  return { ...state, runs };
}

export function advanceFadeState(prev: FadeState, text: string, live: boolean, now: number): FadeState {
  const active = prev.runs.filter((r) => now - r.bornAt < FADE_DURATION_MS);

  if (text === prev.text) {
    if (live === prev.live && active.length === prev.runs.length) return prev;
    return { text, runs: active, live };
  }

  const common = commonPrefixLength(prev.text, text);
  const { skip, matched } = alignSyntaxClosure(prev.text, text, common);
  const aligned = common + matched;

  // Carry forward active runs in the unchanged prefix, plus any shifted by syntax closure.
  const carried: FadeRun[] = [];
  for (const r of active) {
    if (r.start < common) {
      const end = Math.min(r.end, common);
      if (end > r.start) carried.push(end === r.end ? r : { ...r, end });
    }
    if (matched > 0) {
      const shiftStart = common + skip;
      const shiftEnd = shiftStart + matched;
      const s = Math.max(r.start, shiftStart);
      const e = Math.min(r.end, shiftEnd);
      if (e > s) {
        carried.push({ start: s - skip, end: e - skip, bornAt: r.bornAt });
      }
    }
  }

  // Once streaming stops, let existing fades finish without introducing new fades.
  if (!live) {
    return { text, runs: carried, live: false };
  }

  // If resuming a previously settled block, treat the prior text as already visible.
  const deltaStart = !prev.live && prev.text.length === 0 ? text.length : aligned;
  const delta = text.slice(deltaStart);
  if (!delta) {
    return { text, runs: carried, live: true };
  }

  const bounded = compressQueue(carried, now);
  const lastBorn = bounded.length ? bounded[bounded.length - 1].bornAt : -Infinity;
  const baseTime = Math.max(now, lastBorn + STAGGER_MS);
  const added = scheduleUnits(delta, deltaStart, baseTime);
  const runs = added.length ? [...bounded, ...added] : bounded;

  return { text, runs, live: true };
}

/** Timestamp (ms) at which all runs in `runs` will have reached full opacity, or 0 if none. */
export function fadeEndTime(runs: FadeRun[]): number {
  let max = 0;
  for (const r of runs) {
    if (r.bornAt > max) max = r.bornAt;
  }
  return max > 0 ? max + FADE_DURATION_MS : 0;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];
const parsedColorCache = new Map<string, Rgba | null>();

function parseCssColor(color: string): Rgba | null {
  const cached = parsedColorCache.get(color);
  if (cached !== undefined) return cached;
  const s = color.trim();
  let parsed: Rgba | null = null;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      if (!Number.isNaN(r + g + b + a)) parsed = [r, g, b, a];
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (!Number.isNaN(r + g + b + a)) parsed = [r, g, b, a];
    }
  } else {
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (m) {
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      const a = m[4] !== undefined ? Number(m[4]) : 1;
      if (!Number.isNaN(r + g + b + a)) parsed = [r, g, b, a];
    }
  }
  if (parsedColorCache.size >= 128) parsedColorCache.clear();
  parsedColorCache.set(color, parsed);
  return parsed;
}

/**
 * Multiplies a CSS color's alpha by `opacity` and returns an `rgba(...)` string.
 * On Android Fabric, nested `<Text style={{ opacity }}>` has its `ReactOpacitySpan` overwritten
 * by `ReactForegroundColorSpan` due to reverse span priority, whereas explicit `rgba(...)` color
 * sets the span's ARGB color directly on both Android and iOS.
 */
export function colorWithAlpha(color: string, opacity: number): string {
  const rgba = parseCssColor(color);
  if (!rgba) return color;
  const a = Math.round(Math.max(0, Math.min(1, rgba[3] * opacity)) * 1000) / 1000;
  return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${a})`;
}
