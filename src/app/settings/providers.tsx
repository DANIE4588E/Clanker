import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Row, Section } from '@/components/Form';
import { isSubscriptionType, PROVIDER_LABELS } from '@/lib/providers';
import { brandOfBackendKind, brandOfEndpoint, friendlyModelName } from '@/lib/modelNames';
import { accountsOf, primaryDisplayAccount } from '@/lib/subscriptions/router';
import { compactUsageSummary } from '@/lib/subscriptions/usage';
import { useTheme } from '@/lib/theme';
import { formatBytes } from '@/lib/local/device';
import { useBackends } from '@/store/backends';
import { useLocalModels } from '@/store/localModels';
import { useSettings } from '@/store/settings';
import { useSubscriptionUsage } from '@/store/subscriptionUsage';

const models = (n: number) => `${n} model${n === 1 ? '' : 's'}`;

/** Settings → Providers: subscriptions, API endpoints, on-device models and remote backends. */
export default function ProvidersScreen() {
  const { colors } = useTheme();
  const endpoints = useSettings((s) => s.endpoints);
  const friendly = useSettings((s) => s.friendlyModelNames);
  const subscriptions = endpoints.filter((e) => isSubscriptionType(e.type));
  const apiEndpoints = endpoints.filter((e) => !isSubscriptionType(e.type) && e.type !== 'local');
  const localModels = useLocalModels((s) => s.models);
  const localDownloads = useLocalModels((s) => Object.keys(s.downloads).length);
  const localSize = localModels.reduce((n, m) => n + m.size, 0);
  const byAccount = useSubscriptionUsage((s) => s.byAccount);
  const remotes = useBackends((s) => s.remotes);

  useFocusEffect(
    useCallback(() => {
      const subs = useSettings.getState().endpoints.filter((e) => isSubscriptionType(e.type));
      for (const sub of subs) void useSubscriptionUsage.getState().refresh(sub);
    }, [])
  );

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Section
        title="Subscriptions"
        footer="Connect a Codex or Claude subscription without an API key. Tokens stay in the device keychain."
      >
        {subscriptions.map((e) => {
          const accounts = accountsOf(e);
          const { account, usage: u } = primaryDisplayAccount(e, byAccount);
          const summary = compactUsageSummary(u);
          const plan = u?.plan ?? account?.plan ?? e.subscriptionPlan;
          const multiPrefix =
            accounts.length > 1
              ? e.accountMode === 'manual'
                ? `${account?.label ?? 'Manual'} (${accounts.length})`
                : `Auto · ${accounts.length} accounts`
              : plan ?? e.subscriptionAccount;
          const detail = summary
            ? [multiPrefix, summary].filter(Boolean).join(' · ')
            : [multiPrefix, models(e.models.length)].filter(Boolean).join(' · ');
          return (
            <Row
              key={e.id}
              icon="user-check"
              brand={friendly ? brandOfEndpoint(e) : undefined}
              title={e.name}
              detail={detail}
              value={summary ? `${e.models.length}m` : undefined}
              onPress={() => router.push({ pathname: '/settings/subscription', params: { id: e.id } })}
            />
          );
        })}
        <Row icon="plus" title="Add subscription" tint="link" onPress={() => router.push('/settings/subscription')} />
      </Section>

      <Section title="API endpoints" footer="Connect any OpenAI-compatible, Anthropic, Ollama or Gemini API. Keys stay in the device keychain.">
        {apiEndpoints.map((e) => (
          <Row
            key={e.id}
            icon="cloud"
            brand={friendly ? brandOfEndpoint(e) : undefined}
            title={e.name}
            detail={friendly ? models(e.models.length) : `${PROVIDER_LABELS[e.type]} · ${models(e.models.length)}`}
            onPress={() => router.push({ pathname: '/settings/endpoint', params: { id: e.id } })}
          />
        ))}
        <Row icon="plus" title="Add endpoint" tint="link" onPress={() => router.push('/settings/endpoint')} />
      </Section>

      <Section
        title="Local"
        footer="Experimental. Download GGUF models from Hugging Face and run them on this phone, with no connection or API key."
      >
        <Row
          icon="smartphone"
          title="On-device models"
          value="Experimental"
          detail={
            localModels.length || localDownloads
              ? [
                  localModels.length ? `${models(localModels.length)} · ${formatBytes(localSize)}` : undefined,
                  localDownloads ? `${localDownloads} downloading` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Browse and download models'
          }
          onPress={() => router.push('/settings/local')}
        />
      </Section>

      <Section
        title="Remote backends"
        footer="Run chats on Hermes or DeepSeek Harness on another computer, with its own tools and memory. Choose one from the chat title when starting a chat."
      >
        {remotes.map((b) => (
          <Row
            key={b.id}
            icon="server"
            brand={friendly ? brandOfBackendKind(b.kind) : undefined}
            title={b.name}
            detail={friendly ? friendlyModelName(b.model) || b.model : `${b.kind === 'hermes' ? 'Hermes' : 'DeepSeek Harness'} · ${b.model}`}
            onPress={() => router.push({ pathname: '/settings/backend', params: { id: b.id } })}
          />
        ))}
        <Row icon="plus" title="Add remote backend" tint="link" onPress={() => router.push('/settings/backend')} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
});
