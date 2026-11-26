import Feather from '@expo/vector-icons/Feather';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { CodeBlock } from '@/components/CodeBlock';
import { ContextMenu, type MenuAnchor } from '@/components/ContextMenu';
import { EdgeFade } from '@/components/EdgeFade';
import { FileIcon } from '@/components/FileIcon';
import { chatAbout, previewActions, reportLibraryError } from '@/components/LibraryActions';
import { formatLibraryDate } from '@/components/LibraryTile';
import { Markdown } from '@/components/Markdown';
import { itemFolderUri, itemUri, KIND_LABEL, libraryItems, openItemExternally, shareItem, workspaceItem, type LibraryItem } from '@/lib/library';
import { fonts, useTheme } from '@/lib/theme';
import { extractZipDocument, ZIP_DOCUMENT_EXT } from '@/lib/tools/documents';
import { formatSize } from '@/lib/workspace';
import { useChats } from '@/store/chats';

// Past these, a preview shows the start of the file: rendering more stalls the screen.
const MAX_TEXT_CHARS = 200_000;
const MAX_HIGHLIGHT_CHARS = 60_000;
// Office files are unzipped in memory to show their text; very large ones only open elsewhere.
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Files read as text in the preview, whatever their kind (a .csv is a sheet, a .json is code). */
const isTextual = (item: LibraryItem) =>
  item.kind === 'code' || item.kind === 'text' || /^(csv|tsv)$/.test(ext(item.name)) || (item.kind === 'site' && !itemUri(item));

/** The folder a file is in, which a page in a web view may read from (its scripts, its images). */
const folderOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/') + 1);

type Loaded = { text: string; clipped: boolean } | { error: string } | null;

/** The file's text, or its extracted text for Office documents, read off the UI's critical path. */
function useText(item: LibraryItem | undefined, wanted: 'text' | 'document' | null): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    if (!item || !wanted) return;
    let live = true;
    (async () => {
      let text: string;
      const inline = item.upload?.part.type === 'file' ? item.upload.part.text : undefined;
      const uri = itemUri(item);
      const file = uri ? new File(uri) : null;
      if (wanted === 'document') {
        if (!file?.exists) throw new Error('The file is no longer on this device.');
        if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`${formatSize(file.size)} is too large to preview here.`);
        text = extractZipDocument(item.name, await file.bytes());
      } else if (file?.exists) text = await file.text();
      else if (inline != null) text = inline;
      else throw new Error('The file is no longer on this device.');
      if (live) setLoaded({ text: text.slice(0, MAX_TEXT_CHARS), clipped: text.length > MAX_TEXT_CHARS });
    })().catch((e) => live && setLoaded({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [item, wanted]);
  return loaded;
}

/** A file with no preview here: what it is, and ways to open it elsewhere. */
function Fallback({ item, note }: { item: LibraryItem; note?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.fallback}>
      <FileIcon name={item.name} size={88} />
      <Text style={[styles.fallbackName, { color: colors.text }]} numberOfLines={3}>
        {item.name}
      </Text>
      <Text style={[styles.fallbackDetail, { color: colors.textTertiary }]}>
        {[KIND_LABEL[item.kind], item.size != null ? formatSize(item.size) : null, formatLibraryDate(item.at)].filter(Boolean).join(' · ')}
      </Text>
      {note && <Text style={[styles.fallbackNote, { color: colors.textSecondary }]}>{note}</Text>}
      <View style={styles.fallbackButtons}>
        <Pressable
          onPress={() => openItemExternally(item).catch(reportLibraryError)}
          style={({ pressed }) => [styles.button, { backgroundColor: colors.sendBg }, pressed && { opacity: 0.7 }]}
        >
          <Feather name="external-link" size={17} color={colors.sendFg} />
          <Text style={[styles.buttonText, { color: colors.sendFg }]}>Open with…</Text>
        </Pressable>
        <Pressable
          onPress={() => shareItem(item).catch(reportLibraryError)}
          style={({ pressed }) => [styles.button, { backgroundColor: colors.surface }, pressed && { opacity: 0.7 }]}
        >
          <Feather name="share-2" size={17} color={colors.text} />
          <Text style={[styles.buttonText, { color: colors.text }]}>Share</Text>
        </Pressable>
      </View>
    </View>
  );
}

function TextBody({ item, loaded, extracted, bottom }: { item: LibraryItem; loaded: Loaded; extracted: boolean; bottom: number }) {
  const { colors } = useTheme();
  if (!loaded) return <ActivityIndicator style={styles.loading} color={colors.textTertiary} />;
  if ('error' in loaded) return <Fallback item={item} note={loaded.error} />;
  const e = ext(item.name);
  const markdown = e === 'md' || e === 'markdown';
  // Text pulled out of a document, and plain text, read best as prose; the rest is code or data.
  const code = !markdown && !extracted && item.kind !== 'text';
  return (
    <ScrollView contentContainerStyle={[styles.textContent, { paddingBottom: bottom }]}>
      {markdown ? (
        <Markdown value={loaded.text} />
      ) : code && loaded.text.length <= MAX_HIGHLIGHT_CHARS ? (
        <CodeBlock code={loaded.text} language={e === 'tsv' ? 'csv' : e} />
      ) : (
        <Text selectable style={[styles.plain, { color: colors.text }, code && { fontFamily: fonts.mono, fontSize: 13 }]}>
          {loaded.text}
        </Text>
      )}
      {loaded.clipped && (
        <Text style={[styles.clipped, { color: colors.textTertiary }]}>Only the start of the file is shown. Open it elsewhere to see the rest.</Text>
      )}
    </ScrollView>
  );
}

/** A file from the Library, shown as well as the phone can: images, pages, text, code and documents. */
export default function LibraryFileScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const item = useMemo(() => {
    if (!key) return undefined;
    const { conversations } = useChats.getState();
    return libraryItems(conversations).find((i) => i.key === key) ?? workspaceItem(key, conversations);
  }, [key]);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [question, setQuestion] = useState('');
  const [broken, setBroken] = useState(false);

  const uri = item ? itemUri(item) : undefined;
  // Android's web view can't draw PDFs or Office files; iOS's can.
  const webDocument = Platform.OS === 'ios' && !!uri && (item?.kind === 'pdf' || ZIP_DOCUMENT_EXT.test(item?.name ?? '') || /\.(docx?|xlsx?|pptx?|rtf|key|pages|numbers)$/i.test(item?.name ?? ''));
  const extracted = !!item && !webDocument && ZIP_DOCUMENT_EXT.test(item.name);
  const loaded = useText(item, !item ? null : extracted ? 'document' : isTextual(item) ? 'text' : null);

  const bottom = insets.bottom + 96;

  const body = () => {
    if (!item) {
      return (
        <View style={styles.missing}>
          <Feather name="file" size={30} color={colors.textTertiary} />
          <Text style={[styles.missingText, { color: colors.textTertiary }]}>This file is no longer in your Library.</Text>
        </View>
      );
    }
    if (item.kind === 'image' && uri && !broken) {
      return (
        <ScrollView
          maximumZoomScale={5}
          minimumZoomScale={1}
          centerContent
          contentContainerStyle={{ flexGrow: 1, paddingBottom: bottom }}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image source={{ uri }} style={{ flex: 1, minHeight: 320 }} contentFit="contain" cachePolicy="none" onError={() => setBroken(true)} />
        </ScrollView>
      );
    }
    if ((item.kind === 'site' && uri) || webDocument) {
      const site = item.kind === 'site';
      const root = (site && itemFolderUri(item)) || folderOf(uri!);
      return (
        <View style={{ flex: 1, paddingBottom: bottom - 24 }}>
          <WebView
            source={{ uri: uri! }}
            originWhitelist={['*']}
            // A page's scripts, styles and images load from beside it. Script reads of other local
            // files stay off, so a page can't read the rest of the app's data.
            allowFileAccess
            allowingReadAccessToURL={root}
            javaScriptEnabled={site}
            domStorageEnabled={site}
            mediaPlaybackRequiresUserAction={false}
            setSupportMultipleWindows={false}
            style={{ flex: 1, backgroundColor: site ? '#FFFFFF' : colors.background }}
            onError={() => reportLibraryError(new Error('The page could not be shown.'))}
          />
        </View>
      );
    }
    if (extracted || isTextual(item)) return <TextBody item={item} loaded={loaded} extracted={extracted} bottom={bottom} />;
    if (item.kind === 'pdf') return <Fallback item={item} note="Open it in a PDF viewer to read it." />;
    return <Fallback item={item} />;
  };

  const ask = () => {
    const text = question.trim();
    if (!item || !text) return;
    setQuestion('');
    void chatAbout(item, text);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} accessibilityLabel="Back" style={[styles.round, { backgroundColor: colors.chrome }]}>
          <Feather name="arrow-left" size={22} color={colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {item?.name ?? 'File'}
        </Text>
        {item && (
          <Pressable
            onPress={(e: GestureResponderEvent) => setMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 16 })}
            accessibilityLabel="More options"
            style={[styles.round, { backgroundColor: colors.chrome }]}
          >
            <Feather name="more-vertical" size={22} color={colors.text} />
          </Pressable>
        )}
      </View>

      <View style={{ flex: 1 }}>{body()}</View>

      {item && (
        <KeyboardStickyView offset={{ opened: insets.bottom }} style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <EdgeFade solid="bottom" style={StyleSheet.absoluteFill} />
          <View style={[styles.ask, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}>
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask anything about this file"
              placeholderTextColor={colors.textTertiary}
              returnKeyType="send"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={ask}
              style={[styles.askInput, { color: colors.text }]}
            />
            {!!question.trim() && (
              <Pressable onPress={ask} accessibilityLabel="Ask" style={[styles.send, { backgroundColor: colors.sendBg }]}>
                <Feather name="arrow-up" size={20} color={colors.sendFg} />
              </Pressable>
            )}
          </View>
        </KeyboardStickyView>
      )}

      {item && <ContextMenu anchor={menu} items={previewActions(item, () => router.back())} onClose={() => setMenu(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingBottom: 12 },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 19, fontWeight: '600' },
  loading: { marginTop: 64 },
  textContent: { padding: 16 },
  plain: { fontSize: 15, lineHeight: 22 },
  clipped: { fontSize: 13, textAlign: 'center', marginTop: 16 },
  missing: { alignItems: 'center', gap: 12, paddingVertical: 80, paddingHorizontal: 40 },
  missingText: { fontSize: 15, textAlign: 'center' },
  fallback: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 64, gap: 8 },
  fallbackName: { fontSize: 19, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  fallbackDetail: { fontSize: 14 },
  fallbackNote: { fontSize: 15, textAlign: 'center', marginTop: 8 },
  fallbackButtons: { flexDirection: 'row', gap: 10, marginTop: 20 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 18, borderRadius: 23 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28 },
  ask: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 56,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 22,
    paddingRight: 8,
  },
  askInput: { flex: 1, fontSize: 17, paddingVertical: 12 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
