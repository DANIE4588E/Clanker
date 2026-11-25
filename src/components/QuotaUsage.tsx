import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ComposerPopover } from '@/components/ComposerPopover';
import { formatUpdatedAt, usageToneColor, WindowMeter } from '@/components/SubscriptionUsageCard';
import { sessionWindow, type SubscriptionUsage } from '@/lib/subscriptions/usage';
import { useTheme } from '@/lib/theme';
import type { SubscriptionQuota } from '@/lib/useSubscriptionQuota';

/** Width of the gauge's track, which is also its tap target's width in the composer. */
// Sized to still fit a 320pt-wide screen with Stop, Send, effort and the context meter all showing.
export const QUOTA_METER_WIDTH = 88;
const QUOTA_METER_HEIGHT = 12;

/** Horizontal gauge of the 5-hour subscription quota left, emptying from the right as it runs out. */
export function QuotaMeter({ usage }: { usage?: SubscriptionUsage }) {
  const { colors } = useTheme();
  const window = sessionWindow(usage);
  return (
    <View style={styles.meter}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.textTertiary, opacity: 0.3 }]} />
      {window && (
        <View
          style={[
            styles.meterFill,
            { width: `${window.remainingPercent}%`, backgroundColor: usageToneColor(window.remainingPercent, colors) },
          ]}
        />
      )}
    </View>
  );
}

/** What the gauge reads out: the 5-hour window's share left. */
export function quotaMeterLabel(usage?: SubscriptionUsage): string {
  const window = sessionWindow(usage);
  return window ? `Usage left: ${window.remainingPercent}% (${window.label})` : 'Usage left';
}

type PopoverProps = {
  visible: boolean;
  quota: SubscriptionQuota;
  /** Screen distance from the left of the screen to the composer's left edge, where the card hangs. */
  left: number;
  bottom: number;
  maxWidth?: number;
  onClose: () => void;
};

/** Every quota window of the subscription in use, popping up from the composer's left corner, under the gauge. */
export function QuotaPopover({ visible, quota, left, bottom, maxWidth, onClose }: PopoverProps) {
  const { colors } = useTheme();
  const { usage, loading, endpoint, account, multiAccount } = quota;
  const plan = usage?.plan ?? account.plan ?? endpoint.subscriptionPlan;
  const who = multiAccount ? (account.email ?? account.label).split('@')[0] : undefined;
  const subtitle = [endpoint.name, plan, who].filter(Boolean).join(' · ');
  const windows = usage?.windows ?? [];

  return (
    <ComposerPopover
      visible={visible}
      left={left}
      bottom={bottom}
      maxWidth={maxWidth}
      onClose={onClose}
      closeLabel="Close usage"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]}>Usage left</Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textTertiary }]}>
            {subtitle}
          </Text>
        </View>
        <Pressable
          onPress={() => quota.refresh(true)}
          disabled={loading}
          hitSlop={8}
          accessibilityLabel="Refresh usage"
          style={({ pressed }) => [styles.refresh, { backgroundColor: colors.surfaceHover }, pressed && { opacity: 0.6 }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Feather name="refresh-cw" size={14} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>

      {windows.length ? (
        <View style={styles.windows}>
          {windows.map((w) => (
            <WindowMeter key={w.id} window={w} colors={colors} />
          ))}
        </View>
      ) : (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>
          {loading ? 'Checking remaining usage…' : usage?.error ? 'Could not load usage right now.' : 'No usage reported yet.'}
        </Text>
      )}

      {!!usage?.extra && (
        <Text style={[styles.extra, { color: colors.textSecondary, borderTopColor: colors.border }]}>{usage.extra}</Text>
      )}

      {!!usage?.error && windows.length > 0 && (
        <Text numberOfLines={2} style={[styles.note, { color: colors.danger }]}>
          Couldn’t refresh: {usage.error}
        </Text>
      )}

      <Text style={[styles.note, { color: colors.textTertiary }]}>
        {[
          usage?.fetchedAt && windows.length ? formatUpdatedAt(usage.fetchedAt) : undefined,
          multiAccount && endpoint.accountMode !== 'manual' ? 'Auto picks the account with the most left' : undefined,
        ]
          .filter(Boolean)
          .join('. ') || 'Usage is reported by your subscription.'}
      </Text>
    </ComposerPopover>
  );
}

const styles = StyleSheet.create({
  meter: { width: QUOTA_METER_WIDTH, height: QUOTA_METER_HEIGHT, borderRadius: QUOTA_METER_HEIGHT / 2, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: QUOTA_METER_HEIGHT / 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerText: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 13 },
  refresh: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  windows: { gap: 14, marginTop: 16 },
  empty: { fontSize: 14, marginTop: 14 },
  extra: { fontSize: 13, marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  note: { fontSize: 12, lineHeight: 17, marginTop: 14 },
});
