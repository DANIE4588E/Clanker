import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardController, KeyboardEvents, useGenericKeyboardHandler, type NativeEvent } from 'react-native-keyboard-controller';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { dailyTotals, useUsageEvents } from '@/lib/activity';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BrandIcon, type BrandId } from './BrandIcon';
import { useSuggestions } from '@/lib/suggestions';
import { useTheme } from '@/lib/theme';
import { useSettings } from '@/store/settings';

const SUGGESTION_COLORS = ['#4C8DF6', '#EA4335', '#34A853', '#F4B400'];

// About three months: one column per week.
const HEATMAP_WEEKS = 13;

/** Spare room a fitted block wants around it before it shows. */
const FIT_SLACK = 72;

/** Whether the keyboard is up or on its way up: true from the moment it starts to rise until it's fully down. */
function useKeyboardUp() {
  const [up, setUp] = useState(() => KeyboardController.isVisible());
  useEffect(() => {
    const subs = [
      KeyboardEvents.addListener('keyboardWillShow', () => setUp(true)),
      KeyboardEvents.addListener('keyboardDidHide', () => setUp(false)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return up;
}

type FittedProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  fitFadeOutDuration?: number;
  /**
   * Fades out as the keyboard starts to rise and back in as it lands, holding still where it
   * rests rather than riding the shrinking space up and down.
   */
  hideWithKeyboard?: boolean;
};

// Both fades use the same stretch of the keyboard's travel.
const KEYBOARD_FADE = 0.35;
const FIT_FADE_IN_DURATION = 220;

/**
 * Takes whatever room the suggestions leave and centres its content there, fading it out
 * while it doesn't fit whole rather than letting it spill under the header and the suggestions.
 */
function Fitted({ children, style, hideWithKeyboard, fitFadeOutDuration = 150 }: FittedProps) {
  const [room, setRoom] = useState(0);
  const [need, setNeed] = useState(0);
  const keyboardUp = useKeyboardUp();
  const progress = useSharedValue(keyboardUp ? 1 : 0);
  const trackKeyboard = (event: NativeEvent) => {
    'worklet';
    progress.set(event.progress);
  };
  useGenericKeyboardHandler({ onMove: trackKeyboard, onInteractive: trackKeyboard, onEnd: trackKeyboard }, []);

  const pinned = !!hideWithKeyboard;
  const measured = room > 0 && need > 0;
  // Needs some slack beyond its own height, so it's gone early rather than fading as the slot
  // starts clipping it.
  const fits = measured && room >= need + FIT_SLACK;
  const shown = fits && !(pinned && keyboardUp);

  const fitOpacity = useSharedValue(0);
  useEffect(() => {
    fitOpacity.value = withTiming(fits ? 1 : 0, { duration: fits ? FIT_FADE_IN_DURATION : fitFadeOutDuration });
  }, [fits, fitOpacity, fitFadeOutDuration]);
  // Pinned, the keyboard fade runs off the keyboard's own animation on the UI thread, frame for
  // frame with the space shrinking, so it never lags a JS keyboard event.
  const fade = useAnimatedStyle(() => ({
    opacity: pinned
      ? fitOpacity.value * interpolate(progress.value, [0, KEYBOARD_FADE], [1, 0], Extrapolation.CLAMP)
      : fitOpacity.value,
  }));

  return (
    <View
      style={styles.slot}
      onLayout={(e) => {
        // Pinned, only the keyboard-down room counts: the content keeps that place, centred,
        // however the slot shrinks while the keyboard is up.
        if (!pinned || progress.value === 0) setRoom(e.nativeEvent.layout.height);
      }}
    >
      {/* Laid out at its natural height, so it can be measured against the room it's given. */}
      <Animated.View
        pointerEvents={shown ? 'auto' : 'none'}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
        onLayout={(e) => setNeed(e.nativeEvent.layout.height)}
        style={[
          style,
          pinned && { position: 'absolute', left: 0, right: 0, top: Math.max(0, (room - need) / 2) },
          fade,
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

/** The last few months of token use, opening the Usage page. */
function RecentActivity({ hideWithKeyboard }: { hideWithKeyboard?: boolean }) {
  const events = useUsageEvents();
  const days = useMemo(() => dailyTotals(events), [events]);
  return (
    <Fitted style={styles.activity} hideWithKeyboard={hideWithKeyboard} fitFadeOutDuration={FIT_FADE_IN_DURATION}>
      <ActivityHeatmap days={days} weeks={HEATMAP_WEEKS} cell={16} caption onPress={() => router.push('/usage')} />
    </Fitted>
  );
}

type Props = {
  /** The remote backend the chat about to be started runs on; unset for the built-in agent. */
  remote?: string;
  /** The backend's brand mark, shown in place of the server glyph with friendly names on. */
  remoteBrand?: BrandId;
  hasEndpoint: boolean;
  onSuggestion: (text: string) => void;
  onAddEndpoint: () => void;
  onAddSubscription?: () => void;
  /** The chat about to be started is a temporary one, without memory. */
  memoryOff?: boolean;
  /** The name of the project the chat about to be started goes in. */
  project?: string;
};

export function EmptyState({ hasEndpoint, onSuggestion, onAddEndpoint, onAddSubscription, memoryOff, project, remote, remoteBrand }: Props) {
  const { colors } = useTheme();
  const { suggestions, loading, error } = useSuggestions(project, memoryOff);
  const activityCalendar = useSettings((s) => s.activityCalendar);
  const suggestionsOn = useSettings((s) => s.suggestions);

  if (!hasEndpoint) {
    return (
      <View style={styles.center}>
        <Text style={[styles.heading, { color: colors.text }]}>
          {remote ? `${remote} has no model yet` : 'Connect a model to start'}
        </Text>
        <View style={styles.ctaGroup}>
          {onAddSubscription && !remote && (
            <Pressable onPress={onAddSubscription} style={[styles.cta, { backgroundColor: colors.sendBg }]}>
              <Text style={[styles.ctaText, { color: colors.sendFg }]}>Connect a subscription</Text>
            </Pressable>
          )}
          <Pressable
            onPress={onAddEndpoint}
            style={[
              styles.cta,
              onAddSubscription && !remote
                ? { borderWidth: 1, borderColor: colors.border }
                : { backgroundColor: colors.sendBg },
            ]}
          >
            <Text style={[styles.ctaText, { color: onAddSubscription && !remote ? colors.text : colors.sendFg }]}>
              {remote ? 'Check the backend' : 'Add an API endpoint'}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {!!project && (
        <Fitted style={styles.temporary}>
          <Feather name="folder" size={22} color={colors.textSecondary} />
          <Text numberOfLines={2} style={[styles.temporaryTitle, { color: colors.text }]}>
            {project}
          </Text>
          <Text style={[styles.temporaryText, { color: colors.textTertiary }]}>
            {remote ? 'New remote chat in this project. Its instructions are sent to the backend; files and memory are managed on the remote device.' : memoryOff
              ? "A temporary chat in this project: it shares the project's files and instructions, but won't use or save memories."
              : "New chat in this project. It shares the project's files, sources and instructions."}
          </Text>
        </Fitted>
      )}
      {!!remote && !project && (
        <Fitted style={styles.temporary}>
          {remoteBrand ? <BrandIcon brand={remoteBrand} size={28} /> : <Feather name="server" size={22} color={colors.textSecondary} />}
          <Text numberOfLines={2} style={[styles.temporaryTitle, { color: colors.text }]}>
            {remote}
          </Text>
          <Text style={[styles.temporaryText, { color: colors.textTertiary }]}>
            Tools, files and memory live on that device. The chat stays on it after the first message.
          </Text>
        </Fitted>
      )}
      {memoryOff && !project && (
        <Fitted style={styles.temporary}>
          <Feather name="eye-off" size={22} color={colors.textSecondary} />
          <Text style={[styles.temporaryTitle, { color: colors.text }]}>Temporary chat</Text>
          <Text style={[styles.temporaryText, { color: colors.textTertiary }]}>
            This chat won&apos;t use or save memories, and other chats can&apos;t look it up.
          </Text>
        </Fitted>
      )}
      {activityCalendar && !project && !remote && !memoryOff && <RecentActivity hideWithKeyboard={suggestionsOn} />}
      {loading && (
        <Text style={[styles.status, styles.loading, { color: colors.textTertiary }]}>Generating suggestions…</Text>
      )}
      {error && !suggestions.length && (
        <Text style={[styles.status, styles.loading, { color: colors.textSecondary }]}>
          Suggestions unavailable. Please try again tomorrow.
        </Text>
      )}
      {suggestions.map((s, index) => (
        <Pressable
          key={s.summary}
          onPress={() => onSuggestion(s.prompt)}
          accessibilityRole="button"
          accessibilityLabel={s.summary}
          accessibilityHint="Adds the full prompt to your message for editing"
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.5 }]}
        >
          <Feather name={s.icon} size={22} color={SUGGESTION_COLORS[index]} />
          <Text numberOfLines={1} style={[styles.rowText, { color: colors.text }]}>
            {s.summary}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Clipped, so on the smallest screens the suggestions never slide under the header.
  container: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 26, paddingBottom: 14, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 20 },
  ctaGroup: { alignItems: 'center', gap: 10 },
  heading: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  cta: { borderRadius: 999, paddingHorizontal: 22, paddingVertical: 12 },
  ctaText: { fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingVertical: 14 },
  rowText: { fontSize: 17, flexShrink: 1 },
  status: { fontSize: 14, flexShrink: 1 },
  loading: { paddingVertical: 14 },
  slot: { flex: 1, justifyContent: 'center', overflow: 'hidden' },
  activity: { paddingVertical: 12 },
  temporary: { alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  temporaryTitle: { fontSize: 20, fontWeight: '600' },
  temporaryText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
