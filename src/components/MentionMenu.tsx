import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { BackHandler, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { FileIcon } from '@/components/FileIcon';
import { OverlayPortal } from '@/components/OverlayHost';
import { PluginTile } from '@/components/PluginIcon';
import { itemUri } from '@/lib/library';
import { SLASH_KINDS, type MentionOption, type MentionSection } from '@/lib/mentions';
import { useTheme, type Colors } from '@/lib/theme';

// Same motion as the composer's other popovers: a quick ease-out in, a shorter exit.
const ENTER = { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const EXIT = { duration: 120, easing: Easing.bezier(0.3, 0, 0.8, 0.6) };
const ICON = 32;

type Props = {
  visible: boolean;
  sections: MentionSection[];
  /** What has been typed after the "@" or "/", bolded where a name starts with it. */
  query: string;
  /** The composer box's left edge and width in the overlay host; the card spans the box. */
  left: number;
  width: number;
  /** Screen distance from the top of the composer down to the bottom of the screen. */
  bottom: number;
  maxHeight: number;
  /** Opened from the plus menu rather than by typing: a tap outside closes it. */
  modal?: boolean;
  onPick: (option: MentionOption) => void;
  onClose: () => void;
};

/**
 * The list of what an "@" or "/" can point at, floating above the composer while it's typed. It
 * lives in the root in-window overlay host like the composer's other popovers, so the keyboard
 * stays up. Typed, it takes no touches outside itself, so the text can still be tapped into.
 */
export function MentionMenu({ visible, sections, query, left, width, bottom, maxHeight, modal = false, onPick, onClose }: Props) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  // The list empties as the menu closes; the card keeps showing the last one through the exit.
  const [last, setLast] = useState({ sections, query, modal });
  if (visible && (last.sections !== sections || last.query !== query || last.modal !== modal)) {
    setLast({ sections, query, modal });
  }
  const shown = visible ? { sections, query, modal } : last;

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  const open = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      open.set(withTiming(1, ENTER));
      return;
    }
    if (mounted) {
      open.set(
        withTiming(0, EXIT, (finished) => {
          'worklet';
          if (finished) scheduleOnRN(setMounted, false);
        })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [
      { translateY: interpolate(open.value, [0, 1], [reduceMotion ? 0 : 8, 0]) },
      { scale: interpolate(open.value, [0, 1], reduceMotion ? [1, 1] : [0.97, 1]) },
    ],
  }));

  if (!mounted) return null;

  return (
    <OverlayPortal>
      {shown.modal && (
        <Pressable
          style={StyleSheet.absoluteFill}
          pointerEvents={visible ? 'auto' : 'none'}
          onPress={visible ? onClose : undefined}
          accessibilityLabel="Close"
        />
      )}
      <Animated.View
        pointerEvents={visible ? 'box-none' : 'none'}
        style={[styles.anchor, { left, width, bottom }, cardStyle]}
      >
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <SectionList
            sections={shown.sections}
            keyExtractor={(o) => o.key}
            // Taps pick at once, with the keyboard left up.
            keyboardShouldPersistTaps="always"
            stickySectionHeadersEnabled={false}
            initialNumToRender={14}
            style={{ maxHeight: Math.max(120, maxHeight) }}
            contentContainerStyle={styles.content}
            renderSectionHeader={({ section }) => (
              <Text style={[styles.section, { color: colors.textTertiary }]}>{section.title}</Text>
            )}
            renderItem={({ item }) => <Row option={item} query={shown.query} colors={colors} onPress={() => onPick(item)} />}
          />
        </View>
      </Animated.View>
    </OverlayPortal>
  );
}

function Row({ option, query, colors, onPress }: { option: MentionOption; query: string; colors: Colors; onPress: () => void }) {
  const slash = SLASH_KINDS.includes(option.kind);
  // The part of the name that was typed shows bold, the way it was matched.
  const name = slash ? option.title.slice(1) : option.title;
  const typed = query && name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]}
      accessibilityRole="button"
      accessibilityLabel={`${option.title}${option.subtitle ? `, ${option.subtitle}` : ''}`}
    >
      <OptionIcon option={option} colors={colors} />
      <View style={styles.texts}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {slash && '/'}
          {typed > 0 && <Text style={styles.typed}>{name.slice(0, typed)}</Text>}
          {name.slice(typed)}
        </Text>
        {!!option.subtitle && (
          <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textSecondary }]}>
            {option.subtitle}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function OptionIcon({ option, colors }: { option: MentionOption; colors: Colors }) {
  if (option.kind === 'plugin' && option.plugin) return <PluginTile id={option.plugin} size={ICON} />;
  if (option.kind === 'file') return <FileIcon name={option.label} size={ICON} />;
  if (option.kind === 'library' && option.item) return <FileIcon name={option.item.name} uri={itemUri(option.item)} size={ICON} />;
  const icon = option.kind === 'folder' ? 'folder' : (option.icon ?? 'hash');
  return (
    <View style={[styles.tile, { backgroundColor: colors.surfaceHover }]}>
      <Feather name={icon} size={16} color={colors.text} />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', transformOrigin: '50% 100%' },
  card: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  content: { paddingVertical: 6 },
  section: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 7, marginHorizontal: 4, borderRadius: 14 },
  tile: { width: ICON, height: ICON, borderRadius: ICON / 4, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, minWidth: 0 },
  title: { fontSize: 15 },
  typed: { fontWeight: '700' },
  subtitle: { fontSize: 13, marginTop: 1 },});
