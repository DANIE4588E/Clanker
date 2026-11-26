import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EdgeFade } from '@/components/EdgeFade';
import { usePluginMenu } from '@/components/PluginActions';
import { PluginTile } from '@/components/PluginIcon';
import { PluginHeader, PluginRow, SectionHeading } from '@/components/PluginRow';
import { CATEGORY_TITLES, newPlugins, PLUGINS, pluginTools, popularPlugins, type PluginCategory, type PluginDef } from '@/lib/plugins/catalog';
import { refreshStaleMcpTools } from '@/lib/plugins/mcp';
import { useTheme } from '@/lib/theme';
import { usePlugins } from '@/store/plugins';
import { useSettings } from '@/store/settings';

/** Installed tiles shown before the "+N" tile. */
const STRIP = 5;
/** Rows a section shows before "›" opens the rest. */
const PREVIEW = 4;

const CATEGORIES: PluginCategory[] = ['google', 'microsoft', 'productivity', 'business', 'design', 'developer', 'files', 'lifestyle'];

/** The plugin store: what's installed, what's popular and new, every category, and search. */
export default function PluginsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const installed = usePlugins((s) => s.installed);
  const tools = useSettings((s) => s.tools);
  const { show, menu } = usePluginMenu();
  const [query, setQuery] = useState('');
  const mcp = usePlugins((s) => s.mcp);

  // MCP servers can add or change tools; check the ones not checked for a while.
  useEffect(() => {
    void refreshStaleMcpTools();
  }, []);

  const mine = useMemo(
    () => PLUGINS.filter((p) => installed[p.id]).sort((a, b) => installed[b.id]!.installedAt - installed[a.id]!.installedAt),
    [installed]
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return PLUGINS.filter((p) =>
      [p.title, p.summary, p.description, CATEGORY_TITLES[p.category], ...pluginTools(p).map((t) => t.title)].some((s) => s.toLowerCase().includes(q))
    );
    // Server tool lists feed the search too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mcp]);

  const openSection = (section: string) => router.push({ pathname: '/plugins/list', params: { section } });
  const rows = (list: PluginDef[]) => list.map((p) => <PluginRow key={p.id} plugin={p} onMenu={show} />);
  const section = (key: string, title: string, list: PluginDef[]) =>
    list.length > 0 && (
      <View key={key}>
        <SectionHeading title={title} onPress={list.length > PREVIEW ? () => openSection(key) : undefined} />
        {rows(list.slice(0, PREVIEW))}
      </View>
    );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <PluginHeader title="Plugins" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 110 }} keyboardShouldPersistTaps="handled">
        {!tools && (
          <Pressable onPress={() => router.push('/settings/agent')} style={[styles.notice, { backgroundColor: colors.surface }]}>
            <Feather name="alert-circle" size={18} color={colors.textSecondary} />
            <Text style={[styles.noticeText, { color: colors.textSecondary }]}>
              Agents can’t use plugins while files & code is off. Tap to turn it on in Settings → Agent.
            </Text>
          </Pressable>
        )}

        {results ? (
          <>
            <SectionHeading title={results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No plugins found'} />
            {rows(results)}
          </>
        ) : (
          <>
            <SectionHeading title="Installed" onPress={mine.length ? () => openSection('installed') : undefined} />
            {mine.length ? (
              <View style={styles.strip}>
                {mine.slice(0, STRIP).map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => router.push({ pathname: '/plugins/plugin', params: { id: p.id } })}
                    accessibilityLabel={p.title}
                    style={({ pressed }) => pressed && { opacity: 0.6 }}
                  >
                    <PluginTile id={p.id} size={52} />
                  </Pressable>
                ))}
                {mine.length > STRIP && (
                  <Pressable
                    onPress={() => openSection('installed')}
                    accessibilityLabel={`${mine.length - STRIP} more installed`}
                    style={({ pressed }) => [styles.more, { backgroundColor: colors.surface }, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={[styles.moreText, { color: colors.text }]}>+{mine.length - STRIP}</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <Text style={[styles.empty, { color: colors.textTertiary }]}>
                Add a plugin with + to let agents work in that app. It shows up here.
              </Text>
            )}

            {section('popular', 'Popular', popularPlugins())}
            {section('new', 'New & Noteworthy', newPlugins())}
            {CATEGORIES.map((c) => section(c, CATEGORY_TITLES[c], PLUGINS.filter((p) => p.category === c)))}

            <Text style={[styles.footnote, { color: colors.textTertiary }]}>
              Plugins work in chats with Clanker’s own agent. Each one acts as your account in that app; open a plugin to choose whether
              agents can change things or only read.
            </Text>
          </>
        )}
      </ScrollView>

      <KeyboardStickyView offset={{ opened: insets.bottom }} style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        <EdgeFade solid="bottom" style={styles.fade} />
        <View style={[styles.search, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}>
          <Feather name="search" size={20} color={colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search plugins"
            placeholderTextColor={colors.textTertiary}
            returnKeyType="search"
            style={[styles.searchInput, { color: colors.text }]}
          />
          {!!query && (
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search">
              <Feather name="x-circle" size={18} color={colors.textTertiary} />
            </Pressable>
          )}
        </View>
      </KeyboardStickyView>
      {menu}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  notice: { flexDirection: 'row', gap: 10, alignItems: 'center', marginHorizontal: 16, marginTop: 8, padding: 14, borderRadius: 14 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  strip: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 6 },
  more: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  moreText: { fontSize: 15, fontWeight: '600' },
  empty: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 6 },
  footnote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingTop: 28 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 32, paddingTop: 28 },
  fade: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 54, borderRadius: 27, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20 },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 0 },
});
