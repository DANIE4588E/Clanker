import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Row, Section, ToggleRow } from '@/components/Form';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useTheme } from '@/lib/theme';
import { useMemory } from '@/store/memory';
import { useSettings, type FollowUpMode } from '@/store/settings';

const FOLLOW_UPS: { value: FollowUpMode; label: string; icon: 'list' | 'corner-down-right' }[] = [
  { value: 'queue', label: 'Queue', icon: 'list' },
  { value: 'steer', label: 'Steer', icon: 'corner-down-right' },
];

/** Settings → General: how chats behave. */
export default function GeneralScreen() {
  const { colors } = useTheme();
  const memory = useSettings((s) => s.memory);
  const setMemory = useSettings((s) => s.setMemory);
  const showArchived = useSettings((s) => s.showArchived);
  const setShowArchived = useSettings((s) => s.setShowArchived);
  const titleGeneration = useSettings((s) => s.titleGeneration);
  const setTitleGeneration = useSettings((s) => s.setTitleGeneration);
  const suggestions = useSettings((s) => s.suggestions);
  const setSuggestions = useSettings((s) => s.setSuggestions);
  const followUp = useSettings((s) => s.followUp);
  const setFollowUp = useSettings((s) => s.setFollowUp);
  const compression = useSettings((s) => s.compression);
  const memoryCount = useMemory((s) => s.memories.filter((m) => !m.projectId).length);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Section title="Chats">
        <ToggleRow
          icon="bookmark"
          title="Memory"
          detail={memoryCount ? `${memoryCount} saved memor${memoryCount === 1 ? 'y' : 'ies'}` : 'Remember things about you across chats'}
          value={memory}
          onValueChange={setMemory}
          onPress={() => router.push('/settings/memory')}
        />
        <ToggleRow
          icon="type"
          title="Generate titles"
          detail="Ask the model to name each chat after its first reply"
          value={titleGeneration}
          onValueChange={setTitleGeneration}
        />
        <ToggleRow
          icon="message-circle"
          title="Suggested prompts"
          detail="Show ideas from recent chats, generated at most once every 24 hours"
          value={suggestions}
          onValueChange={setSuggestions}
        />
        <ToggleRow
          icon="archive"
          title="Show archived chats"
          detail="List archived chats in the sidebar and in projects"
          value={showArchived}
          onValueChange={setShowArchived}
        />
        <Row
          icon="minimize-2"
          title="Auto-compression"
          value={`${compression.trigger}% → ${compression.target}%`}
          onPress={() => router.push('/settings/context')}
        />
      </Section>

      <Section
        title="Sending during a reply"
        footer={
          followUp === 'steer'
            ? 'Messages join the reply at its next step, so the model can change course mid-task.'
            : 'Messages wait above the box and go out one by one when the reply is done. Steer any of them in early from there.'
        }
      >
        <View style={styles.segment}>
          <SegmentedControl options={FOLLOW_UPS} value={followUp} onChange={setFollowUp} />
        </View>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  segment: { padding: 12 },
});
