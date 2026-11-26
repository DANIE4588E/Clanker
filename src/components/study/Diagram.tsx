import Feather from '@expo/vector-icons/Feather';
import { memo, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useTheme } from '@/lib/theme';
import { CodeBlock } from '../CodeBlock';

// Mermaid draws in a web view; it loads from the CDN the first time and is cached after that.
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
const MAX_HEIGHT = 520;
const MIN_HEIGHT = 80;

/** The page that draws `source`: inline it fits the card and reports its height; full screen it can be zoomed. */
function page(source: string, dark: boolean, zoom: boolean) {
  // As a JSON string, with "<" escaped so the diagram can't close the script.
  const src = JSON.stringify(source).replace(/</g, '\\u003c');
  const fg = dark ? '#ECECEC' : '#0D0D0D';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1${zoom ? ',maximum-scale=6,user-scalable=yes' : ',user-scalable=no'}">
<style>
html,body{margin:0;padding:0;background:transparent;color:${fg};font-family:-apple-system,Roboto,sans-serif}
#d{display:flex;justify-content:center;align-items:flex-start;padding:${zoom ? '24px 12px' : '4px 0'}}
#d svg{max-width:100%!important;height:auto;${zoom ? '' : `max-height:${MAX_HEIGHT - 8}px;`}}
</style></head><body><div id="d"></div>
<script src="${MERMAID}"></script>
<script>
(async function(){
  var post=function(m){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(m))};
  try{
    if(typeof mermaid==='undefined') throw new Error('Mermaid could not load. Check your connection.');
    mermaid.initialize({startOnLoad:false,theme:${dark ? "'dark'" : "'default'"},securityLevel:'strict',fontFamily:'-apple-system,Roboto,sans-serif'});
    var out=await mermaid.render('m'+Date.now(),${src});
    var d=document.getElementById('d');
    d.innerHTML=out.svg;
    post({ok:true,height:Math.ceil(d.getBoundingClientRect().height)});
  }catch(e){
    post({ok:false,error:String(e&&e.message||e)});
  }
})();
</script></body></html>`;
}

// Heights already measured, so a diagram scrolled back into view keeps its size at once.
const heights = new Map<string, number>();

function FullScreen({ source, dark, onClose }: { source: string; dark: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const html = useMemo(() => page(source, dark, true), [source, dark]);
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
  const [height, setHeight] = useState<number | null>(heights.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const html = useMemo(() => page(source, dark, false), [source, dark]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.ok) {
        const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(m.height) || MIN_HEIGHT));
        heights.set(key, h);
        setHeight(h);
      } else setError(String(m.error || 'The diagram could not be drawn.'));
    } catch {
      // Not a message from the page.
    }
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
      <View style={{ height: height ?? 200 }} pointerEvents="none">
        <WebView
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled
          scrollEnabled={false}
          onMessage={onMessage}
          onError={() => setError('The page failed to load.')}
          style={styles.web}
        />
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
