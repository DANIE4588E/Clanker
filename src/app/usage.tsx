import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityHeatmap } from '@/components/ActivityHeatmap';
import { SERIES } from '@/components/Chart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { OTHER, ShareBar, ShareList, TrendChart, topShares } from '@/components/UsageCharts';
import { addDays, compactTokens, dailyTotals, startOfDay, summarize, useUsageEvents, type Share } from '@/lib/activity';
import { useTheme } from '@/lib/theme';

type Range = 'today' | '7' | '30' | '90' | 'all';

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7', label: '7D' },
  { value: '30', label: '30D' },
  { value: '90', label: '90D' },
  { value: 'all', label: 'All' },
];

const RANGE_NAMES: Record<Range, string> = {
  today: 'today',
  '7': 'in the last 7 days',
  '30': 'in the last 30 days',
  '90': 'in the last 90 days',
  all: 'all time',
};

type Breakdown = 'models' | 'providers';

const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: 'models', label: 'Models' },
  { value: 'providers', label: 'Providers' },
];

// Shares past these fold into "Other", which takes the neutral color.
const TOP_MODELS = 7;
const TOP_PROVIDERS = 5;
const OTHER_COLOR = '#8E8E93';

function fromOf(range: Range) {
  const today = startOfDay(Date.now());
  if (range === 'all') return -Infinity;
  return addDays(today, range === 'today' ? 0 : 1 - Number(range));
}

/** Colors by rank in the range, so a share keeps its color across the trend, the bar and the list. */
function ranked(shares: Share[], palette: readonly string[]) {
  const byKey = new Map(shares.map((s, i) => [s.key, s.key === OTHER ? OTHER_COLOR : palette[i % palette.length]]));
  return (key: string) => byKey.get(key) ?? OTHER_COLOR;
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.statValue, { color: colors.text }]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[styles.statLabel, { color: colors.textTertiary }]}>
        {label}
      </Text>
    </View>
  );
}

function Heading({ title, detail }: { title: string; detail?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.headingRow}>
      <Text style={[styles.heading, { color: colors.text }]}>{title}</Text>
      {!!detail && <Text style={[styles.headingDetail, { color: colors.textTertiary }]}>{detail}</Text>}
    </View>
  );
}

export default function UsageScreen() {
  const { scheme, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const events = useUsageEvents();
  const [range, setRange] = useState<Range>('30');
  const [breakdown, setBreakdown] = useState<Breakdown>('models');

  const heatDays = useMemo(() => dailyTotals(events), [events]);
  const summary = useMemo(() => summarize(events, fromOf(range)), [events, range]);

  const palette = SERIES[scheme];
  const models = useMemo(() => topShares(summary.models, TOP_MODELS), [summary.models]);
  const modelColor = useMemo(() => ranked(models, palette), [models, palette]);
  const providers = useMemo(() => topShares(summary.providers, TOP_PROVIDERS), [summary.providers]);
  const providerColor = useMemo(() => ranked(providers, palette), [providers, palette]);
  const modelLabel = useMemo(() => {
    const byKey = new Map(models.map((m) => [m.key, m.label]));
    return (key: string) => byKey.get(key) ?? 'Other';
  }, [models]);

  // The trend stacks the top models; the rest go in as one "Other" layer.
  const trendDays = useMemo(() => {
    const shown = new Set(models.filter((m) => m.key !== OTHER).map((m) => m.key));
    return summary.days.map((d) => {
      const byModel: Record<string, number> = {};
      for (const [key, v] of Object.entries(d.byModel)) {
        const k = shown.has(key) ? key : OTHER;
        byModel[k] = (byModel[k] ?? 0) + v;
      }
      return { ...d, byModel };
    });
  }, [summary.days, models]);

  const empty = summary.tokens === 0;
  const shares = breakdown === 'models' ? models : providers;
  const colorOf = breakdown === 'models' ? modelColor : providerColor;

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
    >
      <View style={styles.section}>
        <ActivityHeatmap days={heatDays} title="Activity" weeks={53} cell={12} />
      </View>

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.section}>
        <SegmentedControl options={RANGES} value={range} onChange={setRange} />

        <View style={styles.hero}>
          <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>Tokens {RANGE_NAMES[range]}</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.heroValue, { color: colors.text }]}>
            {compactTokens(summary.tokens)}
          </Text>
          {!empty && (
            <Text style={[styles.split, { color: colors.textSecondary }]}>
              {summary.tokens.toLocaleString('en-US')} · {compactTokens(summary.input)} in · {compactTokens(summary.output)} out
            </Text>
          )}
        </View>

        <View style={[styles.stats, { backgroundColor: colors.surface }]}>
          <Stat label="Chats" value={summary.sessions.toLocaleString('en-US')} />
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <Stat label="Requests" value={summary.requests.toLocaleString('en-US')} />
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <Stat label="Active days" value={String(summary.activeDays)} />
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <Stat label="Cache hit" value={summary.cacheHit == null ? '—' : `${Math.round(summary.cacheHit * 100)}%`} />
        </View>
      </View>

      {range !== 'today' && (
        <View style={styles.section}>
          <Heading title="Daily tokens" detail={empty ? undefined : 'Tap a day'} />
          {empty ? (
            <Text style={[styles.empty, { color: colors.textTertiary }]}>No usage in this range.</Text>
          ) : (
            <TrendChart days={trendDays} order={models.map((m) => m.key)} colorOf={modelColor} labelOf={modelLabel} />
          )}
        </View>
      )}

      <View style={styles.section}>
        <Heading title="Breakdown" />
        <SegmentedControl options={BREAKDOWNS} value={breakdown} onChange={setBreakdown} />
        {empty ? (
          <Text style={[styles.empty, { color: colors.textTertiary }]}>No usage in this range.</Text>
        ) : (
          <>
            <ShareBar shares={shares} total={summary.tokens} colorOf={(s) => colorOf(s.key)} />
            <ShareList key={breakdown} shares={shares} total={summary.tokens} colorOf={(s) => colorOf(s.key)} />
          </>
        )}
      </View>

      <Text style={[styles.footnote, { color: colors.textTertiary }]}>
        Counted from the chats on this device. Where a provider doesn&apos;t report usage, output is estimated from the
        reply&apos;s length; deleted chats no longer count.
        {summary.cacheHit != null && ` Cache hit is the share of prompt tokens served from cache (${compactTokens(summary.cached)} ${RANGE_NAMES[range]}).`}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 12, gap: 32 },
  section: { paddingHorizontal: 16, gap: 16 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, marginVertical: -8 },
  hero: { gap: 2, paddingTop: 4 },
  heroLabel: { fontSize: 14 },
  heroValue: { fontSize: 52, fontWeight: '700', letterSpacing: -1.5 },
  split: { fontSize: 13, fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, paddingVertical: 14 },
  stat: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: 6 },
  statValue: { fontSize: 19, fontWeight: '600' },
  statLabel: { fontSize: 12 },
  statDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  headingRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  heading: { fontSize: 17, fontWeight: '600' },
  headingDetail: { fontSize: 12 },
  empty: { fontSize: 14, paddingVertical: 24, textAlign: 'center' },
  footnote: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16 },
});
