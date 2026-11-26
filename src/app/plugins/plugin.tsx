import Feather from '@expo/vector-icons/Feather';
import Constants from 'expo-constants';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { EdgeFade } from '@/components/EdgeFade';
import { addPlugin, reconnectPlugin, tryInChat } from '@/components/PluginActions';
import { pluginColor, PluginTile } from '@/components/PluginIcon';
import { PluginHeader, usePluginStatus } from '@/components/PluginRow';
import { openInBrowser } from '@/lib/plugins/auth';
import { CATEGORY_TITLES, isMcpPlugin, pluginById, pluginTools, type PluginDef } from '@/lib/plugins/catalog';
import { PROVIDERS } from '@/lib/plugins/providers';
import { useTheme } from '@/lib/theme';
import { usePlugins } from '@/store/plugins';

/** Mixes a #rrggbb color toward white by `amount` (0-1). */
function tint(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];

/** Prompts to try, on a card washed in the plugin's color; tapping one starts a chat with it. */
function Examples({ plugin, ready }: { plugin: PluginDef; ready: boolean }) {
  const color = pluginColor(plugin.id);
  const tag = `@${plugin.title}`;
  const start = (text: string) => {
    if (!ready) return addPlugin(plugin);
    // Prompts ending in ":" want something added (a link, a file), so they wait in the box.
    tryInChat(text, !/:\s*$/.test(text));
  };
  return (
    <View style={styles.card}>
      <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={tint(color, 0.55)} />
            <Stop offset="0.55" stopColor={tint(color, 0.72)} />
            <Stop offset="1" stopColor={tint('#5EC8A8', 0.55)} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#wash)" />
      </Svg>
      {plugin.examples.map((example) => (
        <Pressable
          key={example}
          onPress={() => start(example)}
          accessibilityRole="button"
          accessibilityHint={ready ? 'Starts a chat with this prompt' : `Adds ${plugin.title} first`}
          style={({ pressed }) => [styles.bubble, pressed && { opacity: 0.75 }]}
        >
          <Text style={styles.bubbleText}>
            {example.startsWith(tag) ? (
              <>
                <Text style={styles.bubbleTag}>{tag}</Text>
                {example.slice(tag.length)}
              </>
            ) : (
              example
            )}
          </Text>
          <View style={styles.go}>
            <Feather name="arrow-right" size={16} color="#111111" />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function InfoRow({ label, value, url }: { label: string; value: string; url?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.info, { borderBottomColor: colors.border }]}>
      <Text style={[styles.infoLabel, { color: colors.textTertiary }]}>{label}</Text>
      {url ? (
        <Text onPress={() => void openInBrowser(url)} numberOfLines={1} style={[styles.infoValue, { color: colors.link }]}>
          {value}
        </Text>
      ) : (
        <Text numberOfLines={2} style={[styles.infoValue, { color: colors.text }]}>
          {value}
        </Text>
      )}
    </View>
  );
}

/** A plugin's page: what it does, prompts to try, the account it uses, and its details. */
export default function PluginScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const plugin = pluginById(id);
  const status = usePluginStatus(plugin);
  const account = usePlugins((s) => (plugin && plugin.provider !== 'none' ? s.accounts[plugin.provider] : undefined));
  const write = usePlugins((s) => (plugin ? (s.installed[plugin.id]?.write ?? true) : true));
  const connecting = usePlugins((s) => !!plugin && s.connecting === plugin.id);
  // Re-renders when a server's tool list changes.
  usePlugins((s) => (plugin ? s.mcp[plugin.provider] : undefined));

  if (!plugin) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <PluginHeader title="Plugin" />
        <Text style={[styles.missing, { color: colors.textTertiary }]}>This plugin doesn’t exist.</Text>
      </View>
    );
  }

  const ready = status === 'ready';
  const tools = pluginTools(plugin);
  // An MCP server's tools are known only once it's connected; until then assume it can change things.
  const writes = tools.some((t) => t.write) || (isMcpPlugin(plugin) && !tools.length);
  const capabilities = !writes ? 'Read' : ready && !write ? 'Read only (changes off)' : 'Read and write';
  const provider = PROVIDERS[plugin.provider];
  const mcpOpen = provider.auth.kind === 'mcp' && !!provider.auth.open;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <PluginHeader
        title={plugin.title}
        right={
          status !== 'absent' && (
            <Pressable
              onPress={() => router.push({ pathname: '/plugins/settings', params: { id: plugin.id } })}
              accessibilityLabel={`${plugin.title} settings`}
              style={[styles.round, { backgroundColor: colors.chrome }]}
            >
              <Feather name="settings" size={21} color={colors.text} />
            </Pressable>
          )
        }
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}>
        <PluginTile id={plugin.id} size={60} />
        <Text style={[styles.name, { color: colors.text }]}>{plugin.title}</Text>
        <Text style={[styles.by, { color: colors.textTertiary }]}>By Clanker · {CATEGORY_TITLES[plugin.category]}</Text>

        <Examples plugin={plugin} ready={ready} />

        <Text style={[styles.description, { color: colors.text }]}>{plugin.description}</Text>

        <Text style={[styles.heading, { color: colors.text }]}>App</Text>
        <Pressable
          onPress={() => (status === 'absent' ? addPlugin(plugin) : router.push({ pathname: '/plugins/settings', params: { id: plugin.id } }))}
          style={({ pressed }) => [styles.app, pressed && { opacity: 0.6 }]}
        >
          <PluginTile id={plugin.id} size={40} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.appName, { color: colors.text }]}>{plugin.title}</Text>
            <Text numberOfLines={1} style={[styles.appDetail, { color: status === 'attention' ? colors.danger : colors.textTertiary }]}>
              {plugin.provider === 'none' || mcpOpen
                ? status === 'absent'
                  ? 'No account needed'
                  : 'Added · no account needed'
                : status === 'attention'
                  ? 'Needs reconnecting'
                  : account
                    ? (account.email ?? account.name ?? `Connected to ${provider.title}`)
                    : `Connect your ${provider.title} account`}
            </Text>
          </View>
        </Pressable>

        <Text style={[styles.heading, { color: colors.text }]}>Information</Text>
        <InfoRow label="Capabilities" value={capabilities} />
        <InfoRow label="Developer" value="Clanker" />
        <InfoRow
          label="Sign-in"
          value={
            provider.auth.kind === 'none'
              ? 'None'
              : provider.auth.kind === 'token'
                ? `${provider.title} token`
                : provider.auth.kind === 'mcp' && mcpOpen
                  ? 'None needed'
                  : `${provider.title} account`
          }
        />
        {provider.auth.kind === 'mcp' && <InfoRow label="Connection" value={`MCP server · ${host(provider.auth.url)}`} />}
        <InfoRow label="Website" value={host(plugin.website)} url={plugin.website} />
        <InfoRow label="Version" value={Constants.expoConfig?.version ?? '1.0'} />
        {plugin.privacy && <InfoRow label="Privacy Policy" value={host(plugin.privacy)} url={plugin.privacy} />}
        {plugin.terms && <InfoRow label="Terms of Service" value={host(plugin.terms)} url={plugin.terms} />}
      </ScrollView>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        <EdgeFade solid="bottom" style={StyleSheet.absoluteFill} />
        <Pressable
          onPress={() => (status === 'absent' ? addPlugin(plugin) : status === 'attention' ? reconnectPlugin(plugin) : tryInChat(`@${plugin.title} `))}
          disabled={connecting}
          accessibilityRole="button"
          style={({ pressed }) => [styles.cta, { backgroundColor: colors.text }, pressed && { opacity: 0.8 }]}
        >
          {connecting ? (
            <ActivityIndicator color={colors.background} />
          ) : (
            <Text style={[styles.ctaText, { color: colors.background }]}>
              {status === 'ready' ? 'Try in chat' : status === 'attention' ? 'Reconnect' : `Add ${plugin.title}`}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  missing: { textAlign: 'center', marginTop: 48, fontSize: 15 },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  name: { fontSize: 28, fontWeight: '600', marginTop: 16 },
  by: { fontSize: 14, marginTop: 4 },
  card: { marginTop: 22, borderRadius: 24, padding: 14, gap: 10, overflow: 'hidden' },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  bubbleText: { flex: 1, fontSize: 15, lineHeight: 21, color: '#111111' },
  bubbleTag: { fontWeight: '700' },
  go: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.95)' },
  description: { fontSize: 15, lineHeight: 22, marginTop: 24 },
  heading: { fontSize: 16, fontWeight: '600', marginTop: 28, marginBottom: 6 },
  app: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  appName: { fontSize: 16 },
  appDetail: { fontSize: 13, marginTop: 2 },
  info: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  infoLabel: { width: '42%', fontSize: 15 },
  infoValue: { flex: 1, fontSize: 15 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 28 },
  cta: { height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontSize: 17, fontWeight: '600' },
});
