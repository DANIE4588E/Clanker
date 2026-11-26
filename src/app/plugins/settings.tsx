import Feather from '@expo/vector-icons/Feather';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Row, Section, ToggleRow } from '@/components/Form';
import { addPlugin, reconnectPlugin, removePlugin, signOutProvider } from '@/components/PluginActions';
import { PluginTile } from '@/components/PluginIcon';
import { PluginHeader, usePluginStatus } from '@/components/PluginRow';
import { openInBrowser } from '@/lib/plugins/auth';
import { isMcpPlugin, pluginById, PLUGINS, pluginTools } from '@/lib/plugins/catalog';
import { refreshMcpTools } from '@/lib/plugins/mcp';
import { notify } from '@/components/Dialogs';
import { PROVIDERS } from '@/lib/plugins/providers';
import { useTheme } from '@/lib/theme';
import { usePlugins } from '@/store/plugins';

/** A plugin's settings: whether agents may change things, its account, and removing it. */
export default function PluginSettingsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const plugin = pluginById(id);
  const status = usePluginStatus(plugin);
  const installed = usePlugins((s) => (plugin ? s.installed[plugin.id] : undefined));
  const account = usePlugins((s) => (plugin && plugin.provider !== 'none' ? s.accounts[plugin.provider] : undefined));
  const setWrite = usePlugins((s) => s.setWrite);
  const allInstalled = usePlugins((s) => s.installed);
  const ownClient = usePlugins((s) => !!plugin && !!s.clients[plugin.provider]);
  const mcp = usePlugins((s) => (plugin ? s.mcp[plugin.provider] : undefined));
  const [refreshing, setRefreshing] = useState(false);

  if (!plugin) return <PluginHeader title="Settings" />;
  const provider = PROVIDERS[plugin.provider];
  const tools = pluginTools(plugin);
  const writes = tools.some((t) => t.write);
  const write = installed?.write ?? true;
  const shared = PLUGINS.filter((p) => p.provider === plugin.provider && allInstalled[p.id]).map((p) => p.title);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <PluginHeader title={plugin.title} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.hero}>
          <PluginTile id={plugin.id} size={48} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.heroTitle, { color: colors.text }]}>{plugin.title}</Text>
            <Text style={[styles.heroDetail, { color: status === 'attention' ? colors.danger : colors.textTertiary }]}>
              {status === 'absent' ? 'Not added' : status === 'attention' ? 'Needs reconnecting' : 'Added'}
            </Text>
          </View>
        </View>

        {status === 'absent' && (
          <Section>
            <Row icon="plus" title={`Add ${plugin.title}`} tint="link" onPress={() => addPlugin(plugin)} />
          </Section>
        )}

        {writes && status !== 'absent' && (
          <Section
            title="Permissions"
            footer={
              write
                ? 'Agents can create and change things. They’re told to check with you before sending, deleting or replacing anything you didn’t ask for.'
                : 'Agents can only search and read.'
            }
          >
            <ToggleRow
              icon="edit-3"
              title="Allow changes"
              detail={tools.filter((t) => t.write).map((t) => t.title).join(', ')}
              value={write}
              onValueChange={(v) => setWrite(plugin.id, v)}
            />
          </Section>
        )}

        <Section
          title="What agents can do"
          footer={
            mcp
              ? `${tools.length} tool${tools.length === 1 ? '' : 's'} from ${plugin.title}’s MCP server${mcp.toolsAt ? `, checked ${new Date(mcp.toolsAt).toLocaleString()}` : ''}.`
              : isMcpPlugin(plugin)
                ? `${plugin.title}’s tools come from its MCP server and show here once it’s added.`
                : undefined
          }
        >
          {mcp && (
            <Row
              icon="refresh-cw"
              title={refreshing ? 'Checking for new tools…' : 'Check for new tools'}
              tint="link"
              disabled={refreshing}
              onPress={async () => {
                setRefreshing(true);
                try {
                  await refreshMcpTools(plugin.provider);
                } catch (e) {
                  notify('Couldn’t check for tools', e instanceof Error ? e.message : String(e));
                } finally {
                  setRefreshing(false);
                }
              }}
            />
          )}
          {!tools.length &&
            plugin.features?.map((f) => (
              <Row
                key={f.title}
                leading={<Feather name={status === 'ready' ? 'check' : 'minus'} size={20} color={status === 'ready' ? colors.accentText : colors.textTertiary} />}
                title={f.title}
                detail={f.detail}
                muted={status !== 'ready'}
              />
            ))}
          {tools.map((t) => {
            const allowed = status === 'ready' && (!t.write || write);
            return (
              <Row
                key={t.name}
                leading={
                  <Feather
                    name={allowed ? 'check' : t.write && status === 'ready' ? 'lock' : 'minus'}
                    size={20}
                    color={allowed ? colors.accentText : colors.textTertiary}
                  />
                }
                title={t.title}
                detail={t.detail}
                muted={!allowed}
              />
            );
          })}
        </Section>

        {plugin.provider !== 'none' && account && (
          <Section
            title={`${provider.title} account`}
            footer={shared.length > 1 ? `Also used by ${shared.filter((t) => t !== plugin.title).join(', ')}.` : undefined}
          >
            <Row icon="user" title={account.email ?? account.name ?? provider.title} detail={account.email && account.name ? account.name : undefined} />
            {(status === 'attention' || provider.auth.kind === 'oauth') && (
              <Row icon="refresh-cw" title="Reconnect" tint="link" onPress={() => reconnectPlugin(plugin)} />
            )}
            {provider.manageUrl && <Row icon="external-link" title={`Manage access on ${provider.title}`} onPress={() => void openInBrowser(provider.manageUrl!)} />}
            <Row icon="log-out" title={`Disconnect ${provider.title}`} tint="danger" onPress={() => signOutProvider(plugin, () => router.back())} />
          </Section>
        )}

        {plugin.provider !== 'none' && ownClient && (
          <Section footer="This provider signs in with an OAuth client you entered. Remove it to go back to the app’s own client, if it has one.">
            <Row icon="key" title="Remove custom sign-in client" tint="danger" onPress={() => usePlugins.getState().setClient(plugin.provider, null)} />
          </Section>
        )}

        {status !== 'absent' && (
          <Section>
            <Row icon="trash-2" title={`Remove ${plugin.title}`} tint="danger" onPress={() => removePlugin(plugin, () => router.back())} />
          </Section>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 24, paddingHorizontal: 4 },
  heroTitle: { fontSize: 20, fontWeight: '600' },
  heroDetail: { fontSize: 14, marginTop: 2 },
});
