import Feather from '@expo/vector-icons/Feather';
import { useEffect } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { create } from 'zustand';
import * as Haptics from '@/lib/haptics';
import { clearGoal, formatElapsed, pauseGoal, resumeGoal } from '@/lib/planning';
import { useTheme } from '@/lib/theme';
import { useChats } from '@/store/chats';
import { useSettings } from '@/store/settings';
import { Markdown } from './Markdown';

/**
 * The chat's goal in full: what it is, who set it, how far the app has taken it on its own, and
 * the plan behind it, with ways to edit, pause, resume or clear it. Opened from the goal chip or
 * "/goal"; shown by the one GoalSheetHost at the root.
 */

type Sheet = {
  conversationId: string | null;
  editing: boolean;
  /** The goal's text as being edited. */
  draft: string;
  planOpen: boolean;
  /** When the sheet opened, for "set 5m ago". */
  openedAt: number;
};

const useGoalSheet = create<Sheet>()(() => ({ conversationId: null, editing: false, draft: '', planOpen: false, openedAt: 0 }));

const goalText = (conversationId: string) => useChats.getState().conversations[conversationId]?.goal?.text ?? '';

/** Opens the goal of the chat, straight into editing it with `edit`. */
export const showGoalDetails = (conversationId: string, edit = false) =>
  useGoalSheet.setState({ conversationId, editing: edit, draft: goalText(conversationId), planOpen: false, openedAt: Date.now() });

const close = () => useGoalSheet.setState({ conversationId: null, editing: false });

const BY = { user: 'you', agent: 'the model', plan: 'an approved plan' } as const;

/** Mount once, at the root, next to DialogHost. */
export function GoalSheetHost() {
  const { colors } = useTheme();
  const conversationId = useGoalSheet((s) => s.conversationId);
  const editing = useGoalSheet((s) => s.editing);
  const goal = useChats((s) => (conversationId ? s.conversations[conversationId]?.goal : undefined));
  const maxTurns = useSettings((s) => s.goalMaxTurns);
  const draft = useGoalSheet((s) => s.draft);
  const planOpen = useGoalSheet((s) => s.planOpen);
  const openedAt = useGoalSheet((s) => s.openedAt);
  const setDraft = (draft: string) => useGoalSheet.setState({ draft });
  const setPlanOpen = (planOpen: boolean) => useGoalSheet.setState({ planOpen });

  // A goal finished or cleared while the sheet is up takes the sheet with it.
  useEffect(() => {
    if (conversationId && !goal) close();
  }, [conversationId, goal]);

  const id = conversationId;
  // Editing starts from the goal as it is now.
  const startEdit = () => useGoalSheet.setState({ editing: true, draft: goal?.text ?? '' });
  const save = () => {
    const text = draft.trim();
    if (!id || !goal || !text) return;
    if (text !== goal.text) useChats.getState().setGoal(id, { ...goal, text });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    useGoalSheet.setState({ editing: false });
  };

  const paused = !!goal?.paused;
  const tint = paused ? colors.textSecondary : colors.accentText;
  const used = goal ? Math.min(goal.turns, maxTurns) : 0;

  return (
    <Modal visible={!!goal} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <Pressable style={[styles.backdrop, { backgroundColor: colors.overlay }]} onPress={close}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border }]}>
          {goal && id && (
            <>
              <View style={styles.head}>
                <View style={[styles.badge, { backgroundColor: colors.surface }]}>
                  <Feather name={paused ? 'pause' : 'target'} size={18} color={tint} />
                </View>
                <View style={styles.headText}>
                  <Text style={[styles.eyebrow, { color: colors.textTertiary }]}>Goal</Text>
                  <View style={styles.stateRow}>
                    <View style={[styles.dot, { backgroundColor: paused ? colors.textTertiary : colors.success }]} />
                    <Text style={[styles.state, { color: colors.textSecondary }]}>{paused ? 'Paused' : 'Working on it'}</Text>
                  </View>
                </View>
                <Pressable onPress={close} hitSlop={12} accessibilityLabel="Close" style={styles.closeButton}>
                  <Feather name="x" size={20} color={colors.textSecondary} />
                </Pressable>
              </View>

              {editing ? (
                <View style={styles.editBox}>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    multiline
                    autoFocus
                    placeholder="What should it work toward?"
                    placeholderTextColor={colors.textTertiary}
                    accessibilityLabel="Goal"
                    style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
                  />
                  <Text style={[styles.note, { color: colors.textTertiary }]}>
                    The model sees the new wording from its next step.
                  </Text>
                </View>
              ) : (
                <Pressable
                  onPress={startEdit}
                  accessibilityRole="button"
                  accessibilityLabel={`Goal: ${goal.text}. Edit`}
                  style={({ pressed }) => [styles.goalBox, { backgroundColor: colors.surface }, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.goalText, { color: colors.text }]}>{goal.text}</Text>
                  <Feather name="edit-2" size={15} color={colors.textTertiary} style={styles.goalEdit} />
                </Pressable>
              )}

              {!editing && (
                <>
                  {paused && (
                    <View style={[styles.callout, { borderColor: colors.border }]}>
                      <Feather name="info" size={14} color={colors.textSecondary} style={styles.calloutIcon} />
                      <Text style={[styles.calloutText, { color: colors.textSecondary }]}>{goal.paused!.reason}</Text>
                    </View>
                  )}

                  <View style={styles.stats}>
                    <View style={styles.stat}>
                      <Text style={[styles.statLabel, { color: colors.textTertiary }]}>Automatic turns</Text>
                      <Text style={[styles.statValue, { color: colors.text }]}>
                        {used}
                        <Text style={{ color: colors.textTertiary }}> / {maxTurns}</Text>
                      </Text>
                      <View style={[styles.track, { backgroundColor: colors.surface }]}>
                        <View style={[styles.fill, { width: `${(used / maxTurns) * 100}%`, backgroundColor: tint }]} />
                      </View>
                    </View>
                    <View style={styles.stat}>
                      <Text style={[styles.statLabel, { color: colors.textTertiary }]}>Set by</Text>
                      <Text numberOfLines={1} style={[styles.statValue, { color: colors.text }]}>
                        {BY[goal.by ?? 'user']}
                      </Text>
                      <Text style={[styles.statSub, { color: colors.textTertiary }]}>{formatElapsed(openedAt - goal.setAt)} ago</Text>
                    </View>
                  </View>

                  {!!goal.plan && (
                    <View style={[styles.planBox, { borderColor: colors.border }]}>
                      <Pressable
                        onPress={() => setPlanOpen(!planOpen)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: planOpen }}
                        style={({ pressed }) => [styles.planHead, pressed && { opacity: 0.6 }]}
                      >
                        <Feather name="map" size={15} color={colors.textSecondary} />
                        <Text style={[styles.planTitle, { color: colors.text }]}>Approved plan</Text>
                        <Feather
                          name="chevron-down"
                          size={16}
                          color={colors.textTertiary}
                          style={{ transform: [{ rotate: planOpen ? '180deg' : '0deg' }] }}
                        />
                      </Pressable>
                      {planOpen && (
                        <ScrollView style={styles.plan} contentContainerStyle={styles.planContent} nestedScrollEnabled>
                          <Markdown value={goal.plan} />
                        </ScrollView>
                      )}
                    </View>
                  )}
                </>
              )}

              <View style={styles.actions}>
                {editing ? (
                  <>
                    <View style={styles.spacer} />
                    <Button label="Cancel" onPress={() => useGoalSheet.setState({ editing: false })} />
                    <Button label="Save" variant="primary" disabled={!draft.trim()} onPress={save} />
                  </>
                ) : (
                  <>
                    <Button
                      label="Clear"
                      icon="trash-2"
                      variant="danger"
                      onPress={() => {
                        clearGoal(id);
                        close();
                      }}
                    />
                    <View style={styles.spacer} />
                    <Button
                      label={paused ? 'Resume' : 'Pause'}
                      icon={paused ? 'play' : 'pause'}
                      variant="outline"
                      onPress={() => (paused ? resumeGoal(id) : pauseGoal(id, 'You paused it.', true))}
                    />
                    <Button label="Edit" icon="edit-2" variant="primary" onPress={startEdit} />
                  </>
                )}
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Button({
  label,
  icon,
  onPress,
  variant,
  disabled,
}: {
  label: string;
  icon?: keyof typeof Feather.glyphMap;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'danger';
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const fg = variant === 'primary' ? colors.sendFg : variant === 'danger' ? colors.danger : variant === 'outline' ? colors.text : colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && { backgroundColor: colors.sendBg },
        variant === 'outline' && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
        variant === 'danger' && styles.buttonFlush,
        (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 },
      ]}
    >
      {icon && <Feather name={icon} size={14} color={fg} />}
      <Text style={[styles.buttonText, { color: fg, fontWeight: variant === 'primary' ? '600' : '500' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: 20 },
  sheet: { borderRadius: 24, padding: 20, gap: 16, borderWidth: StyleSheet.hairlineWidth, maxHeight: '85%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  state: { fontSize: 14, fontWeight: '500' },
  closeButton: { padding: 4, alignSelf: 'flex-start' },
  goalBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  goalText: { flex: 1, fontSize: 17, lineHeight: 24, fontWeight: '600' },
  goalEdit: { marginTop: 4 },
  editBox: { gap: 6 },
  input: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 96,
    maxHeight: 200,
    textAlignVertical: 'top',
  },
  note: { fontSize: 12, lineHeight: 16, marginHorizontal: 4 },
  callout: { flexDirection: 'row', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10 },
  calloutIcon: { marginTop: 2 },
  calloutText: { flex: 1, fontSize: 14, lineHeight: 20 },
  stats: { flexDirection: 'row', gap: 16 },
  stat: { flex: 1, gap: 4 },
  statLabel: { fontSize: 12, fontWeight: '500' },
  statValue: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statSub: { fontSize: 12 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  fill: { height: 4, borderRadius: 2 },
  planBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  planTitle: { flex: 1, fontSize: 15, fontWeight: '500' },
  plan: { maxHeight: 260 },
  planContent: { paddingHorizontal: 12, paddingBottom: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  spacer: { flex: 1 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  buttonFlush: { paddingHorizontal: 6 },
  buttonText: { fontSize: 15 },
});
