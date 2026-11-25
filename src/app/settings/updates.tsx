import { ScrollView, StyleSheet, View } from 'react-native';
import { Section, ToggleRow } from '@/components/Form';
import { SegmentedControl } from '@/components/SegmentedControl';
import { UpdateRow } from '@/components/Updates';
import { useTheme } from '@/lib/theme';
import { useUpdates, type UpdateInterval } from '@/store/updates';

const INTERVALS: { value: UpdateInterval; label: string; icon: 'power' | 'calendar' }[] = [
  { value: 'launch', label: 'On startup', icon: 'power' },
  { value: 'daily', label: 'Once a day', icon: 'calendar' },
];

/** Settings → Updates, on platforms where the app updates itself from GitHub releases. */
export default function UpdatesScreen() {
  const { colors } = useTheme();
  const checkOnLaunch = useUpdates((s) => s.checkOnLaunch);
  const setCheckOnLaunch = useUpdates((s) => s.setCheckOnLaunch);
  const checkInterval = useUpdates((s) => s.checkInterval);
  const setCheckInterval = useUpdates((s) => s.setCheckInterval);
  const dismissed = useUpdates((s) => s.dismissedVersion);
  const prereleases = useUpdates((s) => s.prereleases);
  const setPrereleases = useUpdates((s) => s.setPrereleases);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Section
        footer={
          prereleases
            ? "New versions come from the app's GitHub releases, including pre-releases: early builds that may be unfinished."
            : "New versions come from the app's GitHub releases."
        }
      >
        <UpdateRow />
        <ToggleRow
          icon="power"
          title="Check automatically"
          detail="Ask about a new version when one comes out"
          value={checkOnLaunch}
          onValueChange={setCheckOnLaunch}
        />
        <ToggleRow
          icon="git-branch"
          title="Include pre-releases"
          detail="Offer beta builds as well as stable releases"
          value={prereleases}
          onValueChange={setPrereleases}
        />
      </Section>

      {checkOnLaunch && (
        <Section
          title="Check"
          footer={
            (checkInterval === 'launch'
              ? 'Looks for a new version each time Clanker starts.'
              : 'Looks for a new version at most once every 24 hours.') +
            (dismissed
              ? ` Version ${dismissed} was dismissed, so only a newer one will ask.`
              : ' Dismiss a version to stop hearing about it until a newer one comes out.')
          }
        >
          <View style={styles.segment}>
            <SegmentedControl options={INTERVALS} value={checkInterval} onChange={setCheckInterval} />
          </View>
        </Section>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  segment: { padding: 12 },
});
