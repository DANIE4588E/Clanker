import Feather from '@expo/vector-icons/Feather';
import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from '@/lib/haptics';
import type { ToolPart } from '@/lib/providers';
import { useTheme } from '@/lib/theme';
import { approvePlan, planOutcome, revisePlan } from '@/lib/tools/plan';
import { useSettings } from '@/store/settings';
import { Markdown } from './Markdown';
import { NestedScroll } from './NestedScroll';

// How tall the plan shows before it scrolls, until expanded.
const PREVIEW = 260;

/**
 * A plan the model submitted with exit_plan_mode. While the model writes it, it grows here; once
 * submitted, the user accepts it (plan mode ends and the work starts as a goal) or sends it back
 * with what to change. Decided, it folds into a line that opens to show the plan again.
 */
function PlanCardInner({ part }: { part: ToolPart }) {
  const { colors } = useTheme();
  const goalsOn = useSettings((s) => !s.disabledTools.includes('goal_done'));
  const title = typeof part.input.title === 'string' && part.input.title.trim() ? part.input.title.trim() : 'Plan';
  const plan = typeof part.input.plan === 'string' ? part.input.plan : '';
  const writing = part.status === 'writing';
  const waiting = part.status === 'running';
  const outcome = part.status === 'done' ? planOutcome(part.output) : undefined;

  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sent, setSent] = useState(false);
  // Long plans show in a scrolling preview; expanded, the whole plan is in the chat.
  const [full, setFull] = useState(false);
  const [tall, setTall] = useState(false);
  const expanded = writing || waiting || open;

  const status = writing
    ? { icon: 'edit-3' as const, label: 'Drafting plan', color: colors.textSecondary }
    : waiting
      ? { icon: 'map' as const, label: 'Plan for your approval', color: colors.accentText }
      : outcome === 'approved'
        ? { icon: 'check-circle' as const, label: 'Plan approved', color: colors.success }
        : outcome === 'revise'
          ? { icon: 'edit-2' as const, label: 'Changes requested', color: colors.textSecondary }
          : outcome === 'left'
            ? { icon: 'x-circle' as const, label: 'Plan mode ended', color: colors.textSecondary }
            : { icon: 'pause-circle' as const, label: 'Not decided', color: colors.textSecondary };

  const accept = () => {
    if (sent) return;
    setSent(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    approvePlan(part.id);
  };
  const sendBack = () => {
    if (sent) return;
    setSent(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    revisePlan(part.id, feedback);
  };

  return (
    <View style={[styles.card, { borderColor: waiting ? colors.accentText : colors.border }]}>
      <Pressable
        onPress={() => !writing && !waiting && setOpen(!open)}
        disabled={writing || waiting}
        accessibilityRole="button"
        accessibilityLabel={`${status.label}: ${title}`}
        accessibilityState={{ expanded }}
        style={({ pressed }) => [styles.header, pressed && { opacity: 0.6 }]}
      >
        <Feather name={status.icon} size={15} color={status.color} />
        <View style={styles.headerText}>
          <Text style={[styles.status, { color: status.color }]}>{status.label}</Text>
          <Text numberOfLines={expanded ? undefined : 1} style={[styles.title, { color: colors.text }]}>
            {title}
          </Text>
        </View>
        {writing ? (
          <ActivityIndicator size="small" color={colors.textTertiary} />
        ) : (
          !waiting && (
            <Feather
              name="chevron-down"
              size={15}
              color={colors.textTertiary}
              style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
            />
          )
        )}
      </Pressable>

      {expanded && !!plan && (
        <View style={[styles.frame, { backgroundColor: colors.surface }]}>
          {full ? (
            <View style={styles.planContent}>
              <Markdown value={plan} live={writing} />
            </View>
          ) : (
            // Follows the end while the model writes, so the newest steps stay in view.
            <NestedScroll style={styles.preview} contentContainerStyle={styles.planContent} follow={writing}>
              <View onLayout={(e) => !tall && e.nativeEvent.layout.height > PREVIEW - 24 && setTall(true)}>
                <Markdown value={plan} live={writing} />
              </View>
            </NestedScroll>
          )}
          {tall && (
            <Pressable
              onPress={() => setFull(!full)}
              accessibilityRole="button"
              accessibilityLabel={full ? 'Collapse the plan' : 'Show the full plan'}
              style={({ pressed }) => [styles.expand, { borderTopColor: colors.border }, pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.expandText, { color: colors.textSecondary }]}>{full ? 'Collapse' : 'Show full plan'}</Text>
              <Feather name={full ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
      )}

      {waiting && (
        <View style={styles.actions}>
          {reviewing ? (
            <>
              <TextInput
                value={feedback}
                onChangeText={setFeedback}
                editable={!sent}
                multiline
                autoFocus
                placeholder="What should change? (optional)"
                placeholderTextColor={colors.textTertiary}
                accessibilityLabel="Feedback on the plan"
                style={[styles.input, { color: colors.text, backgroundColor: colors.surface }]}
              />
              <View style={styles.buttons}>
                <Pressable
                  onPress={() => setReviewing(false)}
                  disabled={sent}
                  hitSlop={8}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.5 }]}
                >
                  <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>Back</Text>
                </Pressable>
                <Pressable
                  onPress={sendBack}
                  disabled={sent}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.primary, { backgroundColor: colors.sendBg }, (sent || pressed) && { opacity: 0.4 }]}
                >
                  <Text style={[styles.primaryText, { color: colors.sendFg }]}>Send to improve</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.hint, { color: colors.textTertiary }]}>
                {goalsOn ? 'Accepting ends plan mode and carries the plan out as a goal.' : 'Accepting ends plan mode and carries the plan out.'}
              </Text>
              <View style={styles.buttons}>
                <Pressable
                  onPress={() => setReviewing(true)}
                  disabled={sent}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.outline, { borderColor: colors.border }, (sent || pressed) && { opacity: 0.5 }]}
                >
                  <Feather name="edit-2" size={14} color={colors.text} />
                  <Text style={[styles.outlineText, { color: colors.text }]}>Keep planning</Text>
                </Pressable>
                <Pressable
                  onPress={accept}
                  disabled={sent}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.primary, { backgroundColor: colors.sendBg }, (sent || pressed) && { opacity: 0.4 }]}
                >
                  <Feather name="check" size={15} color={colors.sendFg} />
                  <Text style={[styles.primaryText, { color: colors.sendFg }]}>Accept plan</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

export const PlanCard = memo(PlanCardInner);

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 14, gap: 10, marginVertical: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerText: { flex: 1, gap: 1 },
  status: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase' },
  title: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  frame: { borderRadius: 12, overflow: 'hidden', marginTop: 2 },
  preview: { maxHeight: PREVIEW },
  // The padding goes on the content: on the scroll view itself Android leaves it out of the scroll range.
  planContent: { paddingHorizontal: 12, paddingVertical: 8 },
  expand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  expandText: { fontSize: 13, fontWeight: '500' },
  actions: { gap: 10, marginTop: 2 },
  hint: { fontSize: 13, lineHeight: 18 },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10 },
  primary: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9 },
  primaryText: { fontSize: 15, fontWeight: '600' },
  outline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  outlineText: { fontSize: 15, fontWeight: '500' },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, fontWeight: '500' },
  input: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 64, maxHeight: 160, textAlignVertical: 'top' },
});
