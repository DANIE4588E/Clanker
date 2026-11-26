import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Row, Section, ToggleRow } from '@/components/Form';
import { SegmentedControl } from '@/components/SegmentedControl';
import { brandOfEndpoint, brandOfModel, friendlyModelName } from '@/lib/modelNames';
import { PROVIDER_LABELS } from '@/lib/providers';
import { useTheme } from '@/lib/theme';
import { resolveTaskModel, useSettings, type ModelRef, type SuggestionRefresh } from '@/store/settings';

type Task = 'title' | 'suggestions' | 'memory' | 'skills';

const REFRESHES: { value: SuggestionRefresh; label: string; icon: 'calendar' | 'power' | 'plus-square' }[] = [
  { value: 'daily', label: 'Daily', icon: 'calendar' },
  { value: 'launch', label: 'Startup', icon: 'power' },
  { value: 'chat', label: 'New chat', icon: 'plus-square' },
];

const REFRESH_FOOTERS: Record<SuggestionRefresh, string> = {
  daily: 'New ideas at most once every 24 hours.',
  launch: 'New ideas each time Clanker starts.',
  chat: 'New ideas for every new chat. This sends the most extra requests.',
};

const TASKS = {
  title: {
    screen: 'Generate titles',
    icon: 'type',
    toggle: 'Generate titles',
    detail: 'Name each chat after its first reply',
    intro:
      'After the first reply in a chat, a short extra request asks a model to name it. A small, fast model is usually plenty.',
    fallback: "The chat's model",
    fallbackDetail: 'Whichever model the chat uses',
  },
  suggestions: {
    screen: 'Suggested prompts',
    icon: 'message-circle',
    toggle: 'Suggested prompts',
    detail: 'Show ideas from recent chats on new chats',
    intro:
      'New chats show conversation starters drawn from your recent chats. Each fresh set takes one short extra request.',
    fallback: 'The selected model',
    fallbackDetail: 'Whichever model is picked for new chats',
  },
  memory: {
    screen: 'Save memories automatically',
    icon: 'zap',
    toggle: 'Save from chats automatically',
    detail: "Pick up what's worth remembering after each reply",
    intro:
      'After each reply, a short extra request asks a model whether the exchange holds anything worth remembering, or corrects a saved memory. It thinks before answering, so a capable model gives the best results.',
    fallback: "The chat's model",
    fallbackDetail: 'Whichever model the chat uses',
  },
  skills: {
    screen: 'Self-improving skills',
    icon: 'zap',
    toggle: 'Self-improving skills',
    detail: 'Save and improve skills from tasks',
    intro:
      'Models with tools save what worked as skills, and fix skills that turned out wrong, as they go. After a reply with five or more tool calls that saved nothing, one extra request also asks a model whether the task is worth keeping. It thinks and writes the skill itself, so a capable model gives the best results.',
    fallback: "The chat's model",
    fallbackDetail: 'Whichever model the chat uses',
  },
} as const;

/**
 * Settings → General → Generate titles / Suggested prompts, and Settings → Memory → Save from chats
 * automatically: turn it on or off and pick its model.
 */
export default function TaskModelScreen() {
  const { colors } = useTheme();
  const { task: param } = useLocalSearchParams<{ task?: string }>();
  const task: Task = param === 'suggestions' || param === 'memory' || param === 'skills' ? param : 'title';
  const copy = TASKS[task];

  const endpoints = useSettings((s) => s.endpoints);
  const friendly = useSettings((s) => s.friendlyModelNames);
  const on = useSettings((s) =>
    task === 'title'
      ? s.titleGeneration
      : task === 'memory'
        ? s.memoryAuto && s.memory
        : task === 'skills'
          ? s.skillsAuto
          : s.suggestions
  );
  // Saving automatically needs memory itself on.
  const memoryOff = useSettings((s) => task === 'memory' && !s.memory);
  const chosen = useSettings((s) =>
    task === 'title' ? s.titleModel : task === 'memory' ? s.memoryModel : task === 'skills' ? s.skillModel : s.suggestionModel
  );
  const refresh = useSettings((s) => s.suggestionRefresh);
  const setRefresh = useSettings((s) => s.setSuggestionRefresh);
  const setOn = (value: boolean) => {
    const s = useSettings.getState();
    if (task === 'title') s.setTitleGeneration(value);
    else if (task === 'memory') s.setMemoryAuto(value);
    else if (task === 'skills') s.setSkillsAuto(value);
    else s.setSuggestions(value);
  };
  const choose = (ref: ModelRef | null) => {
    const s = useSettings.getState();
    if (task === 'title') s.setTitleModel(ref);
    else if (task === 'memory') s.setMemoryModel(ref);
    else if (task === 'skills') s.setSkillModel(ref);
    else s.setSuggestionModel(ref);
  };
  // A choice whose model has since gone counts as the fallback, as it does when generating.
  const valid = resolveTaskModel(endpoints, chosen) ? chosen : null;

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: copy.screen }} />
      <Text style={[styles.intro, { color: colors.textTertiary }]}>{copy.intro}</Text>

      <Section footer={memoryOff ? 'Turn on memory to save from chats.' : undefined}>
        <ToggleRow
          icon={copy.icon}
          title={copy.toggle}
          detail={copy.detail}
          value={on}
          onValueChange={setOn}
          disabled={memoryOff}
        />
      </Section>

      {task === 'suggestions' && on && (
        <Section title="Refresh" footer={REFRESH_FOOTERS[refresh]}>
          <View style={styles.segment}>
            <SegmentedControl options={REFRESHES} value={refresh} onChange={setRefresh} />
          </View>
        </Section>
      )}

      <Section title="Model" footer={endpoints.length ? undefined : 'Add a provider to choose a different model.'}>
        <Row
          icon="corner-down-right"
          title={copy.fallback}
          detail={copy.fallbackDetail}
          selected={!valid}
          accessibilityRole="radio"
          accessibilityState={{ checked: !valid }}
          onPress={() => choose(null)}
          disabled={!on}
        />
      </Section>

      {endpoints
        .filter((e) => e.models.length)
        .map((e) => (
          <Section key={e.id} title={friendly ? e.name : `${e.name} · ${PROVIDER_LABELS[e.type]}`}>
            {e.models.map((m) => {
              const selected = valid?.endpointId === e.id && valid.model === m;
              return (
                <Row
                  key={m}
                  brand={friendly ? brandOfModel(m) ?? brandOfEndpoint(e) : undefined}
                  icon={friendly ? undefined : 'cpu'}
                  title={friendly ? friendlyModelName(m) || m : m}
                  selected={selected}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => choose({ endpointId: e.id, model: m })}
                  disabled={!on}
                />
              );
            })}
          </Section>
        ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  intro: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginBottom: 24 },
  segment: { padding: 12 },
});
