import { ScrollView, StyleSheet, View } from 'react-native';
import { Section, ToggleRow } from '@/components/Form';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useTheme } from '@/lib/theme';
import { useSettings, type ThemePreference } from '@/store/settings';

const THEMES: { value: ThemePreference; label: string; icon: 'smartphone' | 'sun' | 'moon' }[] = [
  { value: 'system', label: 'System', icon: 'smartphone' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

/** Settings → Appearance: theme, model names and what shows alongside replies. */
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
