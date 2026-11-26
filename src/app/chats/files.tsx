import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FileIcon } from '@/components/FileIcon';
import { attachmentUri } from '@/lib/attachments';
import { chatUploads, openUpload, shareUpload, type Upload } from '@/lib/chatExport';
import { useTheme } from '@/lib/theme';
import { formatSize } from '@/lib/workspace';
import { useChats } from '@/store/chats';

function report(e: unknown) {
  Alert.alert('Something went wrong', e instanceof Error ? e.message : String(e));
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The files and images the user attached in one chat, from the chat's menu. */
export default function ChatFilesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const messages = useChats((s) => (id ? s.conversations[id]?.messages : undefined));
  const uploads = useMemo(() => {
    const c = id ? useChats.getState().conversations[id] : undefined;
    return c && messages ? chatUploads({ ...c, messages }) : [];
  }, [id, messages]);

  const actions = (u: Upload) => {
    const share = () => shareUpload(u).catch(report);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: u.name, options: ['Share…', 'Cancel'], cancelButtonIndex: 1 }, (i) =>
        i === 0 ? share() : undefined
      );
    } else {
      Alert.alert(u.name, undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Share…', onPress: share },
      ]);
    }
  };

  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      data={uploads}
      keyExtractor={(u) => u.key}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Feather name="paperclip" size={28} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
            Files and photos you add to this chat show up here.
          </Text>
        </View>
      }
      renderItem={({ item, index }) => {
        const size = item.part.type === 'file' ? (item.part.size ?? item.part.text?.length) : undefined;
        return (
          <Pressable
            onPress={() => openUpload(item).catch(report)}
            onLongPress={() => actions(item)}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: colors.surface },
              index === 0 && styles.first,
              index === uploads.length - 1 && styles.last,
              index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
              pressed && { backgroundColor: colors.surfaceHover },
            ]}
          >
            <FileIcon name={item.name} uri={item.part.file ? attachmentUri(item.part.file) : undefined} size={36} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
                {item.name}
              </Text>
              <Text numberOfLines={1} style={[styles.detail, { color: colors.textTertiary }]}>
                {dateFormat.format(item.at)}
                {size != null ? ` · ${formatSize(size)}` : ''}
              </Text>
            </View>
            <Pressable onPress={() => actions(item)} hitSlop={10} accessibilityLabel="More actions">
              <Feather name="more-vertical" size={18} color={colors.textTertiary} />
            </Pressable>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  first: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  last: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  name: { fontSize: 16 },
  detail: { fontSize: 13, marginTop: 2 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 32 },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
