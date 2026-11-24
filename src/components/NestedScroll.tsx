import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useSharedValue,
  withDecay,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { setStorageWriteDeferred } from '@/lib/storage';
import { InvertedScrollRelay } from '../../modules/clanker-scroll';

/**
 * Shared UI-thread handle to the outer inverted chat list, used on Android when the native
 * ClankerScroll view isn't in the build (e.g. Expo Go) to hand boundary drags and flings off
 * in the same direction as the finger.
 */
export type ChatScrollHandle = {
  ref: AnimatedRef<Animated.ScrollView>;
  offsetY: SharedValue<number>;
  contentHeight: SharedValue<number>;
  layoutHeight: SharedValue<number>;
  /** True while a nested scroll gesture or fling is actively driving the outer list. */
  driving: SharedValue<boolean>;
  /** Incremented whenever a new gesture or direct list scroll takes ownership of outer momentum. */
  flingToken: SharedValue<number>;
};

export const ChatScrollContext = createContext<ChatScrollHandle | null>(null);

/** True on Android builds without ClankerScroll (such as Expo Go), where JS/UI-thread relay takes over. */
export const useJsScrollRelay = Platform.OS === 'android' && !InvertedScrollRelay;

const EDGE_EPS = 2;
const TARGET_NONE = 0;
const TARGET_INNER = 1;
const TARGET_OUTER = 2;

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Keeps the end in view as the content grows, until the user drags away; dragging back to the end picks it up again. */
  follow?: boolean;
};

function RelayNestedScroll({
  chat,
  children,
  style,
  contentContainerStyle,
  follow,
}: Props & { chat: ChatScrollHandle }) {
  const innerRef = useAnimatedRef<Animated.ScrollView>();
  const deferredRef = useRef(false);

  const followSV = useSharedValue(!!follow);
  useEffect(() => {
    followSV.set(!!follow);
  }, [follow, followSV]);

  const setDeferred = useCallback((active: boolean) => {
    if (deferredRef.current === active) return;
    deferredRef.current = active;
    setStorageWriteDeferred(active);
  }, []);

  useEffect(() => () => setDeferred(false), [setDeferred]);

  const pinned = useSharedValue(true);
  const touching = useSharedValue(false);
  const innerY = useSharedValue(0);
  const innerContentH = useSharedValue(0);
  const innerLayoutH = useSharedValue(0);
  const prevAbsY = useSharedValue(0);
  // Per-gesture target lock: once a gesture starts scrolling inner, it stops at the inner edge
  // until the user lifts their finger and starts a new gesture at that boundary.
  const gestureTarget = useSharedValue(TARGET_NONE);

  // Counters bumped on UI-thread drag updates so reactions issue scrollTo without capturing refs in Gesture callbacks.
  const innerScrollTick = useSharedValue(0);
  const outerScrollTick = useSharedValue(0);

  const flingDelta = useSharedValue(0);
  const flingActive = useSharedValue(false);
  const flingTarget = useSharedValue(TARGET_NONE);
  const flingBase = useSharedValue(0);
  const flingMax = useSharedValue(0);
  const myFlingToken = useSharedValue(0);

  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      innerContentH.set(h);
    },
    [innerContentH],
  );

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      innerLayoutH.set(e.nativeEvent.layout.height);
    },
    [innerLayoutH],
  );

  // Keep follow-scroll and shrink clamping completely on the UI thread so rapid streaming token
  // flushes never do synchronous JS->UI SharedValue reads or bridge scrollTo calls.
  useAnimatedReaction(
    () => [innerContentH.get(), innerLayoutH.get()] as const,
    ([contentH, layoutH]) => {
      if (contentH <= 0 || layoutH <= 0) return;
      const max = Math.max(0, contentH - layoutH);
      if (touching.get() || flingActive.get()) return;
      if (followSV.get() && pinned.get()) {
        if (innerY.get() !== max) {
          innerY.set(max);
          scrollTo(innerRef, 0, max, false);
        }
      } else if (innerY.get() > max) {
        innerY.set(max);
        scrollTo(innerRef, 0, max, false);
      }
    },
  );

  useAnimatedReaction(
    () => innerScrollTick.get(),
    (tick, prev) => {
      if (prev === null || tick === prev) return;
      scrollTo(innerRef, 0, innerY.get(), false);
    },
  );

  useAnimatedReaction(
    () => outerScrollTick.get(),
    (tick, prev) => {
      if (prev === null || tick === prev) return;
      scrollTo(chat.ref, 0, chat.offsetY.get(), false);
    },
  );

  useAnimatedReaction(
    () => flingDelta.get(),
    (delta, prev) => {
      if (!flingActive.get() || delta === prev) return;
      const target = flingTarget.get();
      const max = flingMax.get();
      if (target === TARGET_INNER) {
        const raw = flingBase.get() + delta;
        const next = raw < 0 ? 0 : raw > max ? max : raw;
        if (next !== innerY.get()) {
          innerY.set(next);
          scrollTo(innerRef, 0, next, false);
        }
      } else if (target === TARGET_OUTER) {
        const raw = flingBase.get() - delta;
        const next = raw < 0 ? 0 : raw > max ? max : raw;
        if (next !== chat.offsetY.get()) {
          chat.offsetY.set(next);
          scrollTo(chat.ref, 0, next, false);
        }
      }
    },
  );

  useAnimatedReaction(
    () => chat.flingToken.get(),
    (token) => {
      if (flingActive.get() && token !== myFlingToken.get()) {
        flingActive.set(false);
        flingTarget.set(TARGET_NONE);
        cancelAnimation(flingDelta);
      }
    },
  );

  useAnimatedReaction(
    () => touching.get() || flingActive.get(),
    (busy, prev) => {
      if (busy === prev) return;
      scheduleOnRN(setDeferred, busy);
    },
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-5, 5])
        .failOffsetX([-10, 10])
        .onBegin((e) => {
          if (flingActive.get()) {
            flingActive.set(false);
            flingTarget.set(TARGET_NONE);
            cancelAnimation(flingDelta);
          }
          chat.flingToken.set(chat.flingToken.get() + 1);
          chat.driving.set(false);
          touching.set(true);
          gestureTarget.set(TARGET_NONE);
          prevAbsY.set(e.absoluteY);
        })
        .onStart((e) => {
          prevAbsY.set(e.absoluteY);
          gestureTarget.set(TARGET_NONE);
        })
        .onUpdate((e) => {
          // dy > 0: finger moving up (scrolling content down toward bottom).
          // dy < 0: finger moving down (scrolling content up toward top).
          const dy = -(e.absoluteY - prevAbsY.get());
          prevAbsY.set(e.absoluteY);
          if (dy === 0) return;

          const innerMax = Math.max(0, innerContentH.get() - innerLayoutH.get());
          let target = gestureTarget.get();
          if (target === TARGET_NONE) {
            const curInner = innerY.get();
            const atTop = curInner <= EDGE_EPS;
            const atBottom = curInner >= innerMax - EDGE_EPS;
            if ((dy > 0 && atBottom) || (dy < 0 && atTop)) {
              target = TARGET_OUTER;
              chat.driving.set(true);
            } else {
              target = TARGET_INNER;
              pinned.set(false);
            }
            gestureTarget.set(target);
          }

          if (target === TARGET_INNER) {
            const curInner = innerY.get();
            const rawInner = curInner + dy;
            const nextInner = rawInner < 0 ? 0 : rawInner > innerMax ? innerMax : rawInner;
            if (nextInner !== curInner) {
              innerY.set(nextInner);
              innerScrollTick.set(innerScrollTick.get() + 1);
            }
          } else if (target === TARGET_OUTER) {
            const outerMax = Math.max(0, chat.contentHeight.get() - chat.layoutHeight.get());
            const curOuter = chat.offsetY.get();
            const rawOuter = curOuter - dy;
            const nextOuter = rawOuter < 0 ? 0 : rawOuter > outerMax ? outerMax : rawOuter;
            if (nextOuter !== curOuter) {
              chat.offsetY.set(nextOuter);
              outerScrollTick.set(outerScrollTick.get() + 1);
            }
          }
        })
        .onEnd((e) => {
          const scrollVel = -e.velocityY;
          const innerMax = Math.max(0, innerContentH.get() - innerLayoutH.get());
          const outerMax = Math.max(0, chat.contentHeight.get() - chat.layoutHeight.get());
          let target = gestureTarget.get();

          if (target === TARGET_NONE && Math.abs(scrollVel) > 50) {
            const curInner = innerY.get();
            const atTop = curInner <= EDGE_EPS;
            const atBottom = curInner >= innerMax - EDGE_EPS;
            if ((scrollVel > 0 && atBottom) || (scrollVel < 0 && atTop)) {
              target = TARGET_OUTER;
            } else {
              target = TARGET_INNER;
              pinned.set(false);
            }
          }

          if (target === TARGET_INNER) {
            const baseInner = innerY.get();
            const minDelta = -baseInner;
            const maxDelta = Math.max(0, innerMax - baseInner);
            const canMove = (scrollVel > 0 && maxDelta > 0.5) || (scrollVel < 0 && minDelta < -0.5);
            chat.driving.set(false);
            if (Math.abs(scrollVel) > 50 && canMove) {
              const token = chat.flingToken.get() + 1;
              chat.flingToken.set(token);
              myFlingToken.set(token);
              flingBase.set(baseInner);
              flingMax.set(innerMax);
              flingTarget.set(TARGET_INNER);
              flingActive.set(false);
              flingDelta.set(0);
              flingActive.set(true);
              flingDelta.set(
                withDecay({ velocity: scrollVel, clamp: [minDelta, maxDelta], deceleration: 0.998 }, () => {
                  flingActive.set(false);
                  flingTarget.set(TARGET_NONE);
                  pinned.set(innerY.get() + innerLayoutH.get() >= innerContentH.get() - 24);
                }),
              );
            } else {
              pinned.set(baseInner + innerLayoutH.get() >= innerContentH.get() - 24);
            }
          } else if (target === TARGET_OUTER) {
            const baseOuter = chat.offsetY.get();
            // Positive delta decreases inverted outerOffsetY toward 0; negative delta increases toward outerMax.
            const minDelta = -Math.max(0, outerMax - baseOuter);
            const maxDelta = baseOuter;
            const canMove = (scrollVel > 0 && maxDelta > 0.5) || (scrollVel < 0 && minDelta < -0.5);
            if (Math.abs(scrollVel) > 50 && canMove) {
              const token = chat.flingToken.get() + 1;
              chat.flingToken.set(token);
              myFlingToken.set(token);
              flingBase.set(baseOuter);
              flingMax.set(outerMax);
              flingTarget.set(TARGET_OUTER);
              flingActive.set(false);
              flingDelta.set(0);
              chat.driving.set(true);
              flingActive.set(true);
              flingDelta.set(
                withDecay({ velocity: scrollVel, clamp: [minDelta, maxDelta], deceleration: 0.998 }, () => {
                  flingActive.set(false);
                  flingTarget.set(TARGET_NONE);
                  if (chat.flingToken.get() === token) {
                    chat.driving.set(false);
                  }
                }),
              );
            } else {
              chat.driving.set(false);
            }
          } else {
            chat.driving.set(false);
          }
        })
        .onFinalize((_, success) => {
          touching.set(false);
          gestureTarget.set(TARGET_NONE);
          if (!success && !flingActive.get()) {
            chat.driving.set(false);
          }
        }),
    [
      chat,
      flingActive,
      flingBase,
      flingDelta,
      flingMax,
      flingTarget,
      gestureTarget,
      innerContentH,
      innerLayoutH,
      innerScrollTick,
      innerY,
      myFlingToken,
      outerScrollTick,
      pinned,
      prevAbsY,
      touching,
    ],
  );

  return (
    <GestureDetector gesture={pan}>
      <Animated.ScrollView
        ref={innerRef}
        scrollEnabled={false}
        nestedScrollEnabled={false}
        style={style}
        contentContainerStyle={contentContainerStyle}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
      >
        {children}
      </Animated.ScrollView>
    </GestureDetector>
  );
}

/**
 * A height-capped vertical scroller for content inside a chat message (thoughts, tool output).
 * Only hands off to the outer inverted chat list when a drag starts already at the top or bottom
 * edge in that direction; mid-box drags stop at the edge until the user lifts and drags again.
 */
export function NestedScroll({ children, style, contentContainerStyle, follow = false }: Props) {
  const chat = useContext(ChatScrollContext);
  const scroll = useRef<ScrollViewInstance>(null);
  const pinned = useRef(true);
  const deferredRef = useRef(false);

  const setDeferred = useCallback((active: boolean) => {
    if (deferredRef.current === active) return;
    deferredRef.current = active;
    setStorageWriteDeferred(active);
  }, []);

  useEffect(() => () => setDeferred(false), [setDeferred]);

  if (useJsScrollRelay && chat) {
    return (
      <RelayNestedScroll chat={chat} style={style} contentContainerStyle={contentContainerStyle} follow={follow}>
        {children}
      </RelayNestedScroll>
    );
  }

  const settle = ({ nativeEvent: e }: NativeSyntheticEvent<NativeScrollEvent>) => {
    pinned.current = e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - 24;
    setDeferred(false);
  };

  const box = (
    <ScrollView
      ref={scroll}
      nestedScrollEnabled
      style={style}
      contentContainerStyle={contentContainerStyle}
      onContentSizeChange={() => follow && pinned.current && scroll.current?.scrollToEnd({ animated: false })}
      onScrollBeginDrag={() => {
        pinned.current = false;
        setDeferred(true);
      }}
      onScrollEndDrag={settle}
      onMomentumScrollEnd={settle}
    >
      {children}
    </ScrollView>
  );
  return InvertedScrollRelay ? <InvertedScrollRelay>{box}</InvertedScrollRelay> : box;
}
