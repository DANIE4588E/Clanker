import { StyleSheet, Text, View } from 'react-native';
import { ComposerPopover } from '@/components/ComposerPopover';
import { formatTokens } from '@/lib/context';
import { useTheme, type Colors } from '@/lib/theme';
import type { ContextUsage } from '@/lib/usage';
import { useSettings } from '@/store/settings';

const TOOLS_COLOR = '#A78BFA';
/** The gauge's drawn width; the composer spaces it by this rather than its tap target. */
export const CONTEXT_METER_WIDTH = 6;

const totalOf = (u: ContextUsage) => u.system + u.tools + u.messages;

function parts(u: ContextUsage, colors: Colors) {
  if (u.remote) return [{ label: 'Context held by backend', tokens: totalOf(u), color: colors.accent }];
  return [
    { label: 'System prompt', tokens: u.system, color: colors.textTertiary },
    { label: 'Tool definitions', tokens: u.tools, color: TOOLS_COLOR },
    { label: 'Messages', tokens: u.messages, color: colors.accent },
  ];
}

/** Thin vertical gauge that fills from the bottom as the chat uses up the model's budget. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { colors } = useTheme();
  const warnPercent = useSettings((s) => s.compression.trigger);
  const frac = totalOf(usage) / usage.budget;
  const threshold = usage.remote ? 90 : warnPercent;
  return (
    <View style={styles.meter}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.textTertiary, opacity: 0.3 }]} />
      <View
        style={[
          styles.meterFill,
          { height: `${Math.min(1, frac) * 100}%`, backgroundColor: frac * 100 >= threshold ? colors.danger : colors.accent },
        ]}
      />
    </View>
  );
}

type PopoverProps = {
  visible: boolean;
  usage: ContextUsage;
  /** Screen distance from the composer's right edge to the right of the screen. */
  right: number;
  /** Screen distance from the top of the composer down to the bottom of the screen. */
  bottom: number;
  /** Width of the overlay host, used to cap the card width accurately across fold states. */
  maxWidth?: number;
  onClose: () => void;
};

/** Breakdown of the context estimate, popping up from the composer's right-hand corner. */
export function ContextPopover({ visible, usage, right, bottom, maxWidth, onClose }: PopoverProps) {
  const { colors } = useTheme();
  // Past this share of the budget the app starts compressing history on its own.
  const warnPercent = useSettings((s) => s.compression.trigger);

  const total = totalOf(usage);
  const percent = Math.round((total / usage.budget) * 100);
  const threshold = usage.remote ? 90 : warnPercent;
  const prefix = usage.estimated === false ? '' : '~';
  // Over budget, the bar shows each part's share of the total instead.
  const scale = Math.max(total, usage.budget);

  return (
    <ComposerPopover
      visible={visible}
      right={right}
      bottom={bottom}
      maxWidth={maxWidth}
      onClose={onClose}
      closeLabel="Close context usage"
    >
      <View style={styles.header}>
        <Text style={[styles.headerText, { color: colors.textSecondary }]}>
          <Text style={{ color: percent >= threshold ? colors.danger : colors.text, fontWeight: '700' }}>
            {percent}%
          </Text>
          {'  '}of context used
        </Text>
        <Text style={[styles.headerText, { color: colors.text, fontWeight: '600' }]}>
          {prefix}{formatTokens(total)} / {formatTokens(usage.budget)}
        </Text>
      </View>

      <View style={[styles.bar, { backgroundColor: colors.surfaceHover }]}>
        {parts(usage, colors).map((p) =>
          p.tokens > 0 ? (
            <View
              key={p.label}
              style={{ width: `${(p.tokens / scale) * 100}%`, minWidth: 3, backgroundColor: p.color, borderRadius: 3 }}
            />
          ) : null
        )}
      </View>

      {parts(usage, colors).map((p) => (
        <View key={p.label} style={styles.row}>
          <View style={[styles.swatch, { backgroundColor: p.color }]} />
          <Text style={[styles.rowLabel, { color: colors.text }]}>{p.label}</Text>
          <Text style={[styles.rowValue, { color: colors.text }]}>{prefix}{formatTokens(p.tokens)}</Text>
        </View>
      ))}

      <Text style={[styles.note, { color: colors.textTertiary }]}>
        {usage.remote
          ? `${usage.estimated ? 'Estimated by' : 'Reported by'} the remote backend. History and compression are managed on the host.`
          : `Rough estimate against this model's budget. Past ${warnPercent}%, older history is compressed automatically.`}
      </Text>
    </ComposerPopover>
  );
}

const styles = StyleSheet.create({
  meter: { width: CONTEXT_METER_WIDTH, height: 22, borderRadius: 3, overflow: 'hidden', justifyContent: 'flex-end' },
  meterFill: { width: '100%', borderRadius: 3 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  headerText: { fontSize: 16 },
  bar: { flexDirection: 'row', gap: 2, height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 14, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { fontSize: 15, fontVariant: ['tabular-nums'] },
  note: { fontSize: 12, lineHeight: 17, marginTop: 14 },
});
