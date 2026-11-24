import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatResetTime, type SubscriptionUsage, type UsageWindow } from '@/lib/subscriptions/usage';
import { useTheme, type Colors } from '@/lib/theme';

const WARN_COLOR = '#F59E0B';

export function usageToneColor(remainingPercent: number, colors: Colors): string {
  if (remainingPercent <= 10) return colors.danger;
  if (remainingPercent <= 25) return WARN_COLOR;
  return colors.success;
}

function formatUpdatedAt(ts: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 45) return 'Updated just now';
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

function WindowMeter({ window, colors }: { window: UsageWindow; colors: Colors }) {
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
 * Compact horizontal usage-left strip shown inside ModelPicker under each subscription heading.
 */
export function SubscriptionUsageStrip({
  usage,
  loading,
  onRefresh,
}: {
  usage?: SubscriptionUsage;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const { colors } = useTheme();
  const windows = usage?.windows ?? [];

  if (!windows.length && !loading && !usage?.error) return null;

  return (
    <View style={styles.stripWrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stripContent}
        style={styles.stripScroll}
      >
        {windows.slice(0, 4).map((w) => {
          const fill = usageToneColor(w.remainingPercent, colors);
          const shortLabel = w.label.replace(/-hour$/i, 'h').replace(/-day$/i, 'd');
          const reset = w.resetsAt ? formatResetTime(w.resetsAt) : undefined;
          return (
            <View key={w.id} style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.chipTop}>
                <Text numberOfLines={1} style={[styles.chipLabel, { color: colors.textSecondary }]}>
                  {shortLabel}
                </Text>
                <Text style={[styles.chipPct, { color: w.remainingPercent <= 25 ? fill : colors.text }]}>
                  {w.remainingPercent}% left
                </Text>
              </View>
              <View style={[styles.miniTrack, { backgroundColor: colors.surfaceHover }]}>
                <View style={[styles.miniFill, { width: `${Math.max(3, w.remainingPercent)}%`, backgroundColor: fill }]} />
              </View>
              {!!reset && (
                <Text numberOfLines={1} style={[styles.chipReset, { color: colors.textTertiary }]}>
                  Resets {reset}
                </Text>
              )}
            </View>
          );
        })}
        {!windows.length && loading && (
          <View style={[styles.chip, styles.loadingChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <ActivityIndicator size="small" color={colors.textTertiary} />
            <Text style={[styles.chipLabel, { color: colors.textTertiary }]}>Checking usage…</Text>
          </View>
        )}
        {!windows.length && !loading && usage?.error && (
          <View style={[styles.chip, styles.loadingChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Feather name="alert-circle" size={12} color={colors.textTertiary} />
            <Text numberOfLines={1} style={[styles.chipLabel, { color: colors.textTertiary }]}>
              Usage unavailable
            </Text>
          </View>
        )}
      </ScrollView>
      {onRefresh && (
        <Pressable
          onPress={onRefresh}
          disabled={loading}
          hitSlop={8}
          accessibilityLabel="Refresh usage"
          style={({ pressed }) => [styles.stripRefresh, pressed && { opacity: 0.5 }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.textTertiary} />
          ) : (
            <Feather name="refresh-cw" size={13} color={colors.textTertiary} />
          )}
        </Pressable>
      )}
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

  stripWrap: { flexDirection: 'row', alignItems: 'center', paddingRight: 16, marginBottom: 4 },
  stripScroll: { flex: 1 },
  stripContent: { gap: 8, paddingLeft: 20, paddingRight: 6, paddingVertical: 4 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    minWidth: 112,
    maxWidth: 180,
    gap: 4,
  },
  loadingChip: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  chipTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  chipLabel: { fontSize: 12, fontWeight: '500', flexShrink: 1 },
  chipPct: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  miniTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  miniFill: { height: '100%', borderRadius: 2 },
  chipReset: { fontSize: 11 },
  stripRefresh: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});
