import Feather from '@expo/vector-icons/Feather';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { leavePlanMode, stopStreaming } from '@/lib/chat';
import { setCompaction, useCompaction } from '@/lib/compact';
import * as Haptics from '@/lib/haptics';
import { clearGoal, pauseGoal, resumeGoal, todoSummary } from '@/lib/planning';
import { leaveStudyMode } from '@/lib/study';
import { useTheme } from '@/lib/theme';
import { useChats, type Todo } from '@/store/chats';
import { usePlugins } from '@/store/plugins';
import { useSettings } from '@/store/settings';
import { composerMargin } from './Composer';
import { showGoalDetails } from './GoalSheet';

type IconName = keyof typeof Feather.glyphMap;

const ROW = 40;
// Like the queued messages: a tab narrower than the composer, tucked in under its top edge.
const TUCK = 18;
const INSET = 12;

/** Todo items with a mark by each: done, in progress or still to do. */
export function TodoList({ todos }: { todos: Todo[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.list}>
      {todos.map((todo, i) => {
        const done = todo.status === 'completed';
        const doing = todo.status === 'in_progress';
        const icon: IconName = done ? 'check-circle' : doing ? 'arrow-right-circle' : 'circle';
        return (
          <View key={i} style={styles.item}>
            <Feather
              name={icon}
              size={15}
              color={done ? colors.success : doing ? colors.accentText : colors.textTertiary}
              style={styles.itemIcon}
            />
            <Text
              style={[
                styles.itemText,
                { color: done ? colors.textTertiary : colors.text, fontWeight: doing ? '600' : '400' },
                done && styles.done,
              ]}
            >
              {todo.content}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function Action({ icon, label, onPress, color }: { icon: IconName; label: string; onPress: () => void; color?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      style={({ pressed }) => [styles.action, pressed && { opacity: 0.5 }]}
      accessibilityLabel={label}
    >
      <Feather name={icon} size={16} color={color ?? colors.textSecondary} />
    </Pressable>
  );
}

/** One line of the tab: an icon and what it is, then its actions at the end. */
function Row({
  icon,
  tint,
  onPress,
  label,
  children,
  actions,
}: {
  icon: IconName;
  tint: string;
  onPress?: () => void;
  label: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Animated.View entering={FadeIn.duration(160)} style={styles.row}>
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityLabel={label}
        style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.6 }]}
      >
        <Feather name={icon} size={16} color={tint} />
        {children}
      </Pressable>
      {actions}
    </Animated.View>
  );
}

/**
 * What the chat is in the middle of, as a tab on top of the message box: a /compact under way (or
 * failed), plan mode, the goal it is working toward, and the agent's todo list, one line each,
 * with ways to change or end them.
 */
export function ChatStatus({ conversationId, progress }: { conversationId: string; progress: SharedValue<number> }) {
  const { colors } = useTheme();
  const plan = useChats((s) => s.conversations[conversationId]?.plan);
  // Study mode counts only while the Study plugin is added.
  const studyOn = useChats((s) => !!s.conversations[conversationId]?.study);
  const studyAdded = usePlugins((s) => !!s.installed.study);
  const study = studyOn && studyAdded;
  const goal = useChats((s) => s.conversations[conversationId]?.goal);
  const todos = useChats((s) => s.conversations[conversationId]?.todos);
  const compaction = useCompaction((s) => s[conversationId]);
  const maxTurns = useSettings((s) => s.goalMaxTurns);
  const [listOpen, setListOpen] = useState(false);
  const cardStyle = useAnimatedStyle(() => ({ marginHorizontal: composerMargin(progress.value) + INSET }));

  if (!plan && !study && !goal && !todos?.length && !compaction) return null;
  const tally = todos?.length ? todoSummary(todos) : null;
  const allDone = !!tally && tally.done === tally.total;
  const divider = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.chromeBorder };

  const rows: ReactNode[] = [];
  if (compaction?.status === 'running') {
    rows.push(
      <Row
        key="compact"
        icon="minimize-2"
        tint={colors.accentText}
        label="Compacting: the model is summarising the chat so far"
        actions={
          <>
            <ActivityIndicator size="small" color={colors.textTertiary} style={styles.spinner} />
            <Action icon="x" label="Cancel compacting" onPress={() => stopStreaming(conversationId)} />
          </>
        }
      >
        <Text style={[styles.title, { color: colors.text }]}>Compacting</Text>
        <Text numberOfLines={1} style={[styles.detail, styles.fill, { color: colors.textTertiary }]}>
          Summarising the chat so far
        </Text>
      </Row>
    );
  } else if (compaction?.status === 'error') {
    const { error } = compaction;
    rows.push(
      <Row
        key="compact"
        icon="alert-circle"
        tint={colors.danger}
        onPress={() => Alert.alert('Couldn’t compact the chat', error)}
        label={`Couldn't compact the chat: ${error}`}
        actions={<Action icon="x" label="Dismiss" onPress={() => setCompaction(conversationId, undefined)} />}
      >
        <Text style={[styles.title, { color: colors.text }]}>Couldn’t compact</Text>
        <Text numberOfLines={1} style={[styles.detail, styles.fill, { color: colors.textTertiary }]}>
          {error}
        </Text>
      </Row>
    );
  }
  if (plan) {
    rows.push(
      <Row
        key="plan"
        icon="map"
        tint={colors.accentText}
        label="Plan mode: replies only research and propose a plan"
        actions={<Action icon="x" label="Leave plan mode" onPress={() => leavePlanMode(conversationId)} />}
      >
        <Text style={[styles.title, { color: colors.text }]}>Plan mode</Text>
        <Text numberOfLines={1} style={[styles.detail, styles.fill, { color: colors.textTertiary }]}>
          Research, then a plan to approve
        </Text>
      </Row>
    );
  }
  if (study) {
    rows.push(
      <Row
        key="study"
        icon="book-open"
        tint={colors.accentText}
        label="Study mode: replies teach step by step and test what you know"
        actions={<Action icon="x" label="Leave study mode" onPress={() => leaveStudyMode(conversationId)} />}
      >
        <Text style={[styles.title, { color: colors.text }]}>Study mode</Text>
        <Text numberOfLines={1} style={[styles.detail, styles.fill, { color: colors.textTertiary }]}>
          Guided learning, one step at a time
        </Text>
      </Row>
    );
  }
  if (goal) {
    rows.push(
      <Row
        key="goal"
        icon={goal.paused ? 'pause-circle' : 'target'}
        tint={goal.paused ? colors.textTertiary : colors.accentText}
        onPress={() => showGoalDetails(conversationId)}
        label={`Goal: ${goal.text}${goal.paused ? ', paused' : ''}. Show details`}
        actions={
          <>
            <Action icon="edit-2" label="Edit goal" onPress={() => showGoalDetails(conversationId, true)} />
            {goal.paused ? (
              <Action icon="play" label="Resume goal" color={colors.accentText} onPress={() => resumeGoal(conversationId)} />
            ) : (
              <Action icon="pause" label="Pause goal" onPress={() => pauseGoal(conversationId, 'You paused it.', true)} />
            )}
            <Action icon="x" label="Clear goal" onPress={() => clearGoal(conversationId)} />
          </>
        }
      >
        <Text numberOfLines={1} style={[styles.title, styles.fill, { color: goal.paused ? colors.textSecondary : colors.text }]}>
          {goal.text}
        </Text>
        {goal.paused ? (
          <Text style={[styles.tag, { color: colors.textTertiary }]}>Paused</Text>
        ) : (
          goal.turns > 0 && (
            <Text style={[styles.tag, { color: colors.textTertiary }]}>
              {goal.turns}/{maxTurns}
            </Text>
          )
        )}
      </Row>
    );
  }
  if (tally && todos) {
    rows.push(
      <Row
        key="todos"
        icon={allDone ? 'check-square' : 'list'}
        tint={allDone ? colors.success : colors.textSecondary}
        onPress={() => setListOpen(!listOpen)}
        label={`Todo list, ${tally.done} of ${tally.total} done. ${listOpen ? 'Hide' : 'Show'} items`}
        actions={
          <Action
            icon={listOpen ? 'chevron-down' : 'chevron-up'}
            label={listOpen ? 'Hide todo list' : 'Show todo list'}
            onPress={() => setListOpen(!listOpen)}
          />
        }
      >
        <Text style={[styles.title, styles.count, { color: colors.text }]}>
          {tally.done}/{tally.total}
        </Text>
        <Text numberOfLines={1} style={[styles.detail, styles.fill, { color: colors.textSecondary }]}>
          {allDone ? 'All done' : tally.current}
        </Text>
      </Row>
    );
  }

  return (
    <Animated.View style={[styles.card, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }, cardStyle]}>
      {rows.map((row, i) => (
        <View key={i} style={i > 0 ? divider : undefined}>
          {row}
        </View>
      ))}
      {listOpen && !!todos?.length && (
        <View style={divider}>
          <ScrollView nestedScrollEnabled style={styles.panel} contentContainerStyle={styles.panelContent}>
            <TodoList todos={todos} />
          </ScrollView>
          <Pressable
            onPress={() => {
              useChats.getState().setTodos(conversationId, undefined);
              setListOpen(false);
            }}
            hitSlop={8}
            accessibilityRole="button"
            style={({ pressed }) => [styles.clear, pressed && { opacity: 0.5 }]}
          >
            <Text style={[styles.clearText, { color: colors.textSecondary }]}>Clear list</Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingTop: 2,
    paddingBottom: TUCK,
    marginBottom: -TUCK,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', height: ROW, paddingLeft: 14, paddingRight: 6 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, height: '100%' },
  title: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  detail: { fontSize: 14, flexShrink: 1 },
  fill: { flex: 1 },
  count: { fontVariant: ['tabular-nums'] },
  tag: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], marginRight: 4 },
  action: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.8 }], marginRight: 2 },
  panel: { maxHeight: 200 },
  // The padding goes on the content: on the scroll view itself Android leaves it out of the scroll range.
  panelContent: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  list: { gap: 8 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  itemIcon: { marginTop: 2 },
  itemText: { flex: 1, fontSize: 14, lineHeight: 20 },
  done: { textDecorationLine: 'line-through' },
  clear: { alignSelf: 'flex-end', paddingHorizontal: 14, paddingVertical: 8 },
  clearText: { fontSize: 13, fontWeight: '500' },
});
