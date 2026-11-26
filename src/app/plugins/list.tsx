import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePluginMenu } from '@/components/PluginActions';
import { PluginHeader, PluginRow } from '@/components/PluginRow';
import { CATEGORY_TITLES, newPlugins, PLUGINS, popularPlugins, type PluginCategory } from '@/lib/plugins/catalog';
import { useTheme } from '@/lib/theme';
import { usePlugins } from '@/store/plugins';

/** Every plugin in one section of the store: installed, popular, new, or a category. */
export default function PluginListScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { section = 'installed' } = useLocalSearchParams<{ section: string }>();
  const installed = usePlugins((s) => s.installed);
  const { show, menu } = usePluginMenu();

  const [title, list] =
    section === 'installed'
      ? ['Installed', PLUGINS.filter((p) => installed[p.id]).sort((a, b) => installed[b.id]!.installedAt - installed[a.id]!.installedAt)]
      : section === 'popular'
        ? ['Popular', popularPlugins()]
        : section === 'new'
          ? ['New & Noteworthy', newPlugins()]
          : [CATEGORY_TITLES[section as PluginCategory] ?? 'Plugins', PLUGINS.filter((p) => p.category === section)];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <PluginHeader title={title} />
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 24 }}>
        {list.map((p) => (
          <PluginRow key={p.id} plugin={p} onMenu={show} />
        ))}
        {!list.length && <Text style={[styles.empty, { color: colors.textTertiary }]}>Nothing here yet.</Text>}
      </ScrollView>
      {menu}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 15 },
});
