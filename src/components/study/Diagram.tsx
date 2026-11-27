import Feather from '@expo/vector-icons/Feather';
import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useTheme } from '@/lib/theme';
import { CodeBlock } from '../CodeBlock';
import { MERMAID_SCRIPT, mermaidFailures, PAGE_ERROR, pageHead, svgPage, useMermaid } from './mermaid';

/** The page that draws `source` full screen, where it can be zoomed. */
function page(source: string, dark: boolean) {
  // As a JSON string, with "<" escaped so the diagram can't close the script.
  const src = JSON.stringify(source).replace(/</g, '\\u003c');
  return `${pageHead(dark, true)}<body><div id="d"></div>
${MERMAID_SCRIPT}
<script>
(async function(){
  try{
    if(typeof mermaid==='undefined') throw new Error('Mermaid could not load. Check your connection.');
    mermaid.initialize({startOnLoad:false,theme:${dark ? "'dark'" : "'default'"},securityLevel:'strict',fontFamily:'-apple-system,Roboto,sans-serif'});
    var out=await mermaid.render('m'+Date.now(),${src});
    document.getElementById('d').innerHTML=out.svg;
  }catch(e){}
})();
</script></body></html>`;
}

// Heights already measured, so a diagram scrolled back into view keeps its size at once.
const heights = new Map<string, number>();

function FullScreen({ source, dark, onClose }: { source: string; dark: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const html = useMemo(() => page(source, dark), [source, dark]);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.full, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.fullBar}>
          <Text style={[styles.fullTitle, { color: colors.textSecondary }]}>Pinch to zoom</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close diagram" style={[styles.close, { backgroundColor: colors.surface }]}>
            <Feather name="x" size={22} color={colors.text} />
          </Pressable>
        </View>
        <WebView
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled
          setBuiltInZoomControls
          setDisplayZoomControls={false}
          style={{ flex: 1, backgroundColor: 'transparent' }}
        />
      </View>
    </Modal>
  );
}

function DiagramInner({ source }: { source: string }) {
  const { colors, scheme } = useTheme();
  const dark = scheme === 'dark';
  const key = `${dark ? 'd' : 'l'}:${source}`;
  // The card's inner width, which the diagram is drawn and measured for (see ./mermaid).
  const [width, setWidth] = useState(0);
  // Failures to load Mermaid from before this card showed are tried again.
  const [since] = useState(mermaidFailures);
  const [pageError, setPageError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const result = useMermaid(source, dark, width, since);
  const drawn = result && 'svg' in result ? result : null;
  useEffect(() => {
    if (!drawn) return;
    heights.set(key, drawn.height);
    heights.set(source, drawn.height);
  }, [drawn, key, source]);
  // Until it's drawn: as tall as when last seen, or in the other theme (switching keeps the card's size).
  const height = drawn?.height ?? heights.get(key) ?? heights.get(source) ?? null;
  const error = pageError ?? (result && 'error' in result ? result.error : null);
  // The drawn SVG, shown without scripts.
  const html = useMemo(() => (drawn ? svgPage(drawn.svg, dark) : null), [drawn, dark]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setWidth(w);
  };

  if (error) {
    return (
      <View>
        <CodeBlock code={source} language="mermaid" findable />
        <Text style={[styles.error, { color: colors.textTertiary }]} numberOfLines={3}>
          Couldn’t draw this diagram: {error}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: dark ? '#121212' : colors.background }]}>
      <View style={{ height: height ?? 200 }} pointerEvents="none" onLayout={onLayout}>
        {html != null && (
          <WebView
            source={{ html }}
            originWhitelist={['*']}
            javaScriptEnabled={false}
            scrollEnabled={false}
            onError={() => setPageError(PAGE_ERROR)}
            style={styles.web}
          />
        )}
        {height == null && (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator color={colors.textTertiary} />
          </View>
        )}
      </View>
      {height != null && (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Open diagram full screen"
          style={StyleSheet.absoluteFill}
        >
          <View style={[styles.expand, { backgroundColor: colors.surface }]}>
            <Feather name="maximize-2" size={15} color={colors.textSecondary} />
          </View>
        </Pressable>
      )}
      {open && <FullScreen source={source} dark={dark} onClose={() => setOpen(false)} />}
    </View>
  );
}

/** A Mermaid diagram (flowchart, sequence, state, class, mind map…), tapped to open full screen. */
export const Diagram = memo(DiagramInner);

const styles = StyleSheet.create({
  card: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth * 2, padding: 12, marginVertical: 10, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: 'transparent' },
  center: { alignItems: 'center', justifyContent: 'center' },
  expand: { position: 'absolute', right: 10, top: 10, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  error: { fontSize: 13, marginTop: -4, marginBottom: 8 },
  full: { flex: 1 },
  fullBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  fullTitle: { fontSize: 14 },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
