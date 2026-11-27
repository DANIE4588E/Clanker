import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { useTheme } from '@/lib/theme';
import { messageText, useChats, type Message } from '@/store/chats';

// Each message's text, lowercased, worked out once: the matches are looked for again with every
// change to the chat (each streamed token) and every letter typed. Messages are replaced rather
// than changed, so a message's text holds for as long as it does.
const lowered = new WeakMap<Message, string>();

function lowerText(m: Message) {
  let text = lowered.get(m);
  if (text == null) lowered.set(m, (text = messageText(m).toLowerCase()));
  return text;
}

type Props = {
  conversationId: string;
  onClose: () => void;
  /** The text being looked for (trimmed, lowercased), and the message whose matches are in view. */
  onChange: (find: { needle: string; focusId: string | null }) => void;
};

/**
 * Find in chat, in place of the chat header: messages whose text holds the query, stepped through
 * newest first with the arrows. Shown only while finding, so the chat's text is only read then.
 */
export function FindBar({ conversationId, onClose, onChange }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const input = useRef<TextInputInstance>(null);
  const [query, setQuery] = useState('');
  // The match on screen, by message, so it stays put while a reply streams in below it.
  const [current, setCurrent] = useState<string | null>(null);

  // Only the ids of messages that match, so a streaming reply only re-renders this when they change.
  const needle = query.trim().toLowerCase();
  const matches = useChats(
    useShallow((s) =>
      needle
        ? (s.conversations[conversationId]?.messages ?? [])
            .filter((m) => lowerText(m).includes(needle))
            .map((m) => m.id)
        : []
    )
  );

  const index = useMemo(() => {
    const at = current ? matches.indexOf(current) : -1;
    return at >= 0 ? at : matches.length - 1;
  }, [current, matches]);
  const focused = index >= 0 ? matches[index] : null;

  useEffect(() => {
    onChange({ needle, focusId: focused });
  }, [needle, focused, onChange]);

  // Opened from a menu still closing: focusing at once can lose the keyboard to it on iOS.
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, []);

  const step = (by: number) => {
    if (!matches.length) return;
    setCurrent(matches[(index + by + matches.length) % matches.length]);
  };

  const circle = [styles.circle, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }];
  const arrow = (name: 'chevron-up' | 'chevron-down', by: number, label: string) => (
    <Pressable
      onPress={() => step(by)}
      disabled={matches.length < 2}
      hitSlop={4}
      style={({ pressed }) => [circle, matches.length < 2 && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
      accessibilityLabel={label}
    >
      <Feather name={name} size={22} color={colors.text} />
    </Pressable>
  );

  return (
    <View pointerEvents="box-none" style={[styles.bar, { paddingTop: insets.top + 6 }]}>
      <View style={[styles.field, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}>
        <Feather name="search" size={18} color={colors.textSecondary} />
        <TextInput
          ref={input}
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            // A new query starts again from the newest match.
            setCurrent(null);
          }}
          placeholder="Find in chat"
          placeholderTextColor={colors.textTertiary}
          returnKeyType="search"
          submitBehavior="submit"
          onSubmitEditing={() => step(-1)}
          autoCorrect={false}
          autoCapitalize="none"
          style={[styles.input, { color: colors.text }]}
          accessibilityLabel="Find in chat"
        />
        {!!needle && (
          <Text style={[styles.count, { color: colors.textSecondary }]}>
            {matches.length ? `${index + 1}/${matches.length}` : '0/0'}
          </Text>
        )}
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close find">
          <Feather name="x" size={20} color={colors.text} />
        </Pressable>
      </View>
      {arrow('chevron-up', -1, 'Previous match')}
      {arrow('chevron-down', 1, 'Next match')}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 8, gap: 8 },
  field: {
    flex: 1,
    height: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  count: { fontSize: 14, fontVariant: ['tabular-nums'] },
  circle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
