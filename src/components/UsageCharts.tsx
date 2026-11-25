import Feather from '@expo/vector-icons/Feather';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { G, Line, Path, Text as SvgText } from 'react-native-svg';
import * as Haptics from '@/lib/haptics';
import { compactTokens, type Share, type UsageSummary } from '@/lib/activity';
import { useTheme } from '@/lib/theme';
import { dayLabel } from './ActivityHeatmap';
import { CHROME } from './Chart';

const PLOT_HEIGHT = 160;
const LEFT = 36;
const BOTTOM = 22;
const TOP = 6;
const MAX_BAR = 24;

const percent = (n: number) => (n >= 0.995 ? '100%' : n < 0.001 ? '<0.1%' : `${(n * 100).toFixed(1)}%`);

/** A round step above `max` for the token axis. */
function niceMax(max: number) {
  if (max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  const norm = max / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

/** A column with its top corners rounded and its foot square on the baseline. */
function column(x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + k}A${k},${k} 0 0 1 ${x + k},${y}H${x + w - k}A${k},${k} 0 0 1 ${x + w},${y + k}V${y + h}Z`;
}

type Day = UsageSummary['days'][number];

/**
 * Tokens per day stacked by model (in `colorOf`'s colors). Tapping a day picks it out and puts
 * its numbers in the readout above the plot and beside each model in the legend.
 */
export const TrendChart = memo(function TrendChart({
  days,
  order,
  colorOf,
  labelOf,
}: {
  days: Day[];
  /** Model keys, bottom of the stack first. */
  order: string[];
  colorOf: (key: string) => string;
  labelOf: (key: string) => string;
}) {
  const { scheme, colors } = useTheme();
  const chrome = CHROME[scheme];
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked != null && picked < days.length ? days[picked] : null;

  const plotW = Math.max(0, width - LEFT);
  const peak = days.reduce((best, d) => (d.total > best.total ? d : best), days[0]);
  const top = niceMax(peak?.total ?? 0);
  const slot = days.length ? plotW / days.length : 0;
  const barW = Math.max(1, Math.min(MAX_BAR, slot * 0.68, slot - 1));
  const stackGap = barW >= 6 ? 2 : 1;
  const y = (v: number) => TOP + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT;
  const x = (i: number) => LEFT + slot * i + slot / 2;

  // Dates spaced as room allows, counted back from today so the latest day always has one.
  const labelEvery = Math.max(1, Math.ceil(64 / Math.max(1, slot)));
  const labels: number[] = [];
  for (let i = days.length - 1; i >= 0; i -= labelEvery) labels.push(i);

  const active = days.filter((d) => d.total > 0).length;
  const average = active ? days.reduce((n, d) => n + d.total, 0) / active : 0;

  const pick = (px: number) => {
    if (!slot) return;
    const i = Math.min(days.length - 1, Math.max(0, Math.floor((px - LEFT) / slot)));
    Haptics.selectionAsync();
    setPicked((p) => (p === i ? null : i));
  };

  return (
    <View style={styles.trend}>
      <View style={styles.readout}>
        {selected ? (
          <>
            <Text style={[styles.readoutValue, { color: colors.text }]}>
              {selected.total.toLocaleString('en-US')}
              <Text style={[styles.readoutUnit, { color: colors.textTertiary }]}> tokens</Text>
            </Text>
            <Text style={[styles.readoutLabel, { color: colors.textSecondary }]}>{dayLabel(selected.day)}</Text>
          </>
        ) : (
          <>
            <Text style={[styles.readoutValue, { color: colors.text }]}>
              {compactTokens(average)}
              <Text style={[styles.readoutUnit, { color: colors.textTertiary }]}> per active day</Text>
            </Text>
            {!!peak?.total && (
              <Text style={[styles.readoutLabel, { color: colors.textSecondary }]}>
                Peak {compactTokens(peak.total)} on {dayLabel(peak.day, false)}
              </Text>
            )}
          </>
        )}
      </View>

      <Pressable
        onPress={(e) => pick(e.nativeEvent.locationX)}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: TOP + PLOT_HEIGHT + BOTTOM }}
        accessibilityLabel={`Daily tokens. Average ${compactTokens(average)} per active day${peak?.total ? `, peak ${compactTokens(peak.total)} on ${dayLabel(peak.day, false)}` : ''}`}
      >
        {width > 0 && (
          <Svg width={width} height={TOP + PLOT_HEIGHT + BOTTOM}>
            {[0, 0.5, 1].map((f) => (
              <G key={f}>
                <Line
                  x1={LEFT}
                  x2={LEFT + plotW}
                  y1={y(top * f)}
                  y2={y(top * f)}
                  stroke={f ? chrome.grid : chrome.axis}
                  strokeWidth={StyleSheet.hairlineWidth * 2}
                />
                <SvgText x={0} y={y(top * f) + 3.5} fontSize={10} fill={chrome.muted}>
                  {compactTokens(top * f)}
                </SvgText>
              </G>
            ))}
            {days.map((d, i) => {
              const keys = order.filter((k) => d.byModel[k]);
              let base = 0;
              return (
                <G key={d.day} opacity={selected && selected.day !== d.day ? 0.3 : 1}>
                  {keys.map((key, k) => {
                    const v = d.byModel[key];
                    const bottom = y(base) - (base > 0 ? stackGap : 0);
                    base += v;
                    const yTop = y(base);
                    const h = Math.max(1, bottom - yTop);
                    const last = k === keys.length - 1;
                    return (
                      <Path
                        key={key}
                        d={column(x(i) - barW / 2, bottom - h, barW, h, last ? Math.min(4, barW / 3) : 0)}
                        fill={colorOf(key)}
                      />
                    );
                  })}
                </G>
              );
            })}
            {labels.map((i) => (
              <SvgText
                key={days[i].day}
                x={Math.min(Math.max(x(i), LEFT + 18), LEFT + plotW - 18)}
                y={TOP + PLOT_HEIGHT + 16}
                fontSize={10}
                fill={chrome.muted}
                textAnchor="middle"
              >
                {dayLabel(days[i].day, false)}
              </SvgText>
            ))}
          </Svg>
        )}
      </Pressable>

      <View style={styles.legend}>
        {order.map((key) => (
          <View key={key} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: colorOf(key) }]} />
            <Text numberOfLines={1} style={[styles.legendText, { color: colors.textSecondary }]}>
              {labelOf(key)}
            </Text>
            {!!selected?.byModel[key] && (
              <Text style={[styles.legendValue, { color: colors.text }]}>{compactTokens(selected.byModel[key])}</Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
});

/** One whole split into its shares, as a thin rounded bar. */
export function ShareBar({ shares, colorOf, total }: { shares: Share[]; colorOf: (s: Share, i: number) => string; total: number }) {
  const { colors } = useTheme();
  if (!total) return <View style={[styles.bar, { backgroundColor: colors.surface }]} />;
  return (
    <View style={styles.bar}>
      {shares.map((s, i) =>
        s.tokens ? <View key={s.key} style={{ flexGrow: s.tokens / total, flexBasis: 0, minWidth: 3, backgroundColor: colorOf(s, i) }} /> : null
      )}
    </View>
  );
}

/** Rows of shares, biggest first; ones with `children` expand to list them. */
export function ShareList({ shares, colorOf, total }: { shares: Share[]; colorOf: (s: Share, i: number) => string; total: number }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Rows line their numbers up with the ones that have a chevron after them.
  const chevrons = shares.some((s) => s.children?.length);
  return (
    <View style={[styles.list, { backgroundColor: colors.surface }]}>
      {shares.map((s, i) => {
        const expandable = !!s.children?.length;
        const expanded = !!open[s.key];
        return (
          <View key={s.key} style={i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
            <Pressable
              disabled={!expandable}
              onPress={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}
              accessibilityRole={expandable ? 'button' : undefined}
              accessibilityState={expandable ? { expanded } : undefined}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]}
            >
              <View style={[styles.swatch, { backgroundColor: colorOf(s, i) }]} />
              <View style={styles.grow}>
                <Text numberOfLines={1} style={[styles.label, { color: colors.text }]}>
                  {s.label}
                </Text>
                {!!s.sub && (
                  <Text numberOfLines={1} style={[styles.sub, { color: colors.textTertiary }]}>
                    {s.sub}
                  </Text>
                )}
              </View>
              <View style={styles.numbers}>
                <Text style={[styles.value, { color: colors.text }]}>{compactTokens(s.tokens)}</Text>
                <Text style={[styles.sub, { color: colors.textTertiary }]}>{total ? percent(s.tokens / total) : '—'}</Text>
              </View>
              {expandable ? (
                <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textTertiary} />
              ) : (
                chevrons && <View style={styles.chevron} />
              )}
            </Pressable>
            {expanded && (
              <View style={styles.children}>
                {s.children!.map((c) => (
                  <View key={c.key} style={styles.child}>
                    <View style={styles.grow}>
                      <Text numberOfLines={1} style={[styles.childLabel, { color: colors.textSecondary }]}>
                        {c.label}
                      </Text>
                      {c.sub !== s.label && !!c.sub && (
                        <Text numberOfLines={1} style={[styles.sub, { color: colors.textTertiary }]}>
                          {c.sub}
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.childValue, { color: colors.textSecondary }]}>{compactTokens(c.tokens)}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

export const OTHER = '__other__';

/** The top `keep` shares, with the rest folded into one "Other" share listing them. */
export function topShares(shares: Share[], keep: number): Share[] {
  if (shares.length <= keep + 1) return shares;
  const rest = shares.slice(keep);
  return [
    ...shares.slice(0, keep),
    {
      key: OTHER,
      label: 'Other',
      sub: `${rest.length} more`,
      tokens: rest.reduce((n, s) => n + s.tokens, 0),
      children: rest.flatMap((s) => (s.children?.length ? s.children : [s])),
    },
  ];
}

const styles = StyleSheet.create({
  trend: { gap: 12 },
  readout: { gap: 2 },
  readoutValue: { fontSize: 22, fontWeight: '600' },
  readoutUnit: { fontSize: 14, fontWeight: '400' },
  readoutLabel: { fontSize: 13 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  legendSwatch: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 12, flexShrink: 1 },
  legendValue: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2 },
  list: { borderRadius: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  grow: { flex: 1, minWidth: 0 },
  label: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums'] },
  numbers: { alignItems: 'flex-end' },
  value: { fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
  chevron: { width: 16 },
  children: { paddingBottom: 6 },
  child: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 38, paddingRight: 44, paddingVertical: 7 },
  childLabel: { fontSize: 14 },
  childValue: { fontSize: 13, fontVariant: ['tabular-nums'] },
});
