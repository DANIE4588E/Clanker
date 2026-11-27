import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Row, Section } from '@/components/Form';
import { isSubscriptionType } from '@/lib/providers';
import { useTheme } from '@/lib/theme';
import { countToolsOn } from '@/lib/tools/summary';
import { updatesSupported } from '@/lib/updates';
import { useBackends } from '@/store/backends';
import { useSettings, type ThemePreference } from '@/store/settings';
import { useUpdates, type UpdatePhase } from '@/store/updates';

const THEME_LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function providersDetail(subscriptions: number, endpoints: number, remotes: number) {
  const parts = [
    subscriptions && plural(subscriptions, 'subscription'),
    endpoints && plural(endpoints, 'endpoint'),
    remotes && plural(remotes, 'remote backend'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Connect a subscription, API or remote backend';
}

function agentDetail(tools: boolean, web: boolean, disabled: string[]) {
  if (!tools) return 'Tools are off';
  const { on, total } = countToolsOn(disabled);
  const files = on === total ? 'Files & code' : `${on} of ${total} tools`;
  return web ? `${files} · Web access` : files;
}

function updatesValue(status: UpdatePhase) {
  switch (status.phase) {
    case 'available':
      return 'New version';
    case 'downloading':
      return `${Math.round(status.progress * 100)}%`;
    case 'ready':
      return 'Ready to install';
    default:
      return undefined;
  }
}

/** The top of Settings: one row per category, each opening its own screen. */
export default function SettingsScreen() {
  const { colors } = useTheme();
  const endpoints = useSettings((s) => s.endpoints);
  const subscriptions = endpoints.filter((e) => isSubscriptionType(e.type)).length;
  const remotes = useBackends((s) => s.remotes.length);
  const theme = useSettings((s) => s.theme);
  const tools = useSettings((s) => s.tools);
  const web = useSettings((s) => s.web);
  const disabledTools = useSettings((s) => s.disabledTools);
  const updateStatus = useUpdates((s) => s.status);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Section>
        <Row
          icon="sliders"
          title="General"
          detail="Custom instructions, memory and chat behavior"
          onPress={() => router.push('/settings/general')}
        />
        <Row
          icon="cloud"
          title="Providers"
          detail={providersDetail(subscriptions, endpoints.length - subscriptions, remotes)}
          onPress={() => router.push('/settings/providers')}
        />
        <Row
          icon="tool"
          title="Agent"
          detail={agentDetail(tools, web, disabledTools)}
          onPress={() => router.push('/settings/agent')}
        />
        <Row
          icon="eye"
          title="Appearance"
          detail="Theme, model names and chat details"
          value={THEME_LABELS[theme]}
          onPress={() => router.push('/settings/appearance')}
        />
        {updatesSupported && (
          <Row
            icon="download"
            title="Updates"
            detail="Check for new versions of Clanker"
            value={updatesValue(updateStatus)}
            onPress={() => router.push('/settings/updates')}
          />
        )}
      </Section>

      <Text style={[styles.version, { color: colors.textTertiary }]}>Clanker {Constants.expoConfig?.version ?? ''}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  version: { textAlign: 'center', fontSize: 13, marginTop: 4 },
});
