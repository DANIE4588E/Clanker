import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '@/lib/theme';

/** How far the chat must be pulled up past its end, after resistance, to start a new chat on release. */
export const PULL_THRESHOLD = 84;
/** Pulled past its end the chat follows the finger at this fraction of the distance, up to PULL_MAX. */
export const PULL_RESISTANCE = 0.55;
export const PULL_MAX = 150;

const SIZE = 40;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Shown in the gap opened under the last message as the chat is pulled up past its end: a ring
 * that fills toward the point where letting go starts a new chat, then a solid new-chat button.
 */
export function PullNewChat({
  pull,
  armed,
  bottom,
}: {
  /** How far the chat is pulled up, after resistance. */
  pull: SharedValue<number>;
  /** Pulled far enough that letting go starts a new chat. */
  armed: SharedValue<boolean>;
  /** Where the gap starts from the bottom: the top of the composer. */
  bottom: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const armedProgress = useDerivedValue(() => withTiming(armed.get() ? 1 : 0, { duration: 140 }));

  const areaStyle = useAnimatedStyle(() => ({
    bottom: bottom.get(),
    height: Math.max(pull.get(), 0),
    opacity: interpolate(pull.get(), [12, 48], [0, 1], 'clamp'),
  }));
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(pull.get(), [12, PULL_THRESHOLD], [0.7, 1], 'clamp') }],
  }));
  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: CIRCUMFERENCE * (1 - Math.min(pull.get() / PULL_THRESHOLD, 1)),
  }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: 1 - armedProgress.get() }));
  const buttonStyle = useAnimatedStyle(() => ({
    opacity: armedProgress.get(),
    transform: [{ scale: 0.6 + 0.4 * armedProgress.get() }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.area, areaStyle]}>
      <Animated.View style={[styles.content, contentStyle]}>
        <View style={styles.mark}>
          <Animated.View style={[StyleSheet.absoluteFill, ringStyle]}>
            {/* Turned so the ring fills clockwise from the top. */}
            <Svg width={SIZE} height={SIZE} style={{ transform: [{ rotate: '-90deg' }] }}>
              <Circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke={colors.border} strokeWidth={STROKE} fill="none" />
              <AnimatedCircle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                stroke={colors.accent}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                fill="none"
                animatedProps={ringProps}
              />
            </Svg>
          </Animated.View>
          <Animated.View style={[styles.button, { backgroundColor: colors.accent }, buttonStyle]}>
            <Feather name="edit" size={18} color={colors.accentFg} />
          </Animated.View>
        </View>
        <Text style={[styles.label, { color: colors.textSecondary }]}>New chat</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  area: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  content: { alignItems: 'center', gap: 6 },
  mark: { width: SIZE, height: SIZE },
  button: {
    ...StyleSheet.absoluteFill,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 13 },
});
