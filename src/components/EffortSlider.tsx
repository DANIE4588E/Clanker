import * as Haptics from '@/lib/haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { EFFORT_DRIFT, EFFORT_GLOW, EFFORT_GRADIENTS, effortTier, effortWordColor } from '@/lib/effortTheme';
import { describeEffort } from '@/lib/providers';
import { useTheme } from '@/lib/theme';

// ChatGPT's effort slider: a pill track with a fill that ends in a white knob, which snaps
// between one stop per level. Dots mark each stop. Past the everyday levels the fill charges
// up: it turns from blue to violet, fills with stars streaming left (faster the higher the
// level), a band of light drifts across it, and the track glows. All of it follows the knob,
// so dragging up fades the effect in rather than switching it on at a stop.
const HEIGHT = 72;
const PAD = 12;
const FILL = HEIGHT - PAD * 2;
const KNOB = 40;
const DOT = 10;
const SPRING = { damping: 22, stiffness: 320, mass: 0.8 };
const BAND = 0.45;

/** 0 → 1 as `heat` climbs from `from - 1` to `from`, so each tier fades in over the last. */
function ramp(heat: number, from: number) {
  'worklet';
  return Math.min(Math.max(heat - (from - 1), 0), 1);
}

/** `x` wrapped into [0, 1). */
function wrap(x: number) {
  'worklet';
  return x - Math.floor(x);
}

type Props = {
  levels: string[];
  value: string;
  onChange: (level: string) => void;
};

export function EffortSlider({ levels, value, onChange }: Props) {
  const { colors, scheme } = useTheme();
  const index = Math.max(0, levels.indexOf(value));
  // The stop under the finger mid-drag. It stays local so only the slider re-renders until
  // release, when it's committed through onChange.
  const [preview, setPreview] = useState<number | null>(null);
  const shown = preview ?? index;
  const last = levels.length - 1;
  const stop = (i: number) => (last > 0 ? i / last : 0);
  const tiers = useMemo(() => levels.map((l) => effortTier(levels, l)), [levels]);
  const tier = tiers[shown] ?? 0;
  const chargeable = tiers.some((t) => t > 0);

  // Knob position as a fraction of its travel, from the first stop (0) to the last (1).
  // Everything is laid out in percentages of the track, so the first frame is already in
  // place without waiting for a layout pass to learn the width.
  const pos = useSharedValue(stop(index));
  // The drag and the star field need pixels, which only exist once the track has been laid out.
  const width = useSharedValue(0);
  // The drag runs entirely on the UI thread; JS only hears about it when the stop changes.
  const dragging = useSharedValue(false);
  const current = useSharedValue(index);

  // How charged the fill looks, read off the knob: each stop's tier, blended in between.
  const heat = useDerivedValue(() => {
    if (last <= 0) return tiers[0] ?? 0;
    return interpolate(
      pos.value * last,
      tiers.map((_, i) => i),
      tiers,
      Extrapolation.CLAMP
    );
  });

  // The star clock: how far, in track widths, the sky has drifted left. It runs faster the
  // more charged the fill is, and stands still at the everyday levels.
  const drift = useSharedValue(0);
  const clock = useFrameCallback((frame) => {
    const dt = Math.min(frame.timeSincePreviousFrame ?? 16, 64) / 1000;
    const speed = interpolate(heat.value, [0, 1, 2, 3], EFFORT_DRIFT, Extrapolation.CLAMP);
    if (speed > 0) drift.set(drift.value + speed * dt);
  }, false);
  useEffect(() => {
    clock.setActive(chargeable);
    return () => clock.setActive(false);
    // clock is a fresh object each render but drives the same callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chargeable]);

  // Springs to a level picked outside a drag (accessibility actions); a drag has already put
  // the knob there by the time it commits.
  const placed = useRef(stop(index));
  useEffect(() => {
    current.set(index);
    const target = stop(index);
    if (placed.current === target || dragging.get()) return;
    placed.current = target;
    pos.set(withSpring(target, SPRING));
    // stop only changes with the level count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, last]);

  const hover = (i: number) => {
    // Reaching the top tier lands with a heavier tap than the other stops.
    if (tiers[i] === 3) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.selectionAsync();
    setPreview(i);
  };

  const commit = (i: number) => {
    placed.current = stop(i);
    if (levels[i] !== value) onChange(levels[i]);
    setPreview(null);
  };

  const track = (locationX: number, animate: boolean) => {
    'worklet';
    const travel = width.get() - PAD * 2 - FILL;
    const f = travel > 0 ? Math.min(Math.max((locationX - PAD - FILL / 2) / travel, 0), 1) : 0;
    pos.set(animate ? withSpring(f, SPRING) : f);
    const i = Math.round(f * last);
    if (i === current.get()) return;
    current.set(i);
    scheduleOnRN(hover, i);
  };

  const pan = usePanGesture({
    minDistance: 0,
    onBegin: (e) => {
      'worklet';
      dragging.set(true);
      track(e.x, true);
    },
    onUpdate: (e) => {
      'worklet';
      track(e.x, false);
    },
    onFinalize: () => {
      'worklet';
      dragging.set(false);
      pos.set(withSpring(last > 0 ? current.get() / last : 0, SPRING));
      scheduleOnRN(commit, current.get());
    },
  });

  // The fill is a pill-shaped window whose right end rides with the knob, sliding over paint
  // that stays put on the track, so the gradient and stars are revealed rather than stretched.
  // Each moving piece is as wide as the knob's travel, so a percentage translate (of its own
  // width) moves it exactly with the knob. The window stops at the first stop, so a spring
  // overshooting it never shrinks the fill smaller than its cap.
  const windowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: `${(Math.max(pos.value, 0) - 1) * 100}%` }] }));
  const paintStyle = useAnimatedStyle(() => ({ transform: [{ translateX: `${(1 - Math.max(pos.value, 0)) * 100}%` }] }));
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: `${pos.value * 100}%` }] }));
  const trackStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(heat.value, [0, 1, 3], [colors.chromeBorder, 'rgba(139,92,246,0.45)', 'rgba(176,128,255,0.9)']),
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(heat.value / 3, 0), 1) }));

  const [word, rest] = describeEffort(levels[shown] ?? value);

  return (
    <View>
      <Text style={[styles.label, { color: colors.text }]}>
        <Text style={{ color: effortWordColor(tier, scheme, colors) }}>{word}</Text> {rest}
      </Text>

      <View>
        {/* A halo behind the track that brightens with the charge and breathes while lit. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, glowStyle]}>
          <Animated.View
            style={[
              styles.glow,
              {
                backgroundColor: colors.surface,
                boxShadow: `0 0 22px 3px ${EFFORT_GLOW}`,
                animationName: BREATHE,
                animationDuration: 1800,
                animationIterationCount: 'infinite',
                animationDirection: 'alternate',
                animationTimingFunction: 'ease-in-out',
                animationPlayState: tier > 0 ? 'running' : 'paused',
              },
            ]}
          />
        </Animated.View>

        <GestureDetector gesture={pan}>
          <Animated.View
            onLayout={(e) => width.set(e.nativeEvent.layout.width)}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Effort"
            accessibilityValue={{ text: `${word} ${rest}` }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => {
              const i = Math.min(Math.max(index + (e.nativeEvent.actionName === 'increment' ? 1 : -1), 0), last);
              if (i === index) return;
              Haptics.selectionAsync();
              onChange(levels[i]);
            }}
            style={[styles.track, { backgroundColor: colors.surface }, trackStyle]}
          >
            <View style={styles.fillClip}>
              <Animated.View style={[styles.window, windowStyle]}>
                <View style={styles.windowShape}>
                  <Animated.View style={[styles.paintRun, paintStyle]}>
                    <View style={[styles.paint, { backgroundColor: colors.accent }]}>
                      {chargeable && (
                        <>
                          {([1, 2, 3] as const).map((t) => (
                            <GradientLayer key={t} tier={t} heat={heat} />
                          ))}
                          <Band heat={heat} drift={drift} width={width} />
                          {STARS.map((s, i) => (
                            <StarView key={i} star={s} heat={heat} drift={drift} width={width} />
                          ))}
                        </>
                      )}
                    </View>
                  </Animated.View>
                </View>
              </Animated.View>
            </View>
            <View style={styles.dots}>
              {levels.map((level, i) => (
                <Dot key={level} at={stop(i)} pos={pos} heat={heat} off={colors.textTertiary} />
              ))}
            </View>
            <Animated.View style={[styles.knobRun, knobStyle]}>
              <View style={styles.knob} />
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

// Native CSS gradients rather than SVG: they're sized by layout like any background, where an
// SVG at 100% inside this nest of offset views only painted a knob-wide strip on Android.
const GRADIENTS = {
  1: `linear-gradient(100deg, ${EFFORT_GRADIENTS[1].join(', ')})`,
  2: `linear-gradient(100deg, ${EFFORT_GRADIENTS[2].join(', ')})`,
  3: `linear-gradient(100deg, ${EFFORT_GRADIENTS[3].join(', ')})`,
} as const;

/** One tier's gradient across the whole track, faded in as the charge reaches that tier. */
function GradientLayer({ tier, heat }: { tier: 1 | 2 | 3; heat: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({ opacity: ramp(heat.value, tier) }));
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundImage: GRADIENTS[tier] }, style]} />;
}

/** A soft band of light drifting left across the fill, a little slower than the stars. */
function Band({ heat, drift, width }: { heat: SharedValue<number>; drift: SharedValue<number>; width: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const paint = Math.max(width.value - PAD * 2, 0);
    // Runs from just off the right edge to just off the left, then starts over.
    const x = wrap(0.7 - drift.value * 0.35) * (1 + BAND) - BAND;
    return {
      opacity: 0.35 + 0.65 * Math.min(Math.max((heat.value - 1) / 2, 0), 1),
      transform: [{ translateX: x * paint }],
    };
  });
  return <Animated.View pointerEvents="none" style={[styles.band, style]} />;
}

type Star = { x: number; y: number; size: number; tier: 1 | 2 | 3; depth: number; delay: number; duration: number };

// Deterministic scatter so the sky doesn't reshuffle between renders. Each tier adds more
// stars, and each star has a depth: nearer ones are larger, brighter and faster.
const STARS: Star[] = (() => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const counts = { 1: 8, 2: 10, 3: 14 } as const;
  const stars: Star[] = [];
  for (const t of [1, 2, 3] as const) {
    for (let i = 0; i < counts[t]; i++) {
      const depth = 0.6 + rand() * 0.8;
      stars.push({
        x: rand(),
        y: 5 + rand() * (FILL - 12),
        size: 1.2 + depth * (t === 3 ? 1.6 : 1.2),
        tier: t,
        depth,
        delay: Math.round(rand() * 1600),
        duration: Math.round(700 + rand() * 1100),
      });
    }
  }
  return stars;
})();

const TWINKLE = {
  from: { opacity: 0.35, transform: [{ scale: 0.7 }] },
  to: { opacity: 1, transform: [{ scale: 1.15 }] },
};

const BREATHE = {
  from: { opacity: 0.55 },
  to: { opacity: 1 },
};

/** A star streaming left across the paint, wrapping round to the right edge as it leaves. */
function StarView({
  star,
  heat,
  drift,
  width,
}: {
  star: Star;
  heat: SharedValue<number>;
  drift: SharedValue<number>;
  width: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const paint = Math.max(width.value - PAD * 2, 0);
    const x = wrap(star.x - drift.value * star.depth);
    // Fades at both ends so the wrap never pops.
    const edge = Math.min(1, x / 0.06, (1 - x) / 0.06);
    return {
      opacity: ramp(heat.value, star.tier) * edge,
      transform: [{ translateX: x * paint }],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.starRun, { top: star.y }, style]}>
      <Animated.View
        style={{
          width: star.size,
          height: star.size,
          borderRadius: star.size / 2,
          backgroundColor: '#FFFFFF',
          animationName: TWINKLE,
          animationDuration: star.duration,
          animationDelay: star.delay,
          animationIterationCount: 'infinite',
          animationDirection: 'alternate',
          animationTimingFunction: 'ease-in-out',
        }}
      />
    </Animated.View>
  );
}

/**
 * A stop marker, tinted to sit on the fill once the knob has passed it. On a charged fill
 * the passed markers fade away and leave the sky clear.
 */
function Dot({ at, pos, heat, off }: { at: number; pos: SharedValue<number>; heat: SharedValue<number>; off: string }) {
  const style = useAnimatedStyle(() => {
    const on = 0.35 * (1 - Math.min(Math.max(heat.value, 0), 1));
    return { backgroundColor: pos.value > at ? `rgba(255,255,255,${on})` : off };
  });
  return <Animated.View style={[styles.dot, style]} />;
}

const styles = StyleSheet.create({
  label: { fontSize: 24, fontWeight: '600', textAlign: 'center', marginBottom: 18 },
  track: { height: HEIGHT, borderRadius: HEIGHT / 2, borderWidth: StyleSheet.hairlineWidth },
  glow: { flex: 1, borderRadius: HEIGHT / 2 },
  fillClip: {
    position: 'absolute',
    left: PAD,
    right: PAD,
    top: PAD,
    height: FILL,
    borderRadius: FILL / 2,
    overflow: 'hidden',
  },
  // As wide as the knob's travel; slid back so its right edge sits on the knob centre.
  window: { position: 'absolute', left: 0, right: FILL, top: 0, height: FILL },
  // The visible fill: the window plus a round end under the knob.
  windowShape: {
    position: 'absolute',
    left: 0,
    right: -FILL,
    top: 0,
    height: FILL,
    borderRadius: FILL / 2,
    overflow: 'hidden',
  },
  // Counter-slides the paint so it stays fixed to the track while the window moves.
  paintRun: { position: 'absolute', left: 0, right: FILL, top: 0, height: FILL },
  // The full-track paint: accent base, tier gradients, band and stars.
  paint: { position: 'absolute', left: 0, right: -FILL, top: 0, height: FILL },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: `${BAND * 100}%`,
    backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.22) 50%, rgba(255,255,255,0) 100%)',
  },
  // Placed by translate from the paint's left edge; centred on its point by the negative margin.
  starRun: { position: 'absolute', left: 0, marginLeft: -2 },
  // Spaced so the dot centres land on the stops.
  dots: {
    position: 'absolute',
    left: PAD + FILL / 2 - DOT / 2,
    right: PAD + FILL / 2 - DOT / 2,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  // As wide as the knob's travel, with the knob at its left edge centred on the first stop.
  knobRun: {
    position: 'absolute',
    left: PAD + FILL / 2 - KNOB / 2,
    right: PAD + FILL / 2 + KNOB / 2,
    top: (HEIGHT - KNOB) / 2,
    height: KNOB,
  },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: '#FFFFFF' },
});
