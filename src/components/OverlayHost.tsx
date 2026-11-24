import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Dimensions, StyleSheet, View, type HostInstance } from 'react-native';
import { create } from 'zustand';

type Entry = { id: string; node: ReactNode };

const useOverlay = create<{ entries: Entry[] }>()(() => ({ entries: [] }));

let hostView: HostInstance | null = null;

export type OverlayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  hostWidth: number;
  hostHeight: number;
};

/**
 * Measures `target` in the coordinate space of the root OverlayHost so anchored popovers align
 * accurately regardless of status/navigation bar insets, taskbars, display zoom, or fold state.
 */
export function measureInOverlay(target: HostInstance | null, onMeasured: (rect: OverlayRect) => void) {
  if (!target) return;
  const host = hostView;
  if (!host) {
    target.measureInWindow((tx, ty, tw, th) => {
      const win = Dimensions.get('window');
      onMeasured({ x: tx, y: ty, width: tw, height: th, hostWidth: win.width, hostHeight: win.height });
    });
    return;
  }
  host.measureInWindow((hx, hy, hw, hh) => {
    target.measureInWindow((tx, ty, tw, th) => {
      const win = Dimensions.get('window');
      const hostWidth = hw > 0 ? hw : win.width;
      const hostHeight = hh > 0 ? hh : win.height;
      onMeasured({
        x: hw > 0 ? tx - hx : tx,
        y: hh > 0 ? ty - hy : ty,
        width: tw,
        height: th,
        hostWidth,
        hostHeight,
      });
    });
  });
}

function setEntry(id: string, node: ReactNode | null) {
  useOverlay.setState((s) => {
    if (node == null) {
      if (!s.entries.some((e) => e.id === id)) return s;
      return { entries: s.entries.filter((e) => e.id !== id) };
    }
    const idx = s.entries.findIndex((e) => e.id === id);
    if (idx < 0) return { entries: [...s.entries, { id, node }] };
    const next = s.entries.slice();
    next[idx] = { id, node };
    return { entries: next };
  });
}

/**
 * Renders `children` into the root OverlayHost inside the main Activity window. Unlike Modal, it
 * does not take focus or dismiss the keyboard; unlike OverKeyboardView, it stays in the regular
 * React Native view hierarchy so Android touch hit-testing stays reliable across OEMs and foldables.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const id = useId();
  useLayoutEffect(() => {
    setEntry(id, children);
  }, [id, children]);
  useLayoutEffect(() => () => setEntry(id, null), [id]);
  return null;
}

/** Mount once, at the root, above the navigator stack and below DialogHost. */
export function OverlayHost() {
  const entries = useOverlay((s) => s.entries);
  const ref = useRef<HostInstance>(null);

  useEffect(() => {
    const node = ref.current;
    hostView = node;
    return () => {
      if (hostView === node) hostView = null;
    };
  }, []);

  return (
    <View ref={ref} collapsable={false} pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.host]}>
      {entries.map((e) => (
        <View key={e.id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {e.node}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    zIndex: 1000,
  },
});
