import { router } from 'expo-router';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { Row, Section, ToggleRow } from '@/components/Form';
import { useTheme } from '@/lib/theme';
import { countToolsOn, webDetail } from '@/lib/tools/summary';
import { SEARCH_PROVIDERS } from '@/lib/tools/web';
import { useSettings } from '@/store/settings';

/** Settings → Agent: the tools models can call on this phone. */
export default function AgentScreen() {
  const { colors } = useTheme();
  const tools = useSettings((s) => s.tools);
  const setTools = useSettings((s) => s.setTools);
  const disabledTools = useSettings((s) => s.disabledTools);
  const web = useSettings((s) => s.web);
  const setWeb = useSettings((s) => s.setWeb);
  const searchProvider = useSettings((s) => s.search.provider);

  const { on, total } = countToolsOn(disabledTools);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Section title="Tools" footer="Turn these off for models that don't support tool calling.">
        <ToggleRow
          icon="tool"
          title="Files & code"
          detail={
            on === total
              ? `Work with files and run Python${Platform.OS === 'android' ? ', JavaScript and shell commands' : ' and JavaScript'} on this phone`
              : `${on} of ${total} tools on`
          }
          value={tools}
          onValueChange={setTools}
          onPress={() => router.push('/settings/tools')}
        />
        <ToggleRow
          icon="globe"
          title="Web access"
          detail={tools ? webDetail(SEARCH_PROVIDERS[searchProvider].label, disabledTools) : 'Needs files & code'}
          value={web && tools}
          onValueChange={setWeb}
          onPress={() => router.push('/settings/search')}
          disabled={!tools}
        />
      </Section>

      <Section>
        <Row icon="folder" title="Workspace files" onPress={() => router.push('/settings/workspace')} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
});
