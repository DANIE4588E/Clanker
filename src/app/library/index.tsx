import Feather from '@expo/vector-icons/Feather';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { BackHandler, FlatList, Pressable, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContextMenu, type MenuAnchor, type MenuItem } from '@/components/ContextMenu';
import { EdgeFade } from '@/components/EdgeFade';
import { libraryItemActions, removeFromLibrary, reportLibraryError } from '@/components/LibraryActions';
import { filterCount, LibraryFilterSheet, NO_FILTERS, passes, type LibraryFilters } from '@/components/LibraryFilter';
import { LibraryCard, LibraryRow } from '@/components/LibraryTile';
import * as Haptics from '@/lib/haptics';
import { libraryItems, shareItem, type LibraryItem } from '@/lib/library';
import { useTheme } from '@/lib/theme';
import { useChats } from '@/store/chats';
import { useLibrary } from '@/store/library';

type Tab = 'suggested' | 'favorites' | 'all';

const TABS: { value: Tab; label: string }[] = [
  { value: 'suggested', label: 'Suggested' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'all', label: 'All' },
];

// Suggested: the files made or used most recently.
const SUGGESTED = 20;
const GAP = 12;

const EMPTY: Record<Tab, string> = {
  suggested: 'Files you upload and files agents make for you show up here.',
  favorites: 'Long-press a file and add it to Favorites to keep it here.',
  all: 'Files you upload and files agents make for you show up here.',
};

/**
 * Every file the user uploaded and every file an agent handed them, across all chats: browse as a
 * grid or a list, search, filter, favorite, preview, and start a new chat about one.
 */
export default function LibraryScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const favorites = useLibrary((s) => s.favorites);
  const deleted = useLibrary((s) => s.deleted);
  const purged = useLibrary((s) => s.purged);
  const view = useLibrary((s) => s.view);

  const [all, setAll] = useState<LibraryItem[]>([]);
  // Read again whenever the screen comes back into view: chats may have added or removed files.
  useFocusEffect(
    useCallback(() => {
      try {
        setAll(libraryItems(useChats.getState().conversations));
      } catch (e) {
        reportLibraryError(e);
      }
    }, [])
  );

  const [tab, setTab] = useState<Tab>('suggested');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[] } | null>(null);

  const present = useMemo(() => all.filter((i) => !deleted[i.key] && !purged[i.key]), [all, deleted, purged]);
  const deletedCount = useMemo(() => all.filter((i) => deleted[i.key] && !purged[i.key]).length, [all, deleted, purged]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A search or filter looks through everything, whatever the tab.
    const searching = !!q || filterCount(filters) > 0;
    let items = present.filter((i) => passes(i, filters) && (!q || i.name.toLowerCase().includes(q) || i.chatTitle.toLowerCase().includes(q)));
    if (tab === 'favorites') items = items.filter((i) => favorites[i.key]);
    else if (tab === 'suggested' && !searching) items = items.slice(0, SUGGESTED);
    return items;
  }, [present, query, filters, tab, favorites]);

  const selecting = selection != null;
  const endSelect = useCallback(() => setSelection(null), []);
  const toggleSelected = useCallback((item: LibraryItem) => {
    void Haptics.selectionAsync();
    setSelection((s) => {
      const next = new Set(s);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
  }, []);

  // Back leaves choosing files before it leaves the screen.
  useFocusEffect(
    useCallback(() => {
      if (!selecting) return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        endSelect();
        return true;
      });
      return () => sub.remove();
    }, [selecting, endSelect])
  );

  const onPress = useCallback(
    (item: LibraryItem) => {
      if (selecting) toggleSelected(item);
      else router.push({ pathname: '/library/file', params: { key: item.key } });
    },
    [selecting, toggleSelected]
  );
  const onLongPress = useCallback(
    (item: LibraryItem, e: GestureResponderEvent) => {
      if (selecting) return toggleSelected(item);
      void Haptics.selectionAsync();
      setMenu({ anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }, items: libraryItemActions(item) });
    },
    [selecting, toggleSelected]
  );

  const openMoreMenu = (e: GestureResponderEvent) =>
    setMenu({
      anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 16 },
      items: [
        view === 'grid'
          ? { label: 'View as list', icon: { feather: 'list' }, onPress: () => useLibrary.getState().setView('list') }
          : { label: 'View as grid', icon: { feather: 'grid' }, onPress: () => useLibrary.getState().setView('grid') },
        {
          label: filterCount(filters) ? `Filter (${filterCount(filters)})` : 'Filter',
          icon: { feather: 'filter' },
          onPress: () => setFilterOpen(true),
        },
        { label: 'Select', icon: { feather: 'check-circle' }, onPress: () => setSelection(new Set()) },
        {
          label: deletedCount ? `Deleted (${deletedCount})` : 'Deleted',
          icon: { feather: 'trash-2' },
          separated: true,
          onPress: () => router.push('/library/deleted'),
        },
      ],
    });

  const chosen = selecting ? shown.filter((i) => selection.has(i.key)) : [];
  const allChosen = selecting && shown.length > 0 && chosen.length === shown.length;
  const anyUnfavorite = chosen.some((i) => !favorites[i.key]);

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      {selecting ? (
        <>
          <Pressable onPress={endSelect} accessibilityLabel="Stop selecting" style={[styles.round, { backgroundColor: colors.chrome }]}>
            <Feather name="x" size={22} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>
            {chosen.length ? `${chosen.length} selected` : 'Select files'}
          </Text>
          <Pressable
            onPress={() => setSelection(allChosen ? new Set() : new Set(shown.map((i) => i.key)))}
            style={[styles.pill, { backgroundColor: colors.chrome }]}
          >
            <Text style={[styles.pillText, { color: colors.text }]}>{allChosen ? 'None' : 'All'}</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Pressable onPress={() => router.back()} accessibilityLabel="Back" style={[styles.round, { backgroundColor: colors.chrome }]}>
            <Feather name="arrow-left" size={22} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Library</Text>
          <Pressable onPress={openMoreMenu} accessibilityLabel="More options" style={[styles.round, { backgroundColor: colors.chrome }]}>
            <Feather name="more-vertical" size={22} color={colors.text} />
            {filterCount(filters) > 0 && <View style={[styles.dot, { backgroundColor: colors.accent }]} />}
          </Pressable>
        </>
      )}
    </View>
  );

  const tabs = (
    <View style={styles.tabs}>
      {TABS.map((t) => {
        const on = t.value === tab;
        return (
          <Pressable
            key={t.value}
            onPress={() => setTab(t.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.tab, on && { backgroundColor: colors.surface }]}
          >
            <Text style={[styles.tabText, { color: on ? colors.text : colors.textSecondary }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const bottomSpace = insets.bottom + 96;
  const searching = !!query.trim() || filterCount(filters) > 0;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {header}
      {tabs}
      <FlatList
        key={view}
        data={shown}
        numColumns={view === 'grid' ? 2 : 1}
        keyExtractor={(i) => i.key}
        columnWrapperStyle={view === 'grid' ? { gap: GAP } : undefined}
        contentContainerStyle={[view === 'grid' ? styles.grid : styles.list, { paddingBottom: bottomSpace }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => {
          const Tile = view === 'grid' ? LibraryCard : LibraryRow;
          return (
            <Tile
              item={item}
              favorite={!!favorites[item.key]}
              selected={selecting ? selection.has(item.key) : undefined}
              onPress={onPress}
              onLongPress={onLongPress}
            />
          );
        }}
        ListHeaderComponent={
          filterCount(filters) > 0 ? (
            <Pressable onPress={() => setFilters(NO_FILTERS)} style={[styles.filterChip, { backgroundColor: colors.surface }, view === 'list' && { marginLeft: 16 }]}>
              <Feather name="filter" size={14} color={colors.text} />
              <Text style={{ color: colors.text, fontSize: 14 }}>
                {filterCount(filters)} filter{filterCount(filters) === 1 ? '' : 's'} on
              </Text>
              <Feather name="x" size={14} color={colors.textSecondary} />
            </Pressable>
          ) : undefined
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name={searching ? 'search' : tab === 'favorites' ? 'bookmark' : 'folder'} size={30} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>{searching ? 'No files match.' : EMPTY[tab]}</Text>
          </View>
        }
      />

      {selecting ? (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <EdgeFade solid="bottom" style={styles.fade} />
          <View style={[styles.actionBar, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}>
            <BarButton
              icon="share-2"
              label="Share"
              disabled={chosen.length !== 1}
              onPress={() => shareItem(chosen[0]).catch(reportLibraryError)}
            />
            <BarButton
              icon="bookmark"
              label={anyUnfavorite || !chosen.length ? 'Favorite' : 'Unfavorite'}
              disabled={!chosen.length}
              onPress={() => {
                void Haptics.selectionAsync();
                useLibrary.getState().setFavorite(chosen.map((i) => i.key), anyUnfavorite);
                endSelect();
              }}
            />
            <BarButton
              icon="trash-2"
              label="Delete"
              destructive
              disabled={!chosen.length}
              onPress={() => {
                removeFromLibrary(chosen);
                endSelect();
              }}
            />
          </View>
        </View>
      ) : (
        <KeyboardStickyView offset={{ opened: insets.bottom }} style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <EdgeFade solid="bottom" style={styles.fade} />
          <View style={[styles.search, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}>
            <Feather name="search" size={20} color={colors.textSecondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search Library"
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
      )}

      <ContextMenu anchor={menu?.anchor ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
      <LibraryFilterSheet
        visible={filterOpen}
        value={filters}
        onClose={() => setFilterOpen(false)}
        onApply={(f) => {
          setFilters(f);
          setFilterOpen(false);
        }}
      />
    </View>
  );
}

function BarButton({
  icon,
  label,
  onPress,
  disabled,
  destructive,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  const color = destructive ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [styles.barButton, (disabled || pressed) && { opacity: disabled ? 0.35 : 0.6 }]}
    >
      <Feather name={icon} size={20} color={color} />
      <Text style={[styles.barLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: 10, right: 11, width: 8, height: 8, borderRadius: 4 },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600' },
  pill: { minWidth: 48, height: 48, borderRadius: 24, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  pillText: { fontSize: 16, fontWeight: '500' },
  tabs: { flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  tab: { paddingHorizontal: 18, height: 42, borderRadius: 21, justifyContent: 'center' },
  tabText: { fontSize: 16, fontWeight: '600' },
  grid: { paddingHorizontal: 16, gap: GAP },
  list: { paddingHorizontal: 0 },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    marginBottom: 4,
    marginLeft: 0,
  },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 64, paddingHorizontal: 40 },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 32, paddingTop: 28 },
  fade: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 54,
    borderRadius: 27,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
  },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 0 },
  actionBar: {
    flexDirection: 'row',
    height: 64,
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
  },
  barButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  barLabel: { fontSize: 12, fontWeight: '500' },
});
