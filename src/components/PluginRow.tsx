import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pluginGranted, type PluginDef } from '@/lib/plugins/catalog';
import { useTheme } from '@/lib/theme';
import { usePlugins } from '@/store/plugins';
import type { MenuAnchor } from './ContextMenu';
import { addPlugin } from './PluginActions';
import { PluginTile } from './PluginIcon';

/** Whether the plugin is added and working, needs attention, or isn't added. */
export function usePluginStatus(plugin: PluginDef | undefined): 'ready' | 'attention' | 'absent' {
  const installed = usePlugins((s) => !!plugin && !!s.installed[plugin.id]);
  const account = usePlugins((s) => (!plugin || plugin.provider === 'none' ? null : s.accounts[plugin.provider]));
  if (!plugin || !installed) return 'absent';
  if (plugin.provider !== 'none' && (!account || account.needsReconnect || !pluginGranted(plugin))) return 'attention';
  return 'ready';
}

/**
 * A plugin in a list: its tile, name and summary, and at the end + to add it, a spinner while it
 * connects, or ⋯ for its menu once added.
 */
export function PluginRow({ plugin, onMenu }: { plugin: PluginDef; onMenu: (plugin: PluginDef, anchor: MenuAnchor) => void }) {
  const { colors } = useTheme();
  const status = usePluginStatus(plugin);
  const connecting = usePlugins((s) => s.connecting === plugin.id);
  const open = () => router.push({ pathname: '/plugins/plugin', params: { id: plugin.id } });

  return (
    <Pressable onPress={open} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]}>
      <PluginTile id={plugin.id} size={44} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {plugin.title}
        </Text>
        <Text numberOfLines={1} style={[styles.summary, { color: status === 'attention' ? colors.danger : colors.textSecondary }]}>
          {status === 'attention' ? 'Needs reconnecting' : plugin.summary}
        </Text>
      </View>
      <View style={styles.action}>
        {connecting ? (
          <ActivityIndicator color={colors.text} />
        ) : status === 'absent' ? (
          <Pressable onPress={() => addPlugin(plugin)} hitSlop={12} accessibilityLabel={`Add ${plugin.title}`} style={styles.hit}>
            <Feather name="plus" size={24} color={colors.text} />
          </Pressable>
        ) : (
          <Pressable
            onPress={(e) => onMenu(plugin, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
            hitSlop={12}
            accessibilityLabel={`${plugin.title} options`}
            style={styles.hit}
          >
            <Feather name="more-horizontal" size={22} color={colors.text} />
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

/** A section heading that opens the whole section when it has more to show. */
export function SectionHeading({ title, onPress }: { title: string; onPress?: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} hitSlop={8} style={({ pressed }) => [styles.heading, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.headingText, { color: colors.text }]}>{title}</Text>
      {onPress && <Feather name="chevron-right" size={18} color={colors.text} />}
    </Pressable>
  );
}

/** The round back button and centered title the plugin screens share. */
export function PluginHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} accessibilityLabel="Back" style={[styles.round, { backgroundColor: colors.chrome }]}>
        <Feather name="arrow-left" size={22} color={colors.text} />
      </Pressable>
      <Text numberOfLines={1} style={[styles.headerTitle, { color: colors.text }]}>
        {title}
      </Text>
      <View style={styles.round}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1 },
  title: { fontSize: 16, fontWeight: '500' },
  summary: { fontSize: 13, marginTop: 2 },
  action: { width: 36, alignItems: 'center', justifyContent: 'center' },
  hit: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingHorizontal: 16, paddingTop: 22, paddingBottom: 8 },
  headingText: { fontSize: 15, fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600' },
});
