import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, Dimensions, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { OverlayPortal } from '@/components/OverlayHost';
import { useTheme } from '@/lib/theme';

// Same motion as the attach menu: a quick ease-out in, a shorter exit.
const ENTER = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const EXIT = { duration: 140, easing: Easing.bezier(0.3, 0, 0.8, 0.6) };
const CARD_WIDTH = 320;

type Props = {
  visible: boolean;
  /** Screen distance from the composer's right edge to the right of the screen; the card hangs from there. */
  right?: number;
  /** Given instead of `right`: screen distance from the left of the screen to the composer's left edge. */
  left?: number;
  /** Screen distance from the top of the composer down to the bottom of the screen. */
  bottom: number;
  /** Width of the overlay host, used to cap the card width accurately across fold states. */
  maxWidth?: number;
  onClose: () => void;
  /** Read out for the tap-anywhere backdrop that closes it. */
  closeLabel: string;
  children: ReactNode;
};

/**
 * A card popping up from one of the composer's corners, for the toolbar's gauges.
 * Lives in the root in-window overlay host (not a Modal, which grabs focus and closes the
 * keyboard, and not OverKeyboardView, which breaks touch hit-testing on some Android devices).
 */
export function ComposerPopover({ visible, right, left, bottom, maxWidth, onClose, closeLabel, children }: Props) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);

  // The layer hosts no activity of its own, so back must be routed here while it is up.
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
      { translateY: interpolate(open.value, [0, 1], reduceMotion ? [8, 0] : [0, 0]) },
      { scale: interpolate(open.value, [0, 1], reduceMotion ? [1, 1] : [0.92, 1]) },
    ],
  }));

  if (!mounted) return null;
  const width = Math.min(CARD_WIDTH, (maxWidth ?? Dimensions.get('window').width) - 24);

  return (
    <OverlayPortal>
      <Pressable
        style={StyleSheet.absoluteFill}
        pointerEvents={visible ? 'auto' : 'none'}
        onPress={visible ? onClose : undefined}
        accessibilityLabel={closeLabel}
      />
      <Animated.View
        pointerEvents={visible ? 'box-none' : 'none'}
        style={[
          styles.anchor,
          left !== undefined
            ? { bottom, left: Math.max(12, left), width, transformOrigin: '0% 100%' }
            : { bottom, right: Math.max(12, right ?? 0), width },
          cardStyle,
        ]}
      >
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
      </Animated.View>
    </OverlayPortal>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    // The card grows out of the toolbar, from the corner it hangs from (bottom-right by default).
    transformOrigin: '100% 100%',
  },
  card: {
    borderRadius: 22,
    padding: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
});
