import { useContext, useMemo, type ReactNode } from 'react';
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native';
import { DrawerGestureContext } from 'react-native-drawer-layout';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useUI } from '@/store/ui';

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
};

// The gesture handlers below run on the UI thread, where the store isn't — they hop back to JS to reach it.
const touchOn = () => useUI.getState().setHScrollTouch(true);
const touchOff = () => useUI.getState().setHScrollTouch(false);

/**
 * A sideways scroller for content wider than the screen (code, tables). The drawer opens on a
 * horizontal swipe across half the screen, which would otherwise take the swipe first: a finger
 * here pauses the drawer swipe till it lifts (the effort slider pauses it the same way), and the
 * drawer also waits for this scroller to pass on the touch once scrolling actually starts.
 */
export function HorizontalScroll({ children, style, contentContainerStyle }: Props) {
  // Typed as the new gesture API's PanGesture, but the drawer builds it with the legacy one.
  const drawer = useContext(DrawerGestureContext) as unknown as GestureType | undefined;
  const native = useMemo(() => {
    const gesture = Gesture.Native();
    return drawer ? gesture.blocksExternalGesture(drawer) : gesture;
  }, [drawer]);
  // Fires as the finger lands, before either the drawer or this scroller decides who wins, so
  // there's no race. It never activates itself — nothing drags 10000px — so the scroll, the
  // long-press menu and the selection drag all carry on untouched.
  const watcher = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(1e4)
        .onBegin(() => {
          'worklet';
          runOnJS(touchOn)();
        })
        .onFinalize(() => {
          'worklet';
          runOnJS(touchOff)();
        }),
    [],
  );

  return (
    <GestureDetector gesture={watcher}>
      <GestureDetector gesture={native}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={style}
          contentContainerStyle={contentContainerStyle}
        >
          {children}
        </ScrollView>
      </GestureDetector>
    </GestureDetector>
  );
}
