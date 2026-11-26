import Feather from '@expo/vector-icons/Feather';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type FlatListProps,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedRef,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type LayoutAnimationFunction,
  type SharedValue,
} from 'react-native-reanimated';
import { setStorageWriteDeferred } from '@/lib/storage';
import { useTheme } from '@/lib/theme';
import { useChats, type Message } from '@/store/chats';
import { MessageBubble } from './MessageBubble';
import { ChatScrollContext, useJsScrollRelay, type ChatScrollHandle } from './NestedScroll';

const NO_MESSAGES: Message[] = [];
const LIST_PADDING_TOP = 12;
const BOTTOM_STICK_THRESHOLD = 24;
// Always keep maintainVisibleContentPosition non-null from mount so ScrollView sets
// collapsableChildren={false} and never flattens cells or virtualization spacers.
// - At the bottom (offset <= 24): minIndexForVisible 0 anchors to item 0's fixed bottom-in-screen
//   edge, so scrollY stays 0 and follows new content smoothly.
// - Scrolled up (offset > 24): minIndexForVisible 1 anchors above item 0 (to item 1, the
//   virtualization spacer, or ListFooterComponent), shifting scrollY synchronously on the UI
//   thread inside Fabric's didMountItems with zero drift and zero jitter—even when item 0 alone
//   is taller than the screen.
const MAINTAIN_AT_BOTTOM = { minIndexForVisible: 0 };
const MAINTAIN_SCROLLED_UP = { minIndexForVisible: 1 };
const LIST_FOOTER = <View style={{ height: 1 }} />;
// Streaming line-wrap glide: max distance a cell may trail its real position, and the largest
// single shift still treated as a line wrap rather than a snap.
const MAX_GLIDE_LAG = 36;
const MAX_GLIDE_JUMP = 120;

const CellLayoutContext = createContext<LayoutAnimationFunction | null>(null);

/**
 * Custom FlatList cell wrapper that attaches a synchronous Fabric layout transition so cells
 * glide upward in lockstep on the exact frame a streaming reply wraps to a new line, with zero
 * 1-frame jump or bounce.
 */
type SmoothCellProps = ComponentProps<NonNullable<FlatListProps<Message>['CellRendererComponent']>>;

function SmoothCell({ style, onLayout, onFocusCapture, children }: SmoothCellProps) {
  const cellLayout = useContext(CellLayoutContext);
  return (
    <Animated.View
      layout={cellLayout ?? undefined}
      style={style}
      onLayout={onLayout}
      onFocusCapture={onFocusCapture}
    >
      {children}
    </Animated.View>
  );
}

// VirtualizedList clones the element from renderScrollComponent and replaces its ref, so we
// merge VirtualizedList's ref with our Reanimated AnimatedRef here.
function RelayScrollView({
  ref,
  animatedRef,
  ...props
}: ScrollViewProps & {
  ref?: Ref<ScrollView>;
  animatedRef: AnimatedRef<Animated.ScrollView>;
}) {
  const mergedRef = useCallback(
    (node: Animated.ScrollView | null) => {
      animatedRef(node);
      if (typeof ref === 'function') ref(node as unknown as ScrollView | null);
      else if (ref && typeof ref === 'object') (ref as { current: ScrollView | null }).current = node as unknown as ScrollView | null;
    },
    [animatedRef, ref],
  );
  return <Animated.ScrollView {...props} ref={mergedRef} />;
}

type Props = {
  conversationId: string;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
  onBranch?: (messageId: string) => void;
  /** A reply is running, so the chat's messages can't be changed. */
  busy?: boolean;
  // Heights of the header and composer floating over the list, so content rests clear of them.
  // The composer's is a shared value: it follows the box's expand animation on the UI thread.
  topInset: number;
  bottomInset: SharedValue<number>;
};

export const MessageList = memo(function MessageList({ conversationId, onRegenerate, onEdit, onBranch, busy, topInset, bottomInset }: Props) {
  const { colors } = useTheme();
  const messages = useChats((s) => s.conversations[conversationId]?.messages ?? NO_MESSAGES);
  const listRef = useRef<FlatList<Message>>(null);
  const [scrollState, setScrollState] = useState({ id: conversationId, pinned: true, showJump: false });
  const pinnedToBottom = scrollState.id === conversationId ? scrollState.pinned : true;
  const showJump = scrollState.id === conversationId ? scrollState.showJump : false;
  // Inverted list: index 0 is the newest message and offset 0 is the bottom.
  const data = useMemo(() => [...messages].reverse(), [messages]);
  const lastAssistantId = data.find((m) => m.role === 'assistant')?.id;

  const isStreaming = data[0]?.role === 'assistant' && data[0]?.status === 'streaming';
  const reduceMotion = useReducedMotion();
  const pinnedSV = useSharedValue(true);
  const draggingSV = useSharedValue(false);
  const streamingSV = useSharedValue(isStreaming);
  const reduceMotionSV = useSharedValue(reduceMotion);

  useEffect(() => {
    streamingSV.set(isStreaming);
  }, [isStreaming, streamingSV]);

  useEffect(() => {
    reduceMotionSV.set(reduceMotion);
  }, [reduceMotion, reduceMotionSV]);

  useEffect(() => {
    pinnedSV.set(true);
    draggingSV.set(false);
  }, [conversationId, draggingSV, pinnedSV]);

  // Runs synchronously inside Fabric's mount transaction before paint, so both the growing
  // streaming cell (dh > 0, dy = 0) and every older message above it (dy > 0, dh = 0) start at
  // their exact pre-layout screen position and glide upward together with zero gap and zero jump.
  const cellLayout = useMemo<LayoutAnimationFunction>(
    () => (values) => {
      'worklet';
      if (!pinnedSV.get() || draggingSV.get() || !streamingSV.get() || reduceMotionSV.get()) {
        return { initialValues: {}, animations: {} };
      }
      if (Math.abs(values.targetWidth - values.currentWidth) > 0.5) {
        return { initialValues: {}, animations: {} };
      }
      // current* is the in-flight animated frame when a glide is interrupted, so topJump already
      // includes whatever lag is left over from the previous line.
      const dy = values.targetOriginY - values.currentOriginY;
      const dh = values.targetHeight - values.currentHeight;
      const topJump = dy + dh;
      if (topJump <= 0.5 || dh < -0.5) {
        return { initialValues: {}, animations: {} };
      }
      // Big shifts (a new message, a large block landing at once) aren't line wraps: snap so the
      // list stays glued to the bottom instead of sliding content in from behind the composer.
      if (topJump > MAX_GLIDE_JUMP) {
        return { initialValues: {}, animations: {} };
      }
      // Never trail the real position by more than ~1.5 lines, otherwise fast streams keep
      // restarting the glide and the newest text stays hidden under the composer.
      const lag = Math.min(topJump, MAX_GLIDE_LAG);
      return {
        initialValues: { originY: values.targetOriginY - lag },
        animations: {
          originY: withTiming(values.targetOriginY, {
            duration: Math.round(140 + lag * 2),
            easing: Easing.out(Easing.cubic),
          }),
        },
      };
    },
    [draggingSV, pinnedSV, reduceMotionSV, streamingSV],
  );

  const deferredRef = useRef(false);
  const pinnedRef = useRef(true);
  const userScrollingRef = useRef(false);
  const lastOffsetRef = useRef(0);

  useEffect(() => {
    pinnedRef.current = true;
    userScrollingRef.current = false;
    lastOffsetRef.current = 0;
  }, [conversationId]);

  const setDeferred = useCallback((active: boolean) => {
    if (deferredRef.current === active) return;
    deferredRef.current = active;
    setStorageWriteDeferred(active);
  }, []);

  useEffect(() => () => setDeferred(false), [setDeferred]);

  const outerRef = useAnimatedRef<Animated.ScrollView>();
  const outerOffsetY = useSharedValue(0);
  const outerContentH = useSharedValue(0);
  const outerLayoutH = useSharedValue(0);
  const outerDriving = useSharedValue(false);
  const outerFlingToken = useSharedValue(0);
  const chatScroll = useMemo<ChatScrollHandle | null>(
    () =>
      useJsScrollRelay
        ? {
            ref: outerRef,
            offsetY: outerOffsetY,
            contentHeight: outerContentH,
            layoutHeight: outerLayoutH,
            driving: outerDriving,
            flingToken: outerFlingToken,
          }
        : null,
    [outerContentH, outerDriving, outerFlingToken, outerLayoutH, outerOffsetY, outerRef],
  );

  const renderScrollComponent = useCallback(
    (props: ScrollViewProps) => <RelayScrollView {...props} animatedRef={outerRef} />,
    [outerRef],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      if (useJsScrollRelay) {
        outerContentH.set(contentSize.height);
        outerLayoutH.set(layoutMeasurement.height);
        if (!outerDriving.get()) {
          outerOffsetY.set(contentOffset.y);
        }
      }
      const y = contentOffset.y;
      const prevY = lastOffsetRef.current;
      lastOffsetRef.current = y;
      // Only the user (a drag, its fling, or a nested scroll relaying into the list) may unpin.
      // Anything else that nudges the offset while pinned — layout glides, anchor corrections,
      // content reflow — gets snapped straight back to the bottom so the reply stays followed.
      const userMoving = userScrollingRef.current || (useJsScrollRelay && outerDriving.get());
      let nextPinned = y <= BOTTOM_STICK_THRESHOLD;
      if (!userMoving && pinnedRef.current) {
        nextPinned = true;
        // Moving toward the bottom (e.g. the jump button's animated scroll) is left alone.
        if (y > 0.5 && y >= prevY) {
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }
      }
      pinnedRef.current = nextPinned;
      pinnedSV.set(nextPinned);
      const nextJump = !nextPinned && y > 300;
      setScrollState((prev) =>
        prev.id === conversationId && prev.pinned === nextPinned && prev.showJump === nextJump
          ? prev
          : { id: conversationId, pinned: nextPinned, showJump: nextJump },
      );
    },
    [conversationId, outerContentH, outerDriving, outerLayoutH, outerOffsetY, pinnedSV],
  );

  const onScrollBeginDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setDeferred(true);
      draggingSV.set(true);
      userScrollingRef.current = true;
      if (useJsScrollRelay) {
        outerFlingToken.set(outerFlingToken.get() + 1);
        outerDriving.set(false);
        outerOffsetY.set(e.nativeEvent.contentOffset.y);
      }
    },
    [draggingSV, outerDriving, outerFlingToken, outerOffsetY, setDeferred],
  );

  const onScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingSV.set(false);
      if (useJsScrollRelay && !outerDriving.get()) {
        outerOffsetY.set(e.nativeEvent.contentOffset.y);
      }
      const vy = e.nativeEvent.velocity?.y ?? 0;
      if (Math.abs(vy) < 0.05) {
        setDeferred(false);
        userScrollingRef.current = false;
      }
    },
    [draggingSV, outerDriving, outerOffsetY, setDeferred],
  );

  const onMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setDeferred(false);
      draggingSV.set(false);
      userScrollingRef.current = false;
      if (useJsScrollRelay && !outerDriving.get()) {
        outerOffsetY.set(e.nativeEvent.contentOffset.y);
      }
    },
    [draggingSV, outerDriving, outerOffsetY, setDeferred],
  );

  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      outerContentH.set(h);
    },
    [outerContentH],
  );

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      outerLayoutH.set(e.nativeEvent.layout.height);
    },
    [outerLayoutH],
  );

  const jumpToBottom = useCallback(() => {
    setScrollState({ id: conversationId, pinned: true, showJump: false });
    pinnedRef.current = true;
    userScrollingRef.current = false;
    pinnedSV.set(true);
    if (useJsScrollRelay) {
      outerFlingToken.set(outerFlingToken.get() + 1);
      outerDriving.set(false);
    }
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [conversationId, outerDriving, outerFlingToken, pinnedSV]);

  const spacerStyle = useAnimatedStyle(() => ({ height: bottomInset.value }));
  const jumpStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -bottomInset.value }] }));
  const listHeader = useMemo(() => <Animated.View style={spacerStyle} />, [spacerStyle]);
  const contentContainerStyle = useMemo(
    () => ({ paddingTop: LIST_PADDING_TOP, paddingBottom: 12 + topInset }),
    [topInset],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => (
      <MessageBubble
        conversationId={conversationId}
        message={item}
        isLast={item.id === lastAssistantId}
        onRegenerate={onRegenerate}
        onEdit={onEdit}
        onBranch={onBranch}
        busy={busy}
      />
    ),
    [conversationId, lastAssistantId, onRegenerate, onEdit, onBranch, busy],
  );

  return (
    <ChatScrollContext.Provider value={chatScroll}>
      <CellLayoutContext.Provider value={cellLayout}>
        <View style={styles.container}>
          <FlatList
            ref={listRef}
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            CellRendererComponent={SmoothCell}
            // Inverted flips the content, so its top padding and header show at the bottom and vice
            // versa. The header is the composer's room, sized without re-rendering the list.
            ListHeaderComponent={listHeader}
            ListFooterComponent={LIST_FOOTER}
            contentContainerStyle={contentContainerStyle}
            // FlatList defaults removeClippedSubviews=true on Android, which detaches off-screen
            // siblings from contentView and leaves MaintainVisibleScrollPositionHelper with no
            // anchor above a streaming message taller than one viewport.
            removeClippedSubviews={false}
            maintainVisibleContentPosition={pinnedToBottom ? MAINTAIN_AT_BOTTOM : MAINTAIN_SCROLLED_UP}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // Selectable text takes focus when tapped or held, and on Android the list then scrolls
            // the focused text into view, which in an inverted list lands somewhere else entirely.
            scrollsChildToFocus={false}
            renderScrollComponent={useJsScrollRelay ? renderScrollComponent : undefined}
            onScroll={onScroll}
            onScrollBeginDrag={onScrollBeginDrag}
            onScrollEndDrag={onScrollEndDrag}
            onMomentumScrollEnd={onMomentumScrollEnd}
            onContentSizeChange={useJsScrollRelay ? onContentSizeChange : undefined}
            onLayout={useJsScrollRelay ? onLayout : undefined}
            scrollEventThrottle={16}
          />
          {showJump && (
            <Animated.View style={[styles.jumpSlot, jumpStyle]}>
              <Pressable
                onPress={jumpToBottom}
                style={[styles.jump, { backgroundColor: colors.background, borderColor: colors.border }]}
              >
                <Feather name="arrow-down" size={18} color={colors.text} />
              </Pressable>
            </Animated.View>
          )}
        </View>
      </CellLayoutContext.Provider>
    </ChatScrollContext.Provider>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  jumpSlot: { position: 'absolute', alignSelf: 'center', bottom: 12 },
  jump: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
});
