import Feather from '@expo/vector-icons/Feather';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { ContextMenu, type MenuAnchor, type MenuItem } from '@/components/ContextMenu';
import { confirm } from '@/components/Dialogs';
import { reportLibraryError } from '@/components/LibraryActions';
import { LibraryRow } from '@/components/LibraryTile';
import { libraryItems, purgeItems, type LibraryItem } from '@/lib/library';
import { useTheme } from '@/lib/theme';
import { useChats } from '@/store/chats';
import { useLibrary } from '@/store/library';

function confirmPurge(items: LibraryItem[]) {
  const agentFiles = items.some((i) => i.source === 'agent');
  confirm({
    title: items.length === 1 ? `Delete "${items[0].name}" for good?` : `Delete ${items.length} files for good?`,
    message: agentFiles
      ? "Files agents made are deleted from their chat's workspace too. Uploads stay in the messages they were sent with. This can't be undone."
      : "They stay in the messages they were sent with, but won't come back to the Library. This can't be undone.",
    confirmLabel: 'Delete',
    destructive: true,
    onConfirm: () => purgeItems(items),
  });
}

/** Files deleted from the Library: restore them, or delete them for good. */
export default function LibraryDeletedScreen() {
  const { colors } = useTheme();
  const deleted = useLibrary((s) => s.deleted);
  const purged = useLibrary((s) => s.purged);
  const [all, setAll] = useState<LibraryItem[]>([]);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[] } | null>(null);

  useFocusEffect(
    useCallback(() => {
      try {
        setAll(libraryItems(useChats.getState().conversations));
      } catch (e) {
        reportLibraryError(e);
      }
    }, [])
  );

  const items = useMemo(
    () => all.filter((i) => deleted[i.key] && !purged[i.key]).sort((a, b) => deleted[b.key] - deleted[a.key]),
    [all, deleted, purged]
  );

  const actions = useCallback(
    (item: LibraryItem, e: GestureResponderEvent) =>
      setMenu({
        anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
        items: [
          { label: 'Restore', icon: { feather: 'rotate-ccw' }, onPress: () => useLibrary.getState().restore([item.key]) },
          { label: 'Delete for good', icon: { feather: 'trash-2' }, destructive: true, onPress: () => confirmPurge([item]) },
        ],
      }),
    []
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            items.length ? (
              <Pressable onPress={() => confirmPurge(items)} hitSlop={8}>
                <Text style={{ color: colors.danger, fontSize: 16 }}>Empty</Text>
              </Pressable>
            ) : null,
        }}
      />
      <FlatList
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ paddingBottom: 48 }}
        data={items}
        keyExtractor={(i) => i.key}
        ListHeaderComponent={
          items.length ? (
            <Text style={[styles.note, { color: colors.textTertiary }]}>
              Files you delete from the Library wait here. Tap one to restore it or delete it for good.
            </Text>
          ) : undefined
        }
        // Rows open their menu on a tap as well as a long-press: there is nothing to preview here.
        renderItem={({ item }) => <LibraryRow item={item} favorite={false} onPress={actions} onLongPress={actions} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="trash-2" size={30} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>Nothing deleted.</Text>
          </View>
        }
      />
      <ContextMenu anchor={menu?.anchor ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 12 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 80 },
  emptyText: { fontSize: 15 },
});
