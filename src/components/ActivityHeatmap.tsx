import Feather from '@expo/vector-icons/Feather';
import { memo, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import * as Haptics from '@/lib/haptics';
import { addDays, compactTokens, startOfDay } from '@/lib/activity';
import { useTheme } from '@/lib/theme';

const GAP = 3;
const LEVELS = 5;
/** Room on the left for the weekday labels. */
const GUTTER = 28;
const MONTH_ROW = 18;

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * One blue, light to dark on light; dim to bright on dark, so the busiest days are the
 * loudest cells in both. Empty days sit one step off the page.
 */
export const HEAT = {
  light: { empty: '#EEEEEE', levels: ['#B6D5F8', '#6AABF1', '#257DE0', '#1B64BE', '#0E3D7E'] },
  dark: { empty: '#1E1E1E', levels: ['#123A6B', '#1757AC', '#2370CD', '#519CED', '#9DC8F7'] },
};

export function dayLabel(day: number, weekday = true) {
  const d = new Date(day);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return weekday ? `${WEEKDAYS[d.getDay()]}, ${date}` : date;
}

type Props = {
  /** Tokens per local-midnight day. */
  days: Map<number, number>;
  title?: string;
  /** Weeks to show, ending with this one. */
  weeks?: number;
  /**
   * Smallest cell size. Cells grow to fill the width (up to half again this size); when even
   * this size doesn't fit, the grid scrolls sideways, opening on the latest week.
   */
  cell?: number;
  /** Shows the total over the weeks shown under the grid. */
  caption?: boolean;
  /** Makes the whole card a button; otherwise each day can be tapped for its numbers. */
  onPress?: () => void;
};

type Cell = { col: number; row: number; day: number; tokens: number };

/** A week-per-column calendar of daily token use, ending today, Sunday on top. */
export const ActivityHeatmap = memo(function ActivityHeatmap({
  days,
  title = 'Activity',
  weeks = 53,
  cell = 12,
  caption,
  onPress,
}: Props) {
  const { scheme, colors } = useTheme();
  const heat = HEAT[scheme];
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<Cell | null>(null);
  const scroller = useRef<ScrollViewInstance>(null);

  const room = Math.max(0, width - GUTTER);
  // Whole weeks that fit at the smallest size: when that's all of them, cells grow to fill the
  // width; otherwise they're sized so the view opens on whole weeks, not a sliced first column.
  const visible = Math.max(1, Math.floor((room + GAP) / (cell + GAP)));
  const fit = (room - GAP * (Math.min(visible, weeks) - 1)) / Math.min(visible, weeks);
  const size = visible >= weeks ? Math.min(fit, cell * 1.5) : fit;
  const gridWidth = weeks * size + (weeks - 1) * GAP;
  const gridHeight = 7 * size + 6 * GAP;
  const scrolls = gridWidth > room + 0.5;

  const grid = useMemo(() => layout(days, weeks), [days, weeks]);

  const colorOf = (tokens: number) => {
    if (!tokens || !grid.max) return heat.empty;
    // Square root, so a few heavy days don't wash every other day out to the lowest shade.
    const level = Math.min(LEVELS, Math.max(1, Math.ceil(LEVELS * Math.sqrt(tokens / grid.max))));
    return heat.levels[level - 1];
  };

  const pick = (x: number, y: number) => {
    const col = Math.floor(x / (size + GAP));
    const row = Math.floor(y / (size + GAP));
    const hit = grid.cells.find((c) => c.col === col && c.row === row);
    if (!hit) return;
    Haptics.selectionAsync();
    setSelected((s) => (s?.day === hit.day ? null : hit));
  };

  const radius = Math.min(3, size / 4);
  const svg = (
    <Svg width={gridWidth} height={gridHeight}>
      {grid.cells.map((c) => (
        <Rect
          key={c.day}
          x={c.col * (size + GAP)}
          y={c.row * (size + GAP)}
          width={size}
          height={size}
          rx={radius}
          fill={colorOf(c.tokens)}
        />
      ))}
      {selected && (
        <Rect
          x={selected.col * (size + GAP) + 0.75}
          y={selected.row * (size + GAP) + 0.75}
          width={size - 1.5}
          height={size - 1.5}
          rx={Math.max(0, radius - 0.75)}
          fill="none"
          stroke={colors.text}
          strokeWidth={1.5}
        />
      )}
    </Svg>
  );

  const calendar = (
    <View style={{ width: gridWidth }}>
      <View style={{ height: MONTH_ROW }}>
        {grid.months.map((m) => (
          <Text
            key={m.col}
            numberOfLines={1}
            style={[styles.axis, styles.month, { left: m.col * (size + GAP), color: colors.textTertiary }]}
          >
            {m.label}
          </Text>
        ))}
      </View>
      {onPress ? (
        svg
      ) : (
        <Pressable onPress={(e) => pick(e.nativeEvent.locationX, e.nativeEvent.locationY)} accessible={false}>
          {svg}
        </Pressable>
      )}
    </View>
  );

  const summary = grid.total
    ? `${compactTokens(grid.total)} tokens · ${grid.active} active ${grid.active === 1 ? 'day' : 'days'}`
    : 'No activity yet';
  const footer = selected
    ? `${dayLabel(selected.day)} · ${selected.tokens ? `${selected.tokens.toLocaleString('en-US')} tokens` : 'No activity'}`
    : caption || !onPress
      ? summary
      : '';

  const body = (
    <>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          {onPress && <Feather name="chevron-right" size={18} color={colors.textTertiary} />}
        </View>
        {!onPress && grid.total > 0 && (
          <View style={styles.streaks}>
            <Streak label="Current streak" value={grid.streak} />
            <Streak label="Longest" value={grid.longest} />
          </View>
        )}
      </View>

      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[styles.body, { height: MONTH_ROW + gridHeight }]}
        accessible
        accessibilityLabel={`${title}: ${summary} over the last ${weeks} weeks`}
      >
        {width > 0 && (
          <>
            <View style={{ width: GUTTER, paddingTop: MONTH_ROW }}>
              {[1, 3, 5].map((row) => (
                <Text
                  key={row}
                  style={[styles.axis, styles.weekday, { top: MONTH_ROW + row * (size + GAP) + size / 2 - 7, color: colors.textTertiary }]}
                >
                  {WEEKDAYS[row]}
                </Text>
              ))}
            </View>
            {scrolls ? (
              <ScrollView
                ref={scroller}
                horizontal
                showsHorizontalScrollIndicator={false}
                onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
                style={styles.grow}
              >
                {calendar}
              </ScrollView>
            ) : (
              <View style={[styles.grow, styles.center]}>{calendar}</View>
            )}
          </>
        )}
      </View>

      <View style={styles.footer}>
        <Text numberOfLines={1} style={[styles.caption, { color: selected ? colors.text : colors.textSecondary }]}>
          {footer}
        </Text>
        <View style={styles.legend}>
          <Text style={[styles.legendText, { color: colors.textTertiary }]}>Less</Text>
          {[heat.empty, ...heat.levels].map((c) => (
            <View key={c} style={[styles.swatch, { backgroundColor: c }]} />
          ))}
          <Text style={[styles.legendText, { color: colors.textTertiary }]}>More</Text>
        </View>
      </View>
    </>
  );

  if (!onPress) return <View style={styles.container}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${summary}. Opens usage`}
      style={({ pressed }) => [styles.container, pressed && { opacity: 0.6 }]}
    >
      {body}
    </Pressable>
  );
});

/** The calendar's cells, month labels and totals for `weeks` weeks ending this one. */
function layout(days: Map<number, number>, weeks: number) {
  const today = startOfDay(Date.now());
  // The last column is this week; the first starts on the Sunday `weeks - 1` weeks before it.
  const first = addDays(today, -new Date(today).getDay() - 7 * (weeks - 1));
  const cells: Cell[] = [];
  const months: { col: number; label: string }[] = [];
  let max = 0;
  let total = 0;
  let active = 0;
  let run = 0;
  let longest = 0;
  for (let col = 0; col < weeks; col++) {
    const sunday = addDays(first, col * 7);
    const month = new Date(sunday).getMonth();
    if (col === 0 || month !== new Date(addDays(sunday, -7)).getMonth()) months.push({ col, label: MONTHS[month] });
    for (let row = 0; row < 7; row++) {
      const day = addDays(first, col * 7 + row);
      if (day > today) break;
      const tokens = days.get(day) ?? 0;
      max = Math.max(max, tokens);
      total += tokens;
      if (tokens) active++;
      run = tokens ? run + 1 : 0;
      longest = Math.max(longest, run);
      cells.push({ col, row, day, tokens });
    }
  }
  // A label crowding the next one (the partial first month, usually) is dropped.
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();
  // Today without use yet doesn't break the streak; it just hasn't added to it.
  const streak = run || (cells.length > 1 && !cells[cells.length - 1].tokens ? countBack(cells, cells.length - 2) : 0);
  return { cells, months, max, total, active, longest, streak };
}

function countBack(cells: Cell[], from: number) {
  let n = 0;
  for (let i = from; i >= 0 && cells[i].tokens; i--) n++;
  return n;
}

function Streak({ label, value }: { label: string; value: number }) {
  const { colors } = useTheme();
  return (
    <View style={styles.streak}>
      <Text style={[styles.streakValue, { color: colors.text }]}>
        {value}
        <Text style={[styles.streakUnit, { color: colors.textTertiary }]}>{value === 1 ? ' day' : ' days'}</Text>
      </Text>
      <Text style={[styles.streakLabel, { color: colors.textTertiary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  title: { fontSize: 17, fontWeight: '600' },
  streaks: { flexDirection: 'row', gap: 18 },
  streak: { alignItems: 'flex-end' },
  streakValue: { fontSize: 15, fontWeight: '600' },
  streakUnit: { fontSize: 12, fontWeight: '400' },
  streakLabel: { fontSize: 11, marginTop: 1 },
  body: { flexDirection: 'row' },
  grow: { flex: 1 },
  center: { alignItems: 'center' },
  axis: { position: 'absolute', fontSize: 10 },
  month: { top: 0 },
  weekday: { left: 0 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  caption: { fontSize: 13, flexShrink: 1, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  legendText: { fontSize: 11, marginHorizontal: 3 },
  swatch: { width: 10, height: 10, borderRadius: 2.5 },
});
