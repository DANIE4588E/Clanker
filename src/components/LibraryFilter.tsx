import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LibraryItem, LibraryKind } from '@/lib/library';
import { useTheme } from '@/lib/theme';
import { MenuGlyph, type MenuIcon } from './ContextMenu';

export type TypeFilter = 'image' | 'document' | 'pdf' | 'sheet' | 'slides' | 'site' | 'code' | 'other';
export type OwnerFilter = 'upload' | 'agent';
export type LibraryFilters = { types: TypeFilter[]; owners: OwnerFilter[] };

export const NO_FILTERS: LibraryFilters = { types: [], owners: [] };

const TYPES: { value: TypeFilter; label: string; icon: MenuIcon }[] = [
  { value: 'image', label: 'Images', icon: { feather: 'image' } },
  { value: 'document', label: 'Documents', icon: { feather: 'file-text' } },
  { value: 'pdf', label: 'PDFs', icon: { mci: 'file-pdf-box' } },
  { value: 'sheet', label: 'Spreadsheets', icon: { mci: 'table-large' } },
  { value: 'slides', label: 'Slides', icon: { mci: 'presentation' } },
  { value: 'site', label: 'Websites & apps', icon: { feather: 'globe' } },
  { value: 'code', label: 'Code', icon: { feather: 'code' } },
  { value: 'other', label: 'Other files', icon: { feather: 'file' } },
];

const OWNERS: { value: OwnerFilter; label: string; icon: MenuIcon }[] = [
  { value: 'upload', label: 'Uploaded by you', icon: { feather: 'user' } },
  { value: 'agent', label: 'Made by agents', icon: { mci: 'robot-outline' } },
];

const typeOf = (kind: LibraryKind): TypeFilter =>
  kind === 'text' ? 'document' : kind === 'media' || kind === 'archive' ? 'other' : kind;

export const filterCount = (f: LibraryFilters) => f.types.length + f.owners.length;

/** Whether the item passes the filters; an empty group lets everything through. */
export const passes = (item: LibraryItem, f: LibraryFilters) =>
  (!f.types.length || f.types.includes(typeOf(item.kind))) && (!f.owners.length || f.owners.includes(item.source));

const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

/** A bottom sheet for choosing which files the Library shows; the check applies the choice. */
export function LibraryFilterSheet({
  visible,
  value,
  onApply,
  onClose,
}: {
  visible: boolean;
  value: LibraryFilters;
  onApply: (filters: LibraryFilters) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(value);
  // Each time it opens it starts from what is applied.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setDraft(value);
  }

  const row = (label: string, icon: MenuIcon, on: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]}
    >
      <MenuGlyph icon={icon} size={22} color={colors.text} />
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {on && <Feather name="check" size={20} color={colors.accentText} />}
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} onPress={onClose} accessibilityLabel="Close filters" />
      <Animated.View
        entering={SlideInDown.duration(260).easing(Easing.bezier(0.23, 1, 0.32, 1).factory())}
        style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 8 }]}
      >
        <View style={[styles.grabber, { backgroundColor: colors.textTertiary }]} />
        <View style={styles.header}>
          <Pressable
            onPress={() => setDraft(NO_FILTERS)}
            disabled={!filterCount(draft)}
            hitSlop={8}
            style={[styles.side, !filterCount(draft) && { opacity: 0 }]}
          >
            <Text style={[styles.clear, { color: colors.textSecondary }]}>Clear</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Filters</Text>
          <View style={[styles.side, { alignItems: 'flex-end' }]}>
            <Pressable
              onPress={() => onApply(draft)}
              accessibilityLabel="Apply filters"
              style={({ pressed }) => [styles.apply, { backgroundColor: colors.sendBg }, pressed && { opacity: 0.7 }]}
            >
              <Feather name="check" size={22} color={colors.sendFg} />
            </Pressable>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
          <Text style={[styles.section, { color: colors.textTertiary }]}>Type</Text>
          {TYPES.map((t) =>
            row(t.label, t.icon, draft.types.includes(t.value), () => setDraft((d) => ({ ...d, types: toggle(d.types, t.value) })))
          )}
          <Text style={[styles.section, { color: colors.textTertiary }]}>Ownership</Text>
          {OWNERS.map((o) =>
            row(o.label, o.icon, draft.owners.includes(o.value), () => setDraft((d) => ({ ...d, owners: toggle(d.owners, o.value) })))
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, opacity: 0.5 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  side: { width: 72 },
  clear: { fontSize: 16 },
  title: { flex: 1, textAlign: 'center', fontSize: 22, fontWeight: '700' },
  apply: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 15, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, height: 54 },
  label: { flex: 1, fontSize: 17 },
});
