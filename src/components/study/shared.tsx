import Feather from '@expo/vector-icons/Feather';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { sendMessage } from '@/lib/chat';
import * as Haptics from '@/lib/haptics';
import { fonts, useTheme } from '@/lib/theme';
import { InlineMath } from '../MathView';

/** The chat a reply belongs to, so study cards in it can send the user's results back. */
const ReplyContext = createContext<string | null>(null);

export function ReplyProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  return <ReplyContext.Provider value={conversationId}>{children}</ReplyContext.Provider>;
}

/** Sends a message in the reply's chat as the user; null outside a chat (a plan or goal sheet). */
export function useFollowUp() {
  const conversationId = useContext(ReplyContext);
  const send = useCallback(
    (text: string) => {
      if (!conversationId) return;
      Haptics.selectionAsync();
      try {
        sendMessage(conversationId, text, []);
      } catch (e) {
        Alert.alert('Couldn’t send', e instanceof Error ? e.message : String(e));
      }
    },
    [conversationId]
  );
  return conversationId ? send : null;
}

// A card's progress outlives its view: long chats unmount rows that scroll away, and streamed text
// after a card re-renders it. Keyed by the block's text, which only changes when the card does.
const sticky = new Map<string, unknown>();
const STICKY_MAX = 200;

export function useSticky<T>(key: string, initial: () => T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (sticky.has(key) ? (sticky.get(key) as T) : initial()));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        sticky.delete(key);
        sticky.set(key, v);
        if (sticky.size > STICKY_MAX) sticky.delete(sticky.keys().next().value!);
        return v;
      });
    },
    [key]
  );
  return [value, set];
}

/** A short, stable key for a block's text. */
export function hashKey(prefix: string, text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${prefix}:${text.length}:${h >>> 0}`;
}

/** Text from a field the model may have written as a string, number or list of lines. */
export const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(str).filter(Boolean).join('\n') : '';

/**
 * Reads JSON a model wrote, forgiving trailing commas. TeX in $…$ often comes with single
 * backslashes, which JSON reads as escapes ("\theta" as a tab and "heta"), so they are doubled first.
 */
export function parseLoose(json: string): any {
  const fixed = json.replace(/\$[^$\n]*\$/g, (math) => math.replace(/(^|[^\\])\\(?=[a-zA-Z])/g, '$1\\\\'));
  for (const text of [fixed, fixed.replace(/,\s*([\]}])/g, '$1')]) {
    try {
      return JSON.parse(text);
    } catch {
      // Try the next repair.
    }
  }
  return null;
}

// Inline math, bold and code spans, the markdown study text uses most.
const RICH = /(\$[^$\n]+\$|\*\*[^*\n]+\*\*|`[^`\n]+`)/;

/** Text with $math$, **bold** and `code` drawn. */
export function RichText({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const parts = children.split(RICH);
  if (parts.length === 1) return <Text style={style}>{children}</Text>;
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 0 ? (
          part
        ) : part.startsWith('$') ? (
          <InlineMath key={i} tex={part.slice(1, -1)} />
        ) : part.startsWith('**') ? (
          <Text key={i} style={styles.bold}>
            {part.slice(2, -2)}
          </Text>
        ) : (
          <Text key={i} style={styles.code}>
            {part.slice(1, -1)}
          </Text>
        )
      )}
    </Text>
  );
}

export function StudyCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors, scheme } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { borderColor: colors.border, backgroundColor: scheme === 'dark' ? '#121212' : colors.background },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  active,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.icon, active && { backgroundColor: colors.surface }, pressed && { opacity: 0.5 }]}
    >
      <Feather name={icon} size={20} color={disabled ? colors.border : active ? colors.accentText : colors.textSecondary} />
    </Pressable>
  );
}

/** "‹ 2 of 5 ›", with the card's own buttons on the right. */
export function Pager({
  index,
  count,
  onChange,
  noun,
  right,
}: {
  index: number;
  count: number;
  onChange: (index: number) => void;
  noun: string;
  right?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.pager}>
      <IconButton icon="chevron-left" label={`Previous ${noun}`} disabled={index <= 0} onPress={() => onChange(index - 1)} />
      <Text style={[styles.count, { color: colors.textSecondary }]} accessibilityLabel={`${noun} ${index + 1} of ${count}`}>
        {index + 1} of {count}
      </Text>
      <IconButton icon="chevron-right" label={`Next ${noun}`} disabled={index >= count - 1} onPress={() => onChange(index + 1)} />
      <View style={styles.fill} />
      {right}
    </View>
  );
}

export function PillButton({
  title,
  onPress,
  primary,
  icon,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  icon?: keyof typeof Feather.glyphMap;
}) {
  const { colors } = useTheme();
  const fg = primary ? colors.background : colors.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.pill,
        primary ? { backgroundColor: colors.text, borderColor: colors.text } : { borderColor: colors.border },
        pressed && { opacity: 0.6 },
      ]}
    >
      {icon && <Feather name={icon} size={16} color={fg} />}
      <Text style={[styles.pillText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function CardTitle({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.title, { color: colors.textTertiary }]} numberOfLines={2}>
      {children}
    </Text>
  );
}

export const studyStyles = StyleSheet.create({
  fill: { flex: 1 },
});

const styles = StyleSheet.create({
  card: { borderRadius: 24, borderWidth: StyleSheet.hairlineWidth * 2, padding: 16, marginVertical: 10 },
  pager: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, marginHorizontal: -6 },
  count: { fontSize: 16, minWidth: 56, textAlign: 'center', fontVariant: ['tabular-nums'] },
  icon: { padding: 8, borderRadius: 18 },
  fill: { flex: 1 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  pillText: { fontSize: 15, fontWeight: '600' },
  bold: { fontWeight: '700' },
  code: { fontFamily: fonts.mono, fontSize: 15 },
  title: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
});
