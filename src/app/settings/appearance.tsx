import { ScrollView, StyleSheet, View } from 'react-native';
import { Section, ToggleRow } from '@/components/Form';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useTheme } from '@/lib/theme';
import { useSettings, type ChatDetail, type ThemePreference } from '@/store/settings';

const THEMES: { value: ThemePreference; label: string; icon: 'smartphone' | 'sun' | 'moon' }[] = [
  { value: 'system', label: 'System', icon: 'smartphone' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

const DETAILS: { value: ChatDetail; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'detailed', label: 'Detailed' },
  { value: 'verbose', label: 'Verbose' },
];

const DETAIL_FOOTERS: Record<ChatDetail, string> = {
  compact: 'While the model works, only "Working for…" shows. Tap it to see the steps.',
  normal: 'While the model works, "Working for…" shows with the step it is on. Tap it to see every step.',
  detailed: 'Every step shows while the model works, and folds away once the answer comes.',
  verbose: 'Every step and thought shows, and stays open until you fold it.',
};

/** Settings → Appearance: theme, model names, the new chat screen and what shows alongside replies. */
export default function AppearanceScreen() {
  const { colors } = useTheme();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const friendly = useSettings((s) => s.friendlyModelNames);
  const setFriendly = useSettings((s) => s.setFriendlyModelNames);
  const contextUsage = useSettings((s) => s.contextUsage);
  const setContextUsage = useSettings((s) => s.setContextUsage);
  const decodeSpeed = useSettings((s) => s.decodeSpeed);
  const setDecodeSpeed = useSettings((s) => s.setDecodeSpeed);
  const cacheHits = useSettings((s) => s.cacheHits);
  const setCacheHits = useSettings((s) => s.setCacheHits);
  const activityCalendar = useSettings((s) => s.activityCalendar);
  const setActivityCalendar = useSettings((s) => s.setActivityCalendar);
  const chatDetail = useSettings((s) => s.chatDetail);
  const setChatDetail = useSettings((s) => s.setChatDetail);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Section title="Theme">
        <View style={styles.segment}>
          <SegmentedControl options={THEMES} value={theme} onChange={setTheme} />
        </View>
      </Section>

      <Section title="Models">
        <ToggleRow
          icon="aperture"
          title="User-friendly model names"
          detail="Show provider logos and tidy names instead of long model and provider ids"
          value={friendly}
          onValueChange={setFriendly}
        />
      </Section>

      <Section title="New chat">
        <ToggleRow
          icon="calendar"
          title="Activity calendar"
          detail="Show your recent token use on the new chat screen"
          value={activityCalendar}
          onValueChange={setActivityCalendar}
        />
      </Section>

      <Section title="Reply detail" footer={DETAIL_FOOTERS[chatDetail]}>
        <View style={styles.segment}>
          <SegmentedControl options={DETAILS} value={chatDetail} onChange={setChatDetail} />
        </View>
      </Section>

      <Section title="Chat details">
        <ToggleRow
          icon="bar-chart-2"
          title="Context meter"
          detail="Show how much of the model's context a chat uses"
          value={contextUsage}
          onValueChange={setContextUsage}
        />
        <ToggleRow
          icon="zap"
          title="Decode speed"
          detail="Show tokens per second under replies"
          value={decodeSpeed}
          onValueChange={setDecodeSpeed}
        />
        <ToggleRow
          icon="database"
          title="Cache hits"
          detail="Show how much of the prompt the backend had cached"
          value={cacheHits}
          onValueChange={setCacheHits}
        />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  segment: { padding: 12 },
});
