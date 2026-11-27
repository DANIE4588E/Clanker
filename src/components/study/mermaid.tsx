import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

/**
 * Mermaid diagrams are drawn once, in one hidden web view shared by every diagram (MermaidHost,
 * mounted at the root), and kept as SVG by source, in memory and on disk. A diagram on screen then
 * shows its SVG in a plain web view without scripts, rather than each loading Mermaid (megabytes
 * of script) for itself.
 */

// Pinned, with its Subresource Integrity hash (sha384 of exactly this file), so a changed copy
// on the CDN doesn't run.
export const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
export const MERMAID_INTEGRITY = 'sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I';
export const MERMAID_SCRIPT = `<script src="${MERMAID}" integrity="${MERMAID_INTEGRITY}" crossorigin="anonymous"></script>`;
export const MAX_HEIGHT = 520;
export const MIN_HEIGHT = 80;
export const LOAD_ERROR = 'Mermaid could not load. Check your connection.';
export const PAGE_ERROR = 'The page failed to load.';

const foreground = (dark: boolean) => (dark ? '#ECECEC' : '#0D0D0D');

/** The head of a diagram page, with the card's styles: the same for drawing, measuring and showing. */
export function pageHead(dark: boolean, zoom: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1${zoom ? ',maximum-scale=6,user-scalable=yes' : ',user-scalable=no'}">
<style>
html,body{margin:0;padding:0;background:transparent;color:${foreground(dark)};font-family:-apple-system,Roboto,sans-serif}
#d{display:flex;justify-content:center;align-items:flex-start;padding:${zoom ? '24px 12px' : '4px 0'}}
#d svg{max-width:100%!important;height:auto;${zoom ? '' : `max-height:${MAX_HEIGHT - 8}px;`}}
</style></head>`;
}

/** A drawn diagram as a page without scripts, laid out as on the card. */
export function svgPage(svg: string, dark: boolean) {
  return `${pageHead(dark, false)}<body><div id="d">${svg}</div></body></html>`;
}

// The renderer. Jobs come in through injected calls to __render and are drawn one at a time, each
// in a box as wide as its card (some diagrams size themselves to their container) and with the
// card page's colour, then measured in #d with the card's styles. Results go back as JSON.
const RENDERER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,Roboto,sans-serif}
#d{display:flex;justify-content:center;align-items:flex-start;padding:4px 0}
#d svg{max-width:100%!important;height:auto;max-height:${MAX_HEIGHT - 8}px;}
</style></head><body>
${MERMAID_SCRIPT}
<script>
(function(){
  var post=function(m){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(m))};
  var queue=[];var busy=false;var n=0;
  async function next(){
    if(busy)return;
    var job=queue.shift();
    if(!job)return;
    busy=true;
    var box=document.createElement('div');
    box.style.width=job.width+'px';
    box.style.color=job.dark?'${foreground(true)}':'${foreground(false)}';
    document.body.appendChild(box);
    try{
      if(typeof mermaid==='undefined') throw new Error(${JSON.stringify(LOAD_ERROR)});
      mermaid.initialize({startOnLoad:false,theme:job.dark?'dark':'default',securityLevel:'strict',fontFamily:'-apple-system,Roboto,sans-serif'});
      var out=await mermaid.render('m'+Date.now()+'_'+(n++),job.source,box);
      var d=document.createElement('div');
      d.id='d';
      box.appendChild(d);
      d.innerHTML=out.svg;
      post({id:job.id,ok:true,svg:out.svg,height:Math.ceil(d.getBoundingClientRect().height)});
    }catch(e){
      post({id:job.id,ok:false,error:String(e&&e.message||e)});
    }
    box.remove();
    busy=false;
    next();
  }
  window.__render=function(job){queue.push(job);next();};
  post({ready:true,loaded:typeof mermaid!=='undefined'});
})();
</script></body></html>`;

export type Drawn = { svg: string; height: number };
/**
 * `transient`: Mermaid or its page failed to load, which another try may not repeat. `seq` counts
 * such failures, so diagrams shown after one try again (see useMermaid).
 */
export type Failed = { error: string; transient?: boolean; seq?: number };
type Result = Drawn | Failed;
type Job = { id: number; key: string; source: string; dark: boolean; width: number };

const results = new Map<string, Result>();
// Keys being looked up on disk; jobs waiting for the renderer or being drawn, by key; and those
// sent to it, by id.
const checking = new Set<string>();
const queued = new Map<string, Job>();
const sent = new Map<number, Job>();
const listeners = new Set<() => void>();
let nextId = 1;
let failures = 0;
// How wide the renderer is laid out: as the cards it draws for.
let hostWidth = 0;

const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

// The host's sender while its web view is mounted: sends what's waiting once the page is ready.
let pump: (() => void) | null = null;

const keyOf = (source: string, dark: boolean, width: number) => `11.4.1|${dark ? 'd' : 'l'}|${width}|${source}`;

// ---- Disk cache ------------------------------------------------------------------------------------

const DISK_MAX = 120;
const diskDir = () => new Directory(Paths.cache, 'mermaid');

function fileOf(key: string) {
  // FNV-1a over the key; the key is kept in the file too, so a clash only misses.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return new File(diskDir(), `${h.toString(16)}-${key.length.toString(16)}.json`);
}

async function readDisk(key: string): Promise<Drawn | null> {
  try {
    const file = fileOf(key);
    if (!file.exists) return null;
    const saved = JSON.parse(await file.text());
    return saved?.key === key && typeof saved.svg === 'string' && typeof saved.height === 'number'
      ? { svg: saved.svg, height: saved.height }
      : null;
  } catch {
    return null;
  }
}

async function writeDisk(key: string, drawn: Drawn) {
  try {
    const dir = diskDir();
    dir.create({ intermediates: true, idempotent: true });
    await fileOf(key).write(JSON.stringify({ key, ...drawn }));
    const files = dir.list().filter((e): e is File => e instanceof File);
    if (files.length > DISK_MAX) {
      files.sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
      for (const f of files.slice(0, files.length - DISK_MAX)) f.delete();
    }
  } catch {
    // Only a cache.
  }
}

// ---- Requests ----------------------------------------------------------------------------------------

/** Has `source` drawn for a card `width` wide, unless it's drawn, on its way, or failed for good. */
function request(source: string, dark: boolean, width: number) {
  const key = keyOf(source, dark, width);
  const known = results.get(key);
  if ((known && !('transient' in known && known.transient)) || checking.has(key) || queued.has(key)) return;
  if (known) results.delete(key);
  checking.add(key);
  void readDisk(key).then((drawn) => {
    checking.delete(key);
    if (drawn) {
      results.set(key, drawn);
    } else {
      if (!pump) hostWidth = width;
      queued.set(key, { id: nextId++, key, source, dark, width });
    }
    notify();
    pump?.();
  });
}

function settle(job: Job, result: Result) {
  queued.delete(job.key);
  results.set(job.key, result);
  if ('svg' in result) void writeDisk(job.key, result);
  notify();
}

/** How many times Mermaid or its page has failed to load, for useMermaid's `since`. */
export const mermaidFailures = () => failures;

/**
 * The diagram as drawn for a card `width` wide (0 until it's measured): its SVG and height, the
 * error that stopped it, or null while it's drawn. A failure to load that came before `since` (a
 * count from mermaidFailures) is tried again.
 */
export function useMermaid(source: string, dark: boolean, width: number, since: number): Result | null {
  const key = width > 0 ? keyOf(source, dark, width) : null;
  const result = useSyncExternalStore(subscribe, () => (key ? results.get(key) : undefined));
  useEffect(() => {
    if (width > 0) request(source, dark, width);
  }, [source, dark, width]);
  if (!result) return null;
  if ('transient' in result && result.transient && (result.seq ?? 0) <= since) return null;
  return result;
}

// ---- Host --------------------------------------------------------------------------------------------

// The renderer is let go this long after its last job, freeing Mermaid's memory.
const IDLE_MS = 60_000;

/** The hidden web view that draws diagrams. Mounted once, at the root; it loads Mermaid only when a diagram needs it. */
export function MermaidHost() {
  const pending = useSyncExternalStore(subscribe, () => queued.size);
  const width = useSyncExternalStore(subscribe, () => hostWidth);
  // Kept a while after the last job, so the next diagram doesn't wait for Mermaid to load again.
  const [busy, setBusy] = useState(false);
  // Bumped to load the page again.
  const [generation, setGeneration] = useState(0);
  const ref = useRef<WebView<object>>(null);
  const ready = useRef(false);
  const on = (pending > 0 || busy) && width > 0;

  useEffect(() => {
    if (pending > 0 || !busy) return;
    const timer = setTimeout(() => setBusy(false), IDLE_MS);
    return () => clearTimeout(timer);
  }, [pending, busy]);

  useEffect(() => {
    if (!on) return;
    pump = () => {
      if (!ready.current) return;
      for (const job of queued.values()) {
        if (sent.has(job.id)) continue;
        sent.set(job.id, job);
        setBusy(true);
        ref.current?.injectJavaScript(
          `window.__render(${JSON.stringify({ id: job.id, source: job.source, dark: job.dark, width: job.width })});true;`
        );
      }
    };
    return () => {
      pump = null;
      ready.current = false;
      // Jobs being drawn go back in line for the next page.
      sent.clear();
    };
  }, [on, generation]);

  // Mermaid or its page didn't load: what's waiting fails, as each diagram's own page did, and the
  // web view goes until a diagram asks again rather than trying again and again.
  const failAll = (error: string) => {
    ready.current = false;
    sent.clear();
    const seq = ++failures;
    setBusy(false);
    setGeneration((g) => g + 1);
    for (const job of [...queued.values()]) settle(job, { error, transient: true, seq });
  };

  const restart = () => {
    ready.current = false;
    sent.clear();
    setGeneration((g) => g + 1);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let m: { ready?: boolean; loaded?: boolean; id?: number; ok?: boolean; svg?: string; height?: number; error?: string };
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (m.ready) {
      if (!m.loaded) return failAll(LOAD_ERROR);
      ready.current = true;
      pump?.();
      return;
    }
    const job = m.id != null ? sent.get(m.id) : undefined;
    if (!job) return;
    sent.delete(job.id);
    if (queued.get(job.key) !== job) return;
    if (m.ok && typeof m.svg === 'string') {
      settle(job, { svg: m.svg, height: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(m.height) || MIN_HEIGHT)) });
    } else {
      // A diagram Mermaid can't draw stays failed.
      settle(job, { error: String(m.error || 'The diagram could not be drawn.') });
    }
  };

  if (!on) return null;
  return (
    // Laid out as wide as the cards it draws for, but unseen; a couple of pixels high, as some
    // Android web views stop running timers in zero-size views.
    <View pointerEvents="none" style={[styles.host, { width }]}>
      <WebView<object>
        key={generation}
        ref={ref}
        source={{ html: RENDERER_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        onMessage={onMessage}
        onError={() => failAll(PAGE_ERROR)}
        onRenderProcessGone={restart}
        onContentProcessDidTerminate={restart}
        style={[styles.web, { width }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', height: 2, opacity: 0, left: 0, top: 0, overflow: 'hidden' },
  web: { height: 2, backgroundColor: 'transparent' },
});
