import Feather from '@expo/vector-icons/Feather';
import * as Haptics from '@/lib/haptics';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ActivityIndicator, Alert, Dimensions, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type HostInstance, type TextInputInstance } from 'react-native';
import Animated, { Easing, interpolate, useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AttachmentMenu, type AttachAction } from '@/components/AttachmentMenu';
import { showGoalDetails } from '@/components/GoalSheet';
import { MentionMenu } from '@/components/MentionMenu';
import { attachmentUri, deleteAttachment, pickFiles, pickImages } from '@/lib/attachments';
import { canCompact } from '@/lib/chat';
import { compactCommand, goalCommand } from '@/lib/commands';
import { attachmentFor, type LibraryItem } from '@/lib/library';
import {
  atSections,
  atStart,
  filterSections,
  mentionLabels,
  mentionSpans,
  mentionTrigger,
  SLASH_KINDS,
  slashSections,
  type MentionOption,
} from '@/lib/mentions';
import { CONTEXT_METER_WIDTH, ContextMeter, ContextPopover } from '@/components/ContextUsage';
import { EFFORT_METER_EXTENT, EffortMeter } from '@/components/EffortMeter';
import { FileIcon } from '@/components/FileIcon';
import { measureInOverlay } from '@/components/OverlayHost';
import { QUOTA_METER_WIDTH, QuotaMeter, QuotaPopover, quotaMeterLabel } from '@/components/QuotaUsage';
import type { AttachmentPart, FilePart, ImagePart } from '@/lib/providers';
import { useTheme } from '@/lib/theme';
import type { ContextUsage } from '@/lib/usage';
import { useChats } from '@/store/chats';
import type { SubscriptionQuota } from '@/lib/useSubscriptionQuota';

// The composer is a one-line pill while the keyboard is down and a two-row box (text above,
// toolbar below) while the keyboard is up. One progress value drives every dimension between
// the two. Expansion follows the keyboard, not input focus, so blurring the TextInput (tapping
// a toolbar button, switching focus) never shrinks the box while the keyboard is still showing.
const ROW = 52;
const BUTTON = 36;
const TOOLBAR_PAD = 8;
const COLLAPSED = { margin: 36, padLeft: TOOLBAR_PAD + BUTTON + 2, padRight: TOOLBAR_PAD + BUTTON + 8, padBottom: 0 };
const EXPANDED = { margin: 12, padLeft: 16, padRight: 16, padBottom: ROW - 6 };
const TWEEN = { duration: 280, easing: Easing.bezier(0.2, 0, 0, 1) };
const TOOLBAR_GAP = 4;
// The visible space wanted between neighbouring toolbar icons once expanded. The effort gauge is
// drawn well inside its round button while the two meters fill their boxes, so equal box gaps
// read as uneven; the meters' padding makes up the difference.
const ICON_SPACING = 14;
// Empty space inside the effort button on either side of its drawn gauge.
const EFFORT_INSET = (BUTTON - EFFORT_METER_EXTENT) / 2;
// Empty space inside the Stop button beside its square, when it sits uncoloured next to Send.
const STOP_INSET = (BUTTON - 12) / 2;
// Empty space inside the attach button beside its plus (24pt Feather glyph: 14pt of lines plus round caps).
const ATTACH_INSET = (BUTTON - 16) / 2;

// The mention list's tallest, and the room it keeps from the top of the screen.
const MENTION_MAX_HEIGHT = 320;
const MENTION_TOP_ROOM = 16;

/** Padding a meter needs on one side to sit ICON_SPACING from a neighbour with `neighbourInset`. */
const roomBeside = (neighbourInset: number) => Math.max(0, ICON_SPACING - TOOLBAR_GAP - neighbourInset);

/** How much taller the box stands at a given progress than it does collapsed. */
export function composerGrowth(progress: number) {
  'worklet';
  return interpolate(progress, [0, 1], [0, EXPANDED.padBottom - COLLAPSED.padBottom]);
}

/** The box's distance from either side of the screen at a given progress. */
export function composerMargin(progress: number) {
  'worklet';
  return interpolate(progress, [0, 1], [COLLAPSED.margin, EXPANDED.margin]);
}

type Props = {
  text: string;
  onChangeText: (text: string) => void;
  /** Text picked from the chat to ask about, shown as pills above the text. */
  quotes: string[];
  onRemoveQuote: (index: number) => void;
  /** Held by the dock, so a queued message can be brought back here to edit. */
  attachments: AttachmentPart[];
  onChangeAttachments: Dispatch<SetStateAction<AttachmentPart[]>>;
  placeholder: string;
  inputRef: RefObject<TextInputInstance | null>;
  /** While a reply streams, Stop shows beside Send, or alone when there's nothing to send. */
  streaming: boolean;
  onSend: (text: string, attachments: AttachmentPart[]) => void;
  onStop: () => void;
  /** When set and the box is empty, replaces Send with a Continue button to resume the interrupted turn. */
  onContinue?: () => void;
  /** Keeps the box expanded for exactly as long as the keyboard is on screen. */
  keyboardVisible: boolean;
  /** Shown when the selected model takes an effort level. */
  effort?: { levels: string[]; level: string; onPress: () => void };
  /** Shown beside the effort gauge while expanded, when context usage is turned on. */
  context?: ContextUsage | null;
  /** Shown beside the context gauge while expanded, when the model runs on a subscription. */
  quota?: SubscriptionQuota | null;
  /** Expansion, 0 collapsed to 1 expanded. The composer drives it; the screen reads it so the
   *  conversation's inset can follow the box's growth on the UI thread. */
  progress: SharedValue<number>;
  /** The chat it sends to (null for one yet to start), whose workspace and siblings "@" offers. */
  conversationId?: string | null;
  /** A remote chat: "@" offers only Library files, and there are no commands, skills or plugins. */
  remote?: boolean;
};

export function Composer({
  text,
  onChangeText,
  quotes,
  onRemoveQuote,
  attachments,
  onChangeAttachments: setAttachments,
  placeholder,
  inputRef: input,
  streaming,
  onSend,
  onStop,
  onContinue,
  keyboardVisible,
  effort,
  context,
  quota,
  progress,
  conversationId = null,
  remote = false,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [importing, setImporting] = useState(false);
  const images = attachments.filter((a): a is ImagePart => a.type === 'image');
  const files = attachments.filter((a): a is FilePart => a.type === 'file');
  const canSend = !importing && (text.trim().length > 0 || attachments.length > 0 || quotes.length > 0);
  const showContinue = !streaming && !importing && !canSend && !!onContinue;
  // While a reply streams, sending queues or steers, and Stop stays beside Send.
  const bothButtons = streaming && canSend;
  // A zero-impact overlay inside the box that we can measure (Animated.View refs are awkwardly
  // typed); its window position is the box's content top-left.
  const box = useRef<HostInstance>(null);

  // Popovers: the attach menu hangs off the box's top-left corner and the context breakdown off
  // its top-right, measured at open time so they track the box wherever the keyboard pushed it.
  const [popover, setPopover] = useState<'attach' | 'context' | 'quota' | 'browse' | null>(null);
  const [anchor, setAnchor] = useState({
    x: TOOLBAR_PAD + 8,
    right: COLLAPSED.margin,
    bottom: 96,
    hostWidth: Dimensions.get('window').width,
    // The box's own left edge, width and top, for the mention list that spans it.
    left: COLLAPSED.margin,
    width: Dimensions.get('window').width - COLLAPSED.margin * 2,
    top: 400,
  });
  // Collapsed, the text runs up to the right-hand buttons, so leave room for the effort one too.
  const collapsedPadRight =
    COLLAPSED.padRight + (effort ? BUTTON + TOOLBAR_GAP : 0) + (bothButtons ? BUTTON + TOOLBAR_GAP : 0);

  // Expand for exactly as long as the keyboard is on screen. Driving this from the keyboard
  // rather than focus means tapping a toolbar button (which blurs the TextInput) keeps the box
  // big until the keyboard itself goes away.
  useEffect(() => {
    progress.set(withTiming(keyboardVisible ? 1 : 0, TWEEN));
  }, [keyboardVisible, progress]);

  // Dismissing the keyboard (back gesture, swipe) can leave the input focused on Android, so
  // blur it to make the next tap fire again. Collapse no longer depends on this — the keyboard
  // state drives it.
  useEffect(() => {
    const blur = () => input.current?.blur();
    const subs = [Keyboard.addListener('keyboardWillHide', blur), Keyboard.addListener('keyboardDidHide', blur)];
    return () => subs.forEach((s) => s.remove());
  }, [input]);

  const boxStyle = useAnimatedStyle(() => ({
    marginHorizontal: composerMargin(progress.value),
    paddingBottom: COLLAPSED.padBottom + composerGrowth(progress.value),
  }));
  const inputStyle = useAnimatedStyle(() => ({
    paddingLeft: interpolate(progress.value, [0, 1], [COLLAPSED.padLeft, EXPANDED.padLeft]),
    paddingRight: interpolate(progress.value, [0, 1], [collapsedPadRight, EXPANDED.padRight]),
  }));
  // Toolbar: attach and the quota bar on the left; the context meter, effort gauge, then Stop
  // and/or Send on the right. The meters' padding is set by what they sit beside, so every icon
  // ends up ICON_SPACING from the next.
  const meterPadRight = roomBeside(effort ? EFFORT_INSET : bothButtons ? STOP_INSET : 0);
  const meterWidth = CONTEXT_METER_WIDTH + meterPadRight;
  const quotaGap = Math.max(0, ICON_SPACING - ATTACH_INSET);

  // The meters grow in with the expanded toolbar; collapsed, they take no room (their gap included).
  const meterStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [0, meterWidth]),
    marginRight: interpolate(progress.value, [0, 1], [-TOOLBAR_GAP, 0]),
    opacity: progress.value,
  }));
  const quotaStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [0, QUOTA_METER_WIDTH]),
    marginLeft: interpolate(progress.value, [0, 1], [0, quotaGap]),
    opacity: progress.value,
  }));

  const attach = async (source: AttachAction) => {
    setPopover(null);
    // The Plugins row lists everything "/" offers: commands, skills and plugins.
    if (source === 'plugins') {
      openPopover('browse');
      return;
    }
    setImporting(true);
    try {
      const picked =
        source === 'files' ? await pickFiles() : await pickImages(source === 'camera' ? 'camera' : 'library');
      setAttachments((prev) => [...prev, ...picked]);
    } catch (e) {
      Alert.alert('Could not attach', e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  // Dismissing the keyboard or folding/unfolding moves the composer out from under an open popover.
  useEffect(() => {
    if (!popover) return;
    const close = () => setPopover(null);
    const kb = Keyboard.addListener('keyboardDidHide', close);
    const dim = Dimensions.addEventListener('change', close);
    return () => {
      kb.remove();
      dim.remove();
    };
  }, [popover]);

  // Popovers float above the box, anchored where it measures to sit in the root overlay host.
  // Keeping them in the main Activity window (instead of Modal or OverKeyboardView) leaves the
  // keyboard open without relying on a separate WindowManager panel.
  const measureBox = useCallback((then?: () => void) => {
    measureInOverlay(box.current, ({ x, y, width, hostWidth, hostHeight }) => {
      setAnchor({ x: x + TOOLBAR_PAD, right: hostWidth - x - width, bottom: hostHeight - y + 8, hostWidth, left: x, width, top: y });
      then?.();
    });
  }, []);
  const openPopover = (which: 'attach' | 'context' | 'quota' | 'browse') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    measureBox(() => setPopover(which));
  };

  // ---- mentions: "@" for files, folders and chats; "/" for commands, skills and plugins ----
  // The cursor, to find the "@" or "/" being typed before it.
  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  const cursor = Math.min(selection.end, text.length);
  // Where a mention's list was closed (with back, or by picking from it): it stays shut until the
  // cursor leaves that mention.
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Only while typing; remote chats have nothing for "/".
  const typed = keyboardVisible ? mentionTrigger(text, cursor) : null;
  const trigger = typed && typed.start !== dismissed && (typed.char === '@' || !remote) ? typed : null;
  if (!typed && dismissed !== null) setDismissed(null);

  // What a trigger can offer is gathered once, when it's typed; typing after it only filters.
  const triggerChar = trigger?.char;
  const triggerStart = trigger?.start;
  const commandsHere = triggerStart !== undefined && atStart(text, triggerStart);
  const pool = useMemo(() => {
    if (triggerChar === '@') return atSections(conversationId, remote);
    if (triggerChar === '/') return slashSections(commandsHere);
    return null;
    // Keyed by the trigger's position too, so a new "@" gathers afresh (files may have changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerChar, triggerStart, commandsHere, conversationId, remote]);
  // Opened from the plus menu: everything "/" offers, gathered as it opens.
  const browsing = popover === 'browse';
  const browsed = useMemo(() => (browsing ? slashSections(true) : []), [browsing]);
  const query = trigger?.query;
  const sections = useMemo(
    () => (browsing ? browsed : query !== undefined && pool ? filterSections(pool, query) : []),
    [browsing, browsed, query, pool]
  );
  const typedOpen = !browsing && !!trigger && sections.length > 0;
  // The list shows once the box has been measured for this mention, never at a stale spot.
  const [measuredFor, setMeasuredFor] = useState<number | null>(null);
  useEffect(() => {
    if (typedOpen && triggerStart !== undefined) measureBox(() => setMeasuredFor(triggerStart));
  }, [typedOpen, triggerStart, measureBox]);
  const mentionOpen = browsing || (typedOpen && measuredFor === triggerStart);

  // What mentions can name, for coloring them in the text. Gathered when the text first gets an
  // "@" or "/", and again after each pick (whatever was picked is then sure to be among them).
  const [picks, setPicks] = useState(0);
  const hasMarks = /(^|\s)[@/]\S/.test(text);
  const labels = useMemo(
    () => (hasMarks ? mentionLabels(conversationId, remote) : null),
    // `picks` only asks for a fresh gathering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasMarks, conversationId, remote, picks]
  );
  const spans = useMemo(() => (labels ? mentionSpans(text, labels) : null), [labels, text]);

  const attachLibrary = async (item: LibraryItem) => {
    setImporting(true);
    try {
      const part = await attachmentFor(item);
      setAttachments((prev) => [...prev, part]);
    } catch (e) {
      Alert.alert('Could not attach', e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  /** Writes the picked option into the text as "@label " or "/label ", in place of what was typed for it. */
  const pickMention = (option: MentionOption) => {
    Haptics.selectionAsync();
    const token = `${SLASH_KINDS.includes(option.kind) ? '/' : '@'}${option.label} `;
    let start: number;
    let end: number;
    if (browsing) {
      // Commands only work at the start of a message; the rest go in at the cursor.
      start = end = option.kind === 'command' ? 0 : cursor;
      setPopover(null);
    } else if (trigger) {
      start = trigger.start;
      end = cursor;
    } else return;
    const before = text.slice(0, start);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${lead}${token}${text.slice(end).replace(/^ +/, '')}`;
    const at = before.length + lead.length + token.length;
    onChangeText(next);
    setSelection({ start: at, end: at });
    // Picked, its list stays shut while the cursor sits just after it.
    setDismissed(before.length + lead.length);
    setPicks((n) => n + 1);
    if (option.item) void attachLibrary(option.item);
    // Once the new text has reached the input, the cursor goes after what was picked.
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelection(at, at);
    });
  };

  const closeMention = () => {
    if (popover === 'browse') setPopover(null);
    else if (triggerStart !== undefined) setDismissed(triggerStart);
  };

  const removeAttachment = (a: AttachmentPart) => {
    if (a.type === 'image' && a.file) deleteAttachment(a.file);
    if (a.type === 'file' && a.file) deleteAttachment(a.file);
    setAttachments((prev) => prev.filter((x) => x !== a));
  };

  const send = () => {
    if (!canSend) return;
    // "/goal" alone shows how the goal is doing, and "/goal clear", "pause" and "resume" manage it;
    // with no goal to manage, it needs saying what to work toward.
    const goalCmd = remote ? null : goalCommand(text);
    if (goalCmd && !('goal' in goalCmd)) {
      if (!(conversationId && useChats.getState().conversations[conversationId]?.goal)) {
        Alert.alert('What’s the goal?', 'Write what to work toward after /goal, like “/goal Get every test passing”.');
        return;
      }
      if ('status' in goalCmd && conversationId) {
        showGoalDetails(conversationId);
        onChangeText('');
        return;
      }
    }
    // /compact summarises the chat as it is; it needs a chat to summarise and takes no files.
    if (!remote && compactCommand(text)) {
      if (attachments.length) {
        Alert.alert('Send the files on their own', '/compact only summarises the chat. Send the attachments in a message of their own.');
        return;
      }
      if (!canCompact(conversationId ?? null)) {
        Alert.alert('Nothing to compact', '/compact summarises the chat so far to free up context, and there’s nothing new here to summarise yet.');
        return;
      }
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Cleared first, so an owner that fills the box again on send (ending an edit) keeps what it puts back.
    const sent = attachments;
    setAttachments([]);
    onSend(text.trim(), sent);
  };

  const continueTurn = () => {
    if (!showContinue) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onContinue?.();
  };

  return (
    <>
      <AttachmentMenu
        visible={popover === 'attach'}
        x={anchor.x}
        bottom={anchor.bottom}
        onPick={attach}
        onClose={() => setPopover(null)}
        slash={!remote}
      />
      <MentionMenu
        visible={mentionOpen}
        sections={sections}
        query={browsing ? '' : (trigger?.query ?? '')}
        left={anchor.left}
        width={anchor.width}
        bottom={anchor.bottom}
        maxHeight={Math.min(MENTION_MAX_HEIGHT, anchor.top - insets.top - MENTION_TOP_ROOM)}
        modal={browsing}
        onPick={pickMention}
        onClose={closeMention}
      />
      {context && (
        <ContextPopover
          visible={popover === 'context'}
          usage={context}
          right={anchor.right}
          bottom={anchor.bottom}
          maxWidth={anchor.hostWidth}
          onClose={() => setPopover(null)}
        />
      )}
      {quota && (
        <QuotaPopover
          visible={popover === 'quota'}
          quota={quota}
          left={anchor.x - TOOLBAR_PAD}
          bottom={anchor.bottom}
          maxWidth={anchor.hostWidth}
          onClose={() => setPopover(null)}
        />
      )}
      <Animated.View
        ref={box}
        // The box grows as lines are added; the list above it moves up with it.
        onLayout={typedOpen ? () => measureBox() : undefined}
        style={[styles.box, { backgroundColor: colors.composer }, boxStyle]}
      >
        {(attachments.length > 0 || quotes.length > 0 || importing) && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
            {quotes.map((q, i) => (
              <View key={`${i}-${q}`} style={[styles.quote, { backgroundColor: colors.surface }]}>
                <Feather name="corner-down-right" size={14} color={colors.textSecondary} />
                <Text numberOfLines={1} style={[styles.quoteText, { color: colors.text }]}>
                  {q.replace(/\s+/g, ' ')}
                </Text>
                <Pressable
                  onPress={() => onRemoveQuote(i)}
                  hitSlop={8}
                  style={({ pressed }) => pressed && { opacity: 0.5 }}
                  accessibilityLabel="Remove quote"
                >
                  <Feather name="x" size={15} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
            {images.map((img) => (
              <View key={img.file}>
                <Image source={{ uri: attachmentUri(img.file) }} style={styles.thumb} contentFit="cover" />
                <Pressable
                  onPress={() => removeAttachment(img)}
                  hitSlop={8}
                  style={[styles.remove, { backgroundColor: colors.text }]}
                >
                  <Feather name="x" size={12} color={colors.background} />
                </Pressable>
              </View>
            ))}
            {files.map((f, i) => (
              <View key={`${f.file ?? f.name}-${i}`} style={[styles.fileChip, { backgroundColor: colors.surface }]}>
                <FileIcon name={f.name} uri={f.file ? attachmentUri(f.file) : undefined} size={26} />
                <Text numberOfLines={1} style={[styles.fileChipName, { color: colors.text }]}>
                  {f.name}
                </Text>
                <Pressable
                  onPress={() => removeAttachment(f)}
                  hitSlop={8}
                  style={[styles.remove, { backgroundColor: colors.text }]}
                >
                  <Feather name="x" size={12} color={colors.background} />
                </Pressable>
              </View>
            ))}
            {importing && (
              <View style={[styles.thumb, styles.loading, { backgroundColor: colors.surface }]}>
                <ActivityIndicator color={colors.textSecondary} />
              </View>
            )}
          </ScrollView>
        )}

      <Animated.View style={inputStyle}>
        <TextInput
          ref={input}
          // With mentions in it, the text goes in as styled runs so they show in color; otherwise as is.
          value={spans?.some((s) => s.mention) ? undefined : text}
          onChangeText={onChangeText}
          onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          multiline
          style={[styles.input, { color: colors.text }]}
        >
          {spans?.some((s) => s.mention) ? (
            <Text>
              {spans.map((s, i) =>
                s.mention ? (
                  <Text key={i} style={{ color: colors.accentText }}>
                    {s.text}
                  </Text>
                ) : (
                  s.text
                )
              )}
            </Text>
          ) : null}
        </TextInput>
      </Animated.View>

      {/* Pinned to the bottom row: beside the text when collapsed, below it when expanded. */}
      <View style={styles.toolbar} pointerEvents="box-none">
        <View style={styles.leading}>
          <Pressable
            onPress={() => openPopover('attach')}
            hitSlop={6}
            style={({ pressed }) => [styles.circle, pressed && { opacity: 0.5 }]}
            accessibilityLabel="Attach"
          >
            <Feather name="plus" size={24} color={colors.text} />
          </Pressable>
          {quota && (
            <Animated.View style={[styles.meterSlot, quotaStyle]} pointerEvents={keyboardVisible ? 'auto' : 'none'}>
              <Pressable
                onPress={() => {
                  quota.refresh();
                  openPopover('quota');
                }}
                // Short on the left, where the attach button's own slop reaches.
                hitSlop={{ top: 8, bottom: 8, left: 2, right: 10 }}
                style={({ pressed }) => [styles.meterButton, { width: QUOTA_METER_WIDTH }, pressed && { opacity: 0.5 }]}
                accessibilityLabel={quotaMeterLabel(quota.usage)}
                accessibilityHint="Shows usage details"
              >
                <QuotaMeter usage={quota.usage} />
              </Pressable>
            </Animated.View>
          )}
        </View>

        <View style={styles.trailing}>
          {context && (
            <Animated.View style={[styles.meterSlot, meterStyle]} pointerEvents={keyboardVisible ? 'auto' : 'none'}>
              <Pressable
                onPress={() => openPopover('context')}
                // Kept narrow at the sides so it doesn't reach over the buttons beside it.
                hitSlop={{ top: 8, bottom: 8, left: 10, right: 2 }}
                style={({ pressed }) => [
                  styles.meterButton,
                  { width: meterWidth, paddingRight: meterPadRight },
                  pressed && { opacity: 0.5 },
                ]}
                accessibilityLabel={`Context: ${Math.round(
                  ((context.system + context.tools + context.messages) / context.budget) * 100
                )}% used`}
              >
                <ContextMeter usage={context} />
              </Pressable>
            </Animated.View>
          )}
          {effort && (
            <Pressable
              onPress={effort.onPress}
              hitSlop={6}
              style={({ pressed }) => [styles.circle, pressed && { opacity: 0.5 }]}
              accessibilityLabel={`Effort: ${effort.level}`}
            >
              <EffortMeter levels={effort.levels} level={effort.level} />
            </Pressable>
          )}
          {streaming && (
            <Pressable
              onPress={onStop}
              hitSlop={6}
              style={({ pressed }) => [
                styles.circle,
                !bothButtons && { backgroundColor: colors.accent },
                bothButtons && pressed && { opacity: 0.5 },
              ]}
              accessibilityLabel="Stop"
            >
              <View style={[styles.stop, { backgroundColor: bothButtons ? colors.text : colors.accentFg }]} />
            </Pressable>
          )}
          {showContinue ? (
            <Pressable
              onPress={continueTurn}
              hitSlop={6}
              style={({ pressed }) => [styles.circle, { backgroundColor: colors.accent }, pressed && { opacity: 0.75 }]}
              accessibilityLabel="Continue"
            >
              <Feather name="play" size={17} color={colors.accentFg} style={styles.continueIcon} />
            </Pressable>
          ) : (
            (!streaming || bothButtons) && (
              <Pressable
                onPress={send}
                disabled={!canSend}
                hitSlop={6}
                style={[styles.circle, { backgroundColor: colors.accent }, !canSend && { opacity: 0.45 }]}
                accessibilityLabel="Send"
              >
                <Feather name="arrow-up" size={20} color={colors.accentFg} />
              </Pressable>
            )
          )}
        </View>
      </View>
    </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: ROW / 2, overflow: 'hidden' },
  thumbs: { gap: 8, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 2 },
  thumb: { width: 64, height: 64, borderRadius: 14 },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 40,
    maxWidth: 180,
    borderRadius: 20,
    paddingLeft: 7,
    paddingRight: 14,
  },
  fileChipName: { fontSize: 14, flexShrink: 1 },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    height: 32,
    maxWidth: 220,
    borderRadius: 16,
    paddingLeft: 10,
    paddingRight: 9,
  },
  quoteText: { fontSize: 14, flexShrink: 1 },
  loading: { alignItems: 'center', justifyContent: 'center' },
  remove: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    fontSize: 17,
    lineHeight: 22,
    minHeight: ROW,
    maxHeight: 160,
    paddingHorizontal: 0,
    paddingVertical: (ROW - 22) / 2,
    textAlignVertical: 'top',
  },
  toolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: ROW,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: TOOLBAR_PAD,
  },
  leading: { flexDirection: 'row', alignItems: 'center' },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: TOOLBAR_GAP },
  meterSlot: { height: BUTTON, overflow: 'hidden' },
  // Width and side padding are set inline from the neighbours; the glyph sits between the paddings.
  meterButton: { height: BUTTON, alignItems: 'center', justifyContent: 'center' },
  circle: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: 'center', justifyContent: 'center' },
  continueIcon: { marginLeft: 2 },
  stop: { width: 12, height: 12, borderRadius: 2 },
});
