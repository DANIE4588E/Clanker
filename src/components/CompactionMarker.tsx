import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COMPACT_HEADER, compactionAt, formatTokens, tokensOf } from '@/lib/context';
import * as Haptics from '@/lib/haptics';
import { useTheme } from '@/lib/theme';
import { useChats } from '@/store/chats';
import { Markdown } from './Markdown';

/**
 * A quiet line under the message where /compact summarised the chat: everything up to it reaches
 * the model only as the summary, which opens below the line.
 */
export function CompactionMarker({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const { colors } = useTheme();
  const block = useChats((s) => compactionAt(s.conversations[conversationId]?.compressions, messageId));
  const [open, setOpen] = useState(false);
  if (!block) return null;

  const summary = block.summary.startsWith(COMPACT_HEADER) ? block.summary.slice(COMPACT_HEADER.length).trim() : block.summary;
  const sizes = `${formatTokens(block.compacted ?? 0)} → ${formatTokens(tokensOf(block.summary))} tokens`;
  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setOpen(!open);
        }}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Chat compacted, ${sizes}. ${open ? 'Hide' : 'Show'} the summary`}
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.5 }]}
      >
        <View style={[styles.rule, { backgroundColor: colors.border }]} />
        <Feather name="minimize-2" size={13} color={colors.textTertiary} />
        <Text style={[styles.label, { color: colors.textTertiary }]}>Compacted · {sizes}</Text>
        <Feather
          name="chevron-down"
          size={13}
          color={colors.textTertiary}
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
        <View style={[styles.rule, { backgroundColor: colors.border }]} />
      </Pressable>
      {open && (
        <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.note, { color: colors.textTertiary }]}>
            From here on, the model sees the conversation above as this summary.
          </Text>
          <Markdown value={summary} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, marginVertical: 8, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  label: { fontSize: 13, fontVariant: ['tabular-nums'] },
  summary: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  note: { fontSize: 13 },
});
