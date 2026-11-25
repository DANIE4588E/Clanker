import {
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import {
  advanceFadeState,
  colorWithAlpha,
  createFadeState,
  fadeEndTime,
  fadeOpacity,
  monotonicNow,
  pruneFadeState,
  type FadeRun,
  type FadeState,
} from '@/lib/streamFade';

type WalkableProps = {
  children?: ReactNode;
  style?: StyleProp<TextStyle>;
  li?: ReactNode[];
  header?: ReactNode[][];
  rows?: ReactNode[][][];
};

type InheritedColors = {
  color: string;
  backgroundColor?: string;
};

/**
 * Extracts rendered text from a ReactNode tree in the exact traversal order used by
 * `applyFadeToNodes`, including `MDList` (`li`) and `MarkdownTable` (`header`/`rows`).
 */
export function extractNodeText(node: ReactNode): string {
  const parts: string[] = [];
  const walk = (n: ReactNode) => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') {
      parts.push(n);
      return;
    }
    if (typeof n === 'number') {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (isValidElement<WalkableProps>(n)) {
      const { props } = n;
      if (Array.isArray(props.li)) {
        for (const item of props.li) walk(item);
      } else if (Array.isArray(props.header) && Array.isArray(props.rows)) {
        for (const cell of props.header) walk(cell);
        for (const row of props.rows) {
          for (const cell of row) walk(cell);
        }
      } else if (props.children !== undefined) {
        walk(props.children);
      }
    }
  };
  walk(node);
  return parts.join('');
}

type Cursor = { offset: number; runIdx: number };

function spanFadeStyle(inherited: InheritedColors, opacity: number): TextStyle {
  const color = colorWithAlpha(inherited.color, opacity);
  if (inherited.backgroundColor) {
    return { color, backgroundColor: colorWithAlpha(inherited.backgroundColor, opacity) };
  }
  return { color };
}

function resolveTextColors(style: StyleProp<TextStyle>, inherited: InheritedColors): InheritedColors {
  if (!style) return inherited;
  const flat = StyleSheet.flatten(style);
  if (!flat) return inherited;
  const nextColor = typeof flat.color === 'string' ? flat.color : inherited.color;
  const nextBg = typeof flat.backgroundColor === 'string' ? flat.backgroundColor : inherited.backgroundColor;
  if (nextColor === inherited.color && nextBg === inherited.backgroundColor) return inherited;
  return { color: nextColor, backgroundColor: nextBg };
}

function fadeString(
  str: string,
  runs: FadeRun[],
  now: number,
  cursor: Cursor,
  inherited: InheritedColors
): ReactNode {
  const nodeStart = cursor.offset;
  const nodeEnd = nodeStart + str.length;
  cursor.offset = nodeEnd;

  while (cursor.runIdx < runs.length && runs[cursor.runIdx].end <= nodeStart) {
    cursor.runIdx++;
  }

  let idx = cursor.runIdx;
  if (idx >= runs.length || runs[idx].start >= nodeEnd) {
    return str;
  }

  const out: ReactNode[] = [];
  let pos = nodeStart;
  let hasFaded = false;
  let pendingOpacity = -1;
  let pendingStart = 0;
  let pendingText = '';

  const flushPending = () => {
    if (!pendingText) return;
    out.push(
      <Text key={`sf-${pendingStart}`} style={spanFadeStyle(inherited, pendingOpacity)}>
        {pendingText}
      </Text>
    );
    pendingOpacity = -1;
    pendingText = '';
  };

  const pushPlain = (piece: string) => {
    if (!piece) return;
    flushPending();
    const prev = out[out.length - 1];
    if (typeof prev === 'string') out[out.length - 1] = prev + piece;
    else out.push(piece);
  };

  const pushFaded = (piece: string, start: number, opacity: number) => {
    if (!piece) return;
    hasFaded = true;
    // Coalesce adjacent runs at the exact same opacity (especially the queued 0-opacity tail).
    if (pendingText && pendingOpacity === opacity) {
      pendingText += piece;
      return;
    }
    flushPending();
    pendingStart = start;
    pendingOpacity = opacity;
    pendingText = piece;
  };

  while (idx < runs.length && runs[idx].start < nodeEnd) {
    const run = runs[idx];
    if (run.start > pos) {
      pushPlain(str.slice(pos - nodeStart, run.start - nodeStart));
      pos = run.start;
    }
    const segEnd = Math.min(run.end, nodeEnd);
    if (segEnd > pos) {
      const piece = str.slice(pos - nodeStart, segEnd - nodeStart);
      const opacity = fadeOpacity(run.bornAt, now);
      if (opacity >= 1) pushPlain(piece);
      else pushFaded(piece, pos, opacity);
      pos = segEnd;
    }
    if (run.end <= nodeEnd) idx++;
    else break;
  }

  flushPending();
  if (pos < nodeEnd) {
    pushPlain(str.slice(pos - nodeStart));
  }

  cursor.runIdx = idx;
  if (!hasFaded) return str;
  return out.length === 1 ? out[0] : out;
}

function mapArray(
  items: ReactNode[],
  runs: FadeRun[],
  now: number,
  cursor: Cursor,
  inherited: InheritedColors
): ReactNode[] {
  let next: ReactNode[] | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const updated = walkFade(item, runs, now, cursor, inherited);
    if (updated !== item) {
      if (!next) next = items.slice(0, i);
      next.push(updated);
    } else if (next) {
      next.push(item);
    }
  }
  return next ?? items;
}

function mapCells(
  cells: ReactNode[][],
  runs: FadeRun[],
  now: number,
  cursor: Cursor,
  inherited: InheritedColors
): ReactNode[][] {
  let next: ReactNode[][] | null = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const updated = mapArray(cell, runs, now, cursor, inherited);
    if (updated !== cell) {
      if (!next) next = cells.slice(0, i);
      next.push(updated);
    } else if (next) {
      next.push(cell);
    }
  }
  return next ?? cells;
}

function mapRows(
  rows: ReactNode[][][],
  runs: FadeRun[],
  now: number,
  cursor: Cursor,
  inherited: InheritedColors
): ReactNode[][][] {
  let next: ReactNode[][][] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const updated = mapCells(row, runs, now, cursor, inherited);
    if (updated !== row) {
      if (!next) next = rows.slice(0, i);
      next.push(updated);
    } else if (next) {
      next.push(row);
    }
  }
  return next ?? rows;
}

function walkFade(
  node: ReactNode,
  runs: FadeRun[],
  now: number,
  cursor: Cursor,
  inherited: InheritedColors
): ReactNode {
  if (node == null || typeof node === 'boolean') return node;
  if (typeof node === 'string') return fadeString(node, runs, now, cursor, inherited);
  if (typeof node === 'number') {
    const str = String(node);
    const faded = fadeString(str, runs, now, cursor, inherited);
    return faded === str ? node : faded;
  }
  if (Array.isArray(node)) return mapArray(node, runs, now, cursor, inherited);
  if (isValidElement<WalkableProps>(node)) {
    const { props } = node;
    if (Array.isArray(props.li)) {
      const nextLi = mapArray(props.li, runs, now, cursor, inherited);
      return nextLi === props.li ? node : cloneElement(node as ReactElement<WalkableProps>, { li: nextLi });
    }
    if (Array.isArray(props.header) && Array.isArray(props.rows)) {
      const nextHeader = mapCells(props.header, runs, now, cursor, inherited);
      const nextRows = mapRows(props.rows, runs, now, cursor, inherited);
      return nextHeader === props.header && nextRows === props.rows
        ? node
        : cloneElement(node as ReactElement<WalkableProps>, { header: nextHeader, rows: nextRows });
    }
    if (props.children !== undefined) {
      // Only inherit text color/background from <Text> ancestors (never from container <View>s).
      const nextInherited = node.type === Text ? resolveTextColors(props.style, inherited) : inherited;
      const nextChildren = walkFade(props.children, runs, now, cursor, nextInherited);
      return nextChildren === props.children
        ? node
        : cloneElement(node as ReactElement<WalkableProps>, undefined, nextChildren);
    }
  }
  return node;
}

/**
 * Decorates only the leaf text slices covered by active `runs` with inline `<Text>` spans whose
 * foreground (and inline background, when set) alpha fades from 0 to 1. Unchanged subtrees keep
 * their exact element references.
 */
export function applyFadeToNodes<T extends ReactNode>(
  node: T,
  runs: FadeRun[],
  now: number,
  baseColor: string
): T {
  if (!runs.length) return node;
  return walkFade(node, runs, now, { offset: 0, runIdx: 0 }, { color: baseColor }) as T;
}

const EMPTY_RUNS: FadeRun[] = [];

type StreamFadeOptions = {
  /** Whether text already present on mount should fade in when mounted live (default true). */
  fadeInitial?: boolean;
};

/**
 * Tracks arrival times of streamed text units and ticks a single vsync-aligned rAF loop only
 * while newly arrived units are still fading in. Zero work for historical (non-live) messages.
 */
export function useStreamFade(
  text: string,
  live: boolean,
  options?: StreamFadeOptions
): { runs: FadeRun[]; now: number } {
  const reduceMotion = useReducedMotion();
  const fadeInitial = options?.fadeInitial ?? true;

  const [state, setState] = useState<FadeState>(() =>
    reduceMotion || !live
      ? { text: live ? text : '', runs: [], live }
      : createFadeState(text, true, monotonicNow(), fadeInitial)
  );
  const [now, setNow] = useState<number>(monotonicNow);

  const tracking = !reduceMotion && (live || state.live || state.runs.length > 0);

  if (tracking && (text !== state.text || live !== state.live)) {
    const t = monotonicNow();
    const next = advanceFadeState(state, text, live, t);
    if (next !== state) {
      setState(next);
      setNow(t);
    }
  }

  const endAt = !reduceMotion && state.runs.length > 0 ? fadeEndTime(state.runs) : 0;
  const endAtRef = useRef(endAt);
  useEffect(() => {
    endAtRef.current = endAt;
  }, [endAt]);

  const animating = endAt > 0;
  useEffect(() => {
    if (!animating) return;
    let rafId = 0;
    const step = () => {
      const t = monotonicNow();
      if (t >= endAtRef.current) {
        setState((s) => pruneFadeState(s, t));
      }
      setNow(t);
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [animating]);

  if (reduceMotion || !state.runs.length) {
    return { runs: EMPTY_RUNS, now: 0 };
  }
  return { runs: state.runs, now };
}

/** Fades newly streamed text within a ReactNode tree (e.g. rendered Markdown blocks or code). */
export function useFadeNodes<T extends ReactNode>(
  nodes: T,
  live: boolean,
  color: string,
  options?: StreamFadeOptions & { text?: string }
): T {
  const reduceMotion = useReducedMotion();
  const [engaged, setEngaged] = useState(live);
  if (live && !engaged) setEngaged(true);

  const shouldTrack = !reduceMotion && (live || engaged);
  const extracted = useMemo(
    () => (shouldTrack && options?.text === undefined ? extractNodeText(nodes) : ''),
    [shouldTrack, options?.text, nodes]
  );
  const text = shouldTrack ? (options?.text ?? extracted) : '';
  const { runs, now } = useStreamFade(text, shouldTrack && live, options);

  if (!runs.length) return nodes;
  return applyFadeToNodes(nodes, runs, now, color);
}

/** Fades newly streamed text inside a `<Text>` element. */
export function useFadeText(
  text: string,
  live: boolean,
  color: string,
  options?: StreamFadeOptions
): ReactNode {
  const { runs, now } = useStreamFade(text, live, options);
  if (!runs.length) return text;
  return fadeString(text, runs, now, { offset: 0, runIdx: 0 }, { color });
}
