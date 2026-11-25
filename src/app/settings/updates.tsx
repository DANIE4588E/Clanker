import { ScrollView, StyleSheet } from 'react-native';
import { Section, ToggleRow } from '@/components/Form';
import { UpdateRow } from '@/components/Updates';
import { useTheme } from '@/lib/theme';
import { useUpdates } from '@/store/updates';

/** Settings → Updates, on platforms where the app updates itself from GitHub releases. */
export default function UpdatesScreen() {
  const { colors } = useTheme();
  const checkOnLaunch = useUpdates((s) => s.checkOnLaunch);
  const setCheckOnLaunch = useUpdates((s) => s.setCheckOnLaunch);
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
          title="Check on launch"
          detail="Look for a new version when Clanker opens, at most once a day"
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
});
