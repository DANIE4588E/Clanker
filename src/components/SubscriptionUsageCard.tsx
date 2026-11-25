import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatResetTime, glanceWindows, shortWindowLabel, type SubscriptionUsage, type UsageWindow } from '@/lib/subscriptions/usage';
import { useTheme, type Colors } from '@/lib/theme';

const WARN_COLOR = '#F59E0B';

export function usageToneColor(remainingPercent: number, colors: Colors): string {
  if (remainingPercent <= 10) return colors.danger;
  if (remainingPercent <= 25) return WARN_COLOR;
  return colors.success;
}

export function formatUpdatedAt(ts: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 45) return 'Updated just now';
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

export function WindowMeter({ window, colors }: { window: UsageWindow; colors: Colors }) {
  const fill = usageToneColor(window.remainingPercent, colors);
  const reset = window.resetsAt ? `Resets ${formatResetTime(window.resetsAt)}` : undefined;
  const sub = [window.detail, reset].filter(Boolean).join(' · ');

  return (
    <View style={styles.windowRow}>
      <View style={styles.windowHeader}>
        <Text numberOfLines={1} style={[styles.windowLabel, { color: colors.text }]}>
          {window.label}
        </Text>
        <Text style={[styles.windowPct, { color: window.remainingPercent <= 25 ? fill : colors.text }]}>
          {window.remainingPercent}% left
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: colors.surfaceHover }]}>
        <View style={[styles.fill, { width: `${Math.max(2, window.remainingPercent)}%`, backgroundColor: fill }]} />
      </View>
      {!!sub && (
        <Text numberOfLines={1} style={[styles.windowSub, { color: colors.textTertiary }]}>
          {sub}
        </Text>
      )}
    </View>
  );
}

/**
 * Full usage-left breakdown card for the subscription editor screen.
 */
export function SubscriptionUsageCard({
  usage,
  loading,
  compact = false,
  onRefresh,
}: {
  usage?: SubscriptionUsage;
  loading?: boolean;
  /** When embedded inside an account card, drops the outer card background/padding. */
  compact?: boolean;
  onRefresh: () => void;
}) {
  const { colors } = useTheme();
  const hasWindows = !!usage?.windows.length;

  return (
    <View style={[compact ? styles.compactCard : styles.card, !compact && { backgroundColor: colors.surface }]}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={[compact ? styles.compactTitle : styles.cardTitle, { color: compact ? colors.textSecondary : colors.text }]}>
            Usage left{!compact && usage?.plan ? ` · ${usage.plan}` : ''}
          </Text>
          {usage?.fetchedAt ? (
            <Text style={[styles.updated, { color: colors.textTertiary }]}>{formatUpdatedAt(usage.fetchedAt)}</Text>
          ) : null}
        </View>
        <Pressable
          onPress={onRefresh}
          disabled={loading}
          hitSlop={8}
          accessibilityLabel="Refresh subscription usage"
          style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.link} />
          ) : (
            <Feather name="refresh-cw" size={14} color={colors.link} />
          )}
          <Text style={{ color: colors.link, fontSize: 13, fontWeight: '500' }}>Refresh</Text>
        </Pressable>
      </View>

      {hasWindows ? (
        <View style={styles.windows}>
          {usage!.windows.map((w) => (
            <WindowMeter key={w.id} window={w} colors={colors} />
          ))}
        </View>
      ) : loading ? (
        <Text style={[styles.empty, { color: colors.textTertiary }]}>Checking remaining usage…</Text>
      ) : (
        <Text style={[styles.empty, { color: colors.textTertiary }]}>
          {usage?.error ? 'Could not load usage right now.' : 'Tap Refresh to check remaining subscription usage.'}
        </Text>
      )}

      {!!usage?.extra && (
        <Text style={[styles.extra, { color: colors.textSecondary, borderTopColor: colors.border }]}>{usage.extra}</Text>
      )}

      {!!usage?.error && (
        <View style={[styles.errorBox, { backgroundColor: colors.dangerBg }]}>
          <Feather name="alert-circle" size={14} color={colors.danger} />
          <Text style={[styles.errorText, { color: colors.danger }]}>{usage.error}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * Compact usage-left rows (label, bar, percent) for a subscription's heading in the model sheet:
 * the main windows, plus any other that is running low.
 */
export function QuotaLines({ usage, loading }: { usage?: SubscriptionUsage; loading?: boolean }) {
  const { colors } = useTheme();
  const windows = glanceWindows(usage);

  if (!windows.length) {
    if (!loading && !usage?.error) return null;
    return (
      <View style={styles.linesStatus}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.textTertiary} />
        ) : (
          <Feather name="alert-circle" size={13} color={colors.textTertiary} />
        )}
        <Text style={[styles.lineLabel, { color: colors.textTertiary }]}>
          {loading ? 'Checking usage…' : 'Usage unavailable right now'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.lines}>
      {windows.map((w) => {
        const fill = usageToneColor(w.remainingPercent, colors);
        const reset = w.resetsAt ? `, resets ${formatResetTime(w.resetsAt)}` : '';
        return (
          <View key={w.id} style={styles.line} accessible accessibilityLabel={`${w.label}: ${w.remainingPercent}% left${reset}`}>
            <Text numberOfLines={1} style={[styles.lineLabel, styles.lineName, { color: colors.textSecondary }]}>
              {shortWindowLabel(w.label)}
            </Text>
            <View style={[styles.lineTrack, { backgroundColor: colors.surfaceHover }]}>
              <View style={[styles.lineFill, { width: `${Math.max(2, w.remainingPercent)}%`, backgroundColor: fill }]} />
            </View>
            <Text style={[styles.linePct, { color: w.remainingPercent <= 25 ? fill : colors.textSecondary }]}>
              {w.remainingPercent}%
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, padding: 16, marginTop: 8 },
  compactCard: { paddingTop: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  compactTitle: { fontSize: 13, fontWeight: '600' },
  updated: { fontSize: 12, marginTop: 2 },
  refreshBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  windows: { gap: 14, marginTop: 14 },
  windowRow: { gap: 5 },
  windowHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  windowLabel: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  windowPct: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  track: { height: 7, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  windowSub: { fontSize: 12 },
  empty: { fontSize: 14, marginTop: 12 },
  extra: { fontSize: 13, marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, padding: 10, marginTop: 12 },
  errorText: { fontSize: 13, flex: 1, lineHeight: 18 },

  lines: { gap: 7, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  linesStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lineLabel: { fontSize: 12, fontWeight: '500' },
  lineName: { width: 64 },
  lineTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  lineFill: { height: '100%', borderRadius: 2 },
  linePct: { width: 36, textAlign: 'right', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
