import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Image } from 'expo-image';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { WebView } from 'react-native-webview';
import { itemFolderUri, itemUri, KIND_LABEL, type LibraryItem } from '@/lib/library';
import { useTheme } from '@/lib/theme';
import { fileKind } from './FileIcon';

type Props = {
  item: LibraryItem;
  favorite: boolean;
  /** Set while choosing files: whether this one is chosen. */
  selected?: boolean;
  onPress: (item: LibraryItem, e: GestureResponderEvent) => void;
  onLongPress: (item: LibraryItem, e: GestureResponderEvent) => void;
};

const thisYear = new Date().getFullYear();
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

export const formatLibraryDate = (at: number) => (new Date(at).getFullYear() === thisYear ? dayFormat : yearFormat).format(at);

const THUMB_HEIGHT = 116;

const thumbnailable = (item: LibraryItem) => item.kind === 'image';

// A page in a card is laid out at a phone's width, then scaled down to fit, so it looks as it will.
const PAGE_WIDTH = 390;

/** A web page drawn live and small, as its card's picture. Touches go to the card. */
function SiteThumb({ item, uri }: { item: LibraryItem; uri: string }) {
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const scale = width / PAGE_WIDTH;
  if (failed) {
    const kind = fileKind(item.name);
    return <MaterialCommunityIcons name={kind.icon} size={30} color={kind.color} />;
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.site]} pointerEvents="none" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <WebView
          source={{ uri }}
          originWhitelist={['*']}
          // Its scripts, styles and images load from beside it; scripts can't read other local files.
          allowFileAccess
          allowingReadAccessToURL={itemFolderUri(item) ?? uri.slice(0, uri.lastIndexOf('/') + 1)}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled={false}
          mediaPlaybackRequiresUserAction
          setSupportMultipleWindows={false}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          onError={() => setFailed(true)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: PAGE_WIDTH,
            height: THUMB_HEIGHT / scale,
            backgroundColor: '#FFFFFF',
            transformOrigin: 'top left',
            transform: [{ scale }],
          }}
        />
      )}
    </View>
  );
}

/** The picture on a card: the image itself, or the file type's glyph. */
function Thumb({ item, size }: { item: LibraryItem; size: number }) {
  const [broken, setBroken] = useState(false);
  if (item.kind === 'site' && size >= 30) {
    const page = itemUri(item);
    if (page) return <SiteThumb item={item} uri={page} />;
  }
  const uri = thumbnailable(item) ? itemUri(item) : undefined;
  if (uri && !broken) {
    return (
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        // Files an agent rewrites keep their uri, so a cached copy would go stale.
        cachePolicy="none"
        recyclingKey={uri}
        onError={() => setBroken(true)}
      />
    );
  }
  const kind = fileKind(item.name);
  return <MaterialCommunityIcons name={kind.icon} size={size} color={kind.color} />;
}

function Check({ selected }: { selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.check,
        selected ? { backgroundColor: colors.accent, borderColor: colors.accent } : { borderColor: colors.textTertiary },
      ]}
    >
      {selected && <Feather name="check" size={14} color={colors.accentFg} />}
    </View>
  );
}

/** A file as a card in the Library's grid. */
export const LibraryCard = memo(function LibraryCard({ item, favorite, selected, onPress, onLongPress }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={(e) => onPress(item, e)}
      onLongPress={(e) => onLongPress(item, e)}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${KIND_LABEL[item.kind]}`}
      accessibilityState={selected != null ? { selected } : undefined}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.chrome, borderColor: selected ? colors.accent : colors.chromeBorder },
        selected && styles.cardSelected,
        pressed && { opacity: 0.75 },
      ]}
    >
      <View style={[styles.thumb, { borderBottomColor: colors.chromeBorder }]}>
        <Thumb item={item} size={30} />
        {selected != null && (
          <View style={styles.checkCorner}>
            <Check selected={selected} />
          </View>
        )}
      </View>
      <View style={styles.caption}>
        <Text numberOfLines={1} style={[styles.cardName, { color: colors.text }]}>
          {item.name}
        </Text>
        <View style={styles.meta}>
          {favorite && <MaterialCommunityIcons name="bookmark" size={13} color={colors.textTertiary} />}
          <Text numberOfLines={1} style={[styles.cardKind, { color: colors.textTertiary }]}>
            {KIND_LABEL[item.kind]}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

/** A file as a row in the Library's list. */
export const LibraryRow = memo(function LibraryRow({ item, favorite, selected, onPress, onLongPress }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={(e) => onPress(item, e)}
      onLongPress={(e) => onLongPress(item, e)}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${KIND_LABEL[item.kind]}`}
      accessibilityState={selected != null ? { selected } : undefined}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]}
    >
      <View style={[styles.rowIcon, { borderColor: colors.chromeBorder, backgroundColor: colors.chrome }]}>
        <Thumb item={item} size={24} />
      </View>
      <View style={styles.rowText}>
        <Text numberOfLines={2} style={[styles.rowName, { color: colors.text }]}>
          {item.name}
        </Text>
        <View style={styles.meta}>
          {favorite && <MaterialCommunityIcons name="bookmark" size={13} color={colors.textTertiary} />}
          <Text numberOfLines={1} style={[styles.rowDate, { color: colors.textTertiary }]}>
            {formatLibraryDate(item.at)}
          </Text>
        </View>
      </View>
      {selected != null && <Check selected={selected} />}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  site: { overflow: 'hidden', backgroundColor: '#FFFFFF' },
  card: { flex: 1, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  cardSelected: { borderWidth: 2 },
  thumb: {
    height: THUMB_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  checkCorner: { position: 'absolute', top: 10, right: 10 },
  caption: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14, gap: 3 },
  cardName: { fontSize: 16, fontWeight: '600' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardKind: { fontSize: 13, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  rowIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rowText: { flex: 1, gap: 3 },
  rowName: { fontSize: 16 },
  rowDate: { fontSize: 13 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
