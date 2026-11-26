import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { OverlayPortal } from '@/components/OverlayHost';
import type { Colors } from '@/lib/theme';
import { useTheme } from '@/lib/theme';

export type AttachAction = 'camera' | 'photos' | 'files' | 'plugins';

type Icon = keyof typeof Feather.glyphMap;

const ITEMS: { key: AttachAction; icon: Icon; label: string }[] = [
  { key: 'camera', icon: 'camera', label: 'Camera' },
  { key: 'photos', icon: 'image', label: 'Photos' },
  { key: 'files', icon: 'paperclip', label: 'Files' },
];

// Connected plugins, for browsing without typing "/" (see MentionMenu).
const SLASH_ITEMS: { key: AttachAction; icon: Icon; label: string }[] = [{ key: 'plugins', icon: 'grid', label: 'Plugins' }];

// Enter: strong ease-out so the card feels instant; exit: shorter, dismissal should be snappy.
const ENTER = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const EXIT = { duration: 140, easing: Easing.bezier(0.3, 0, 0.8, 0.6) };
// Fraction of the master progress each row trails the one before it, for a light cascade.
const ROW_STAGGER = 0.18;

type Props = {
  visible: boolean;
  /** Screen x of the plus button, which the card's left edge aligns with. */
  x: number;
  /** Screen distance from the top of the plus button down to the bottom of the screen. */
  bottom: number;
  onPick: (action: AttachAction) => void;
  onClose: () => void;
  /** Also lists plugins. */
  slash?: boolean;
};

/**
 * Popover anchored to the composer's plus button: the card fades/scales up from the button's
 * corner and its rows cascade in. Rendered in the root in-window overlay host (not a Modal, which
 * grabs focus and closes the keyboard, and not OverKeyboardView, whose separate Android
 * WindowManager panel breaks touch hit-testing on Samsung One UI / foldables). Because the card
 * floats above the composer (which already clears the keyboard), an in-window overlay paints
 * unclipped over the whole screen while leaving the keyboard exactly where it is.
 */
export function AttachmentMenu({ visible, x, bottom, onPick, onClose, slash = false }: Props) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  // Stay mounted through the exit animation; unmount only when it has played out.
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);

  // The layer hosts no activity of its own, so back must be routed here while the menu is up.
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

  // One master value drives everything, so reversing mid-open retargets smoothly.
  const cardStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [
      { translateY: interpolate(open.value, [0, 1], reduceMotion ? [8, 0] : [0, 0]) },
      { scale: interpolate(open.value, [0, 1], reduceMotion ? [1, 1] : [0.92, 1]) },
    ],
  }));

  if (!mounted) return null;
  const rows = slash ? [...ITEMS, ...SLASH_ITEMS] : ITEMS;
  // A longer menu cascades faster, so its last row still starts in time to finish with the card.
  const stagger = Math.min(ROW_STAGGER, 0.45 / Math.max(1, rows.length - 1));
  return (
    <OverlayPortal>
      {/* Transparent: it only catches taps outside the card. No dimming, like the reference. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        pointerEvents={visible ? 'auto' : 'none'}
        onPress={visible ? onClose : undefined}
        accessibilityLabel="Close attach menu"
      />
      <Animated.View
        pointerEvents={visible ? 'box-none' : 'none'}
        style={[styles.anchor, { bottom, left: x }, cardStyle]}
      >
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {rows.map((item, i) => (
            <Row
              key={item.key}
              label={item.label}
              icon={item.icon}
              start={i * stagger}
              open={open}
              reduceMotion={!!reduceMotion}
              onPress={() => {
                // Tear down at once before launching the native camera/gallery/file activity so
                // the overlay doesn't linger while the Activity pauses and resumes.
                open.set(0);
                setMounted(false);
                onPick(item.key);
              }}
              colors={colors}
            />
          ))}
        </View>
      </Animated.View>
    </OverlayPortal>
  );
}

function Row({
  label,
  icon,
  start,
  open,
  reduceMotion,
  onPress,
  colors,
}: {
  label: string;
  icon: Icon;
  /** Where on the master progress this row starts coming in. */
  start: number;
  open: SharedValue<number>;
  reduceMotion: boolean;
  onPress: () => void;
  colors: Colors;
}) {
  // Each row rides the master progress a little later: a light cascade, no extra timers,
  // and closing mid-cascade still retargets.
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(open.value, [start, Math.min(start + 0.55, 1)], [0, 1], Extrapolation.CLAMP),
    transform: [
      {
        translateY: interpolate(
          open.value,
          [start, Math.min(start + 0.55, 1)],
          reduceMotion ? [0, 0] : [10, 0],
          Extrapolation.CLAMP
        ),
      },
    ],
  }));
  return (
    <Animated.View style={style}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <View style={[styles.iconCircle, { backgroundColor: colors.surfaceHover }]}>
          <Feather name={icon} size={19} color={colors.text} />
        </View>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    // The card grows out of the plus button: transforms run from its bottom-left corner.
    transformOrigin: '0% 100%',
  },
  card: {
    borderRadius: 26,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  rowPressed: { opacity: 0.6, transform: [{ scale: 0.97 }] },  iconCircle: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 17, fontWeight: '500' },
});
