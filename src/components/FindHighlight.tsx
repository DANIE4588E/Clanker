import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Text, type TextStyle } from 'react-native';
import { useTheme } from '@/lib/theme';

/** What find in chat is looking for, given to each message: null when not finding. */
export type FindTarget = { needle: string; current: boolean } | null;

export const FindContext = createContext<FindTarget>(null);

/** Marks every match of `needle` in a string; one without matches comes back as it was. */
export type Marker = (text: string) => string | ReactNode[];

/** Where the matches are in a text, as [start, end) offsets in order. */
export type MatchRange = [number, number];

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every match of `needle` in `text`, ignoring case. */
export function matchRanges(text: string, needle: string): MatchRange[] {
  if (!needle) return [];
  const out: MatchRange[] = [];
  for (const m of text.matchAll(new RegExp(escape(needle), 'gi'))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * `value`, a piece of a longer text starting at `offset` in it, with the parts inside `ranges`
 * (offsets in the longer text) wrapped in marked text. A match running across pieces, such as
 * the differently colored tokens of highlighted code, is marked piece by piece.
 */
export function markRanges(value: string, offset: number, ranges: MatchRange[], style: TextStyle, key = ''): string | ReactNode[] {
  const end = offset + value.length;
  const out: ReactNode[] = [];
  let at = offset;
  for (const [start, stop] of ranges) {
    if (stop <= at) continue;
    if (start >= end) break;
    const from = Math.max(start, at);
    const to = Math.min(stop, end);
    if (from > at) out.push(value.slice(at - offset, from - offset));
    out.push(
      <Text key={`${key}find-${from}`} style={style}>
        {value.slice(from - offset, to - offset)}
      </Text>
    );
    at = to;
  }
  if (!out.length) return value;
  if (at < end) out.push(value.slice(at - offset));
  return out;
}

export function markerFor(needle: string, style: TextStyle): Marker {
  return (text) => markRanges(text, 0, matchRanges(text, needle), style);
}

/**
 * What to mark in the message this is rendered in, and how, or null while not finding. Matches
 * in the message being shown stand out more than those in the rest of the chat.
 */
export function useFindStyle(): { needle: string; style: TextStyle } | null {
  const find = useContext(FindContext);
  const { colors } = useTheme();
  const needle = find?.needle;
  const current = !!find?.current;
  return useMemo(
    () =>
      needle
        ? {
            needle,
            style: current
              ? { backgroundColor: colors.findCurrent, color: colors.findCurrentText }
              : { backgroundColor: colors.findMatch },
          }
        : null,
    [needle, current, colors]
  );
}

/** A marker for the message this is rendered in, or null while not finding. */
export function useFindMarker(): Marker | null {
  const find = useFindStyle();
  return useMemo(() => (find ? markerFor(find.needle, find.style) : null), [find]);
}
