import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '@/lib/theme';
import { useUI } from '@/store/ui';
import type { Workspace } from '@/lib/workspace';
import { FileIcon } from './FileIcon';

const HEIGHT = 260;

const release = () => useUI.getState().setWebTouch(false);

/** The Library's full-screen preview of a workspace file. */
export const openWorkspacePreview = (ws: Workspace, path: string) =>
  router.push({ pathname: '/library/file', params: { key: `f:${ws.key}:${path}` } });

/**
 * A web page an agent handed over, live and usable in the chat: a game, an app, a chart. Its
 * scripts, styles and images load from beside it in the workspace; script reads of other local
 * files stay off, so the page can't read the rest of the app's data.
 */
export function WebPreview({ ws, path }: { ws: Workspace; path: string }) {
  const { colors } = useTheme();
  const [reloads, setReloads] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const name = path.split('/').pop() ?? path;

  let uri: string | undefined;
  let modified = 0;
  try {
    const file = ws.fileAt(path);
    if (file.exists) {
      uri = file.uri;
      modified = file.modificationTime ?? 0;
    }
  } catch {
    uri = undefined;
  }

  // A touch that ends while this is gone (the chat closed under it) must not keep scrolling off.
  useEffect(() => release, []);

  if (!uri) return null;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View
        style={styles.page}
        onTouchStart={() => useUI.getState().setWebTouch(true)}
        onTouchEnd={release}
        onTouchCancel={release}
      >
        <WebView
          // Remade when the agent changes the file, or on reload.
          key={`${modified}:${reloads}`}
          source={{ uri }}
          originWhitelist={['*']}
          allowFileAccess
          allowingReadAccessToURL={ws.dir.uri}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled={false}
          mediaPlaybackRequiresUserAction
          setSupportMultipleWindows={false}
          nestedScrollEnabled
          overScrollMode="never"
          onLoadStart={() => {
            setLoading(true);
            setFailed(false);
          }}
          onLoadEnd={() => setLoading(false)}
          onError={() => setFailed(true)}
          style={styles.web}
        />
        {loading && !failed && (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator color="#8F8F8F" />
          </View>
        )}
        {failed && (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: colors.surface }]}>
            <Text style={{ color: colors.textSecondary }}>The page could not be shown.</Text>
          </View>
        )}
      </View>
      <View style={[styles.bar, { borderTopColor: colors.border }]}>
        <FileIcon name={name} size={28} />
        <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
          {name}
        </Text>
        <Pressable
          onPress={() => setReloads((n) => n + 1)}
          hitSlop={8}
          accessibilityLabel={`Reload ${name}`}
          style={({ pressed }) => [styles.icon, pressed && { opacity: 0.5 }]}
        >
          <Feather name="rotate-cw" size={18} color={colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={() => openWorkspacePreview(ws, path)}
          hitSlop={8}
          accessibilityLabel={`Open ${name} full screen`}
          style={({ pressed }) => [styles.icon, pressed && { opacity: 0.5 }]}
        >
          <Feather name="maximize-2" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  page: { height: HEIGHT, backgroundColor: '#FFFFFF' },
  web: { flex: 1, backgroundColor: '#FFFFFF' },
  center: { alignItems: 'center', justifyContent: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  name: { flex: 1, fontSize: 15, fontWeight: '600' },
  icon: { padding: 6 },
});
