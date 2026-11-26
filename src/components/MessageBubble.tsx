import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from '@/lib/haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { attachmentUri } from '@/lib/attachments';
import type { ContentPart, FilePart, ImagePart, ToolPart } from '@/lib/providers';
import { splitQuotes } from '@/lib/quotes';
import { sitesOf, sourcesOf } from '@/lib/sources';
import { formatStats } from '@/lib/stats';
import { useTheme } from '@/lib/theme';
import { useActivityLabel } from '@/lib/local/useActivityLabel';
import { messageText, useChats, type Message } from '@/store/chats';
import { LOCAL_ENDPOINT_ID } from '@/store/localModels';
import { describeCall } from '@/lib/tools/describe';
import { useSettings } from '@/store/settings';
import { BrandIcon } from './BrandIcon';
import { FileIcon } from './FileIcon';
import { brandOfModel, friendlyModelName } from '@/lib/modelNames';
import { RemoteReply } from './RemoteReply';
import { areasSelect, SelectionArea } from './SelectionArea';
import { Markdown } from './Markdown';
import { NestedScroll } from './NestedScroll';
import { QuestionCard } from './QuestionCard';
import { SiteChips, SourcesButton } from './Sources';
import { useFadeText } from './StreamFade';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolCall, toolIcon } from './ToolCall';
import { filesOf, TurnFiles } from './TurnFiles';

type Props = {
  conversationId: string;
  message: Message;
  /** The newest reply in the chat. */
  isLast: boolean;
  onRegenerate?: (messageId: string) => void;
  /** Starts editing one of the user's messages; absent where messages can't be edited (remote chats). */
  onEdit?: (messageId: string) => void;
  /** Starts a new chat with the conversation up to this reply. */
  onBranch?: (messageId: string) => void;
  /** A reply is running: the chat can't be edited, regenerated or switched to another version. */
  busy?: boolean;
};

/** "‹ 2/3 ›" on a message that starts a version of the chat, to switch to the others. */
function Versions({ conversationId, forkId, disabled }: { conversationId: string; forkId: string; disabled?: boolean }) {
  const { colors } = useTheme();
  const fork = useChats(
    useShallow((s) => {
      const f = s.conversations[conversationId]?.forks?.[forkId];
      return { count: f?.versions.length ?? 0, current: f?.current ?? 0 };
    })
  );
  if (fork.count < 2) return null;
  const go = (to: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    useChats.getState().switchVersion(conversationId, forkId, to);
  };
  const first = disabled || fork.current === 0;
  const last = disabled || fork.current === fork.count - 1;
  return (
    <View style={styles.versions}>
      <Pressable
        onPress={() => go(fork.current - 1)}
        disabled={first}
        hitSlop={8}
        style={styles.versionStep}
        accessibilityLabel="Previous version"
      >
        <Feather name="chevron-left" size={17} color={first ? colors.textTertiary : colors.textSecondary} />
      </Pressable>
      <Text style={[styles.versionText, { color: disabled ? colors.textTertiary : colors.textSecondary }]}>
        {fork.current + 1}/{fork.count}
      </Text>
      <Pressable
        onPress={() => go(fork.current + 1)}
        disabled={last}
        hitSlop={8}
        style={styles.versionStep}
        accessibilityLabel="Next version"
      >
        <Feather name="chevron-right" size={17} color={last ? colors.textTertiary : colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function Files({ files, align }: { files: FilePart[]; align: 'flex-end' | 'flex-start' }) {
  const { colors } = useTheme();
  if (!files.length) return null;
  return (
    <View style={[styles.images, { justifyContent: align }]}>
      {files.map((f, i) => (
        <View
          key={`${f.file ?? f.name}-${i}`}
          style={[styles.fileChip, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <FileIcon name={f.name} uri={f.file ? attachmentUri(f.file) : undefined} size={28} />
          <Text numberOfLines={1} style={[styles.fileName, { color: colors.text }]}>
            {f.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Images({ images, align }: { images: ImagePart[]; align: 'flex-end' | 'flex-start' }) {
  if (!images.length) return null;
  const size = images.length === 1 ? 220 : 120;
  return (
    <View style={[styles.images, { justifyContent: align }]}>
      {images.map((img) => (
        <Image
          key={img.file}
          source={{ uri: attachmentUri(img.file) }}
          style={{
            width: size,
            height: img.width && img.height && images.length === 1 ? Math.min(size * (img.height / img.width), 320) : size,
            borderRadius: 16,
          }}
          contentFit="cover"
        />
      ))}
    </View>
  );
}

type Segment =
  | { kind: 'text'; text: string; at?: number }
  | { kind: 'tool'; part: ToolPart }
  | { kind: 'thought'; text: string; ms?: number };

/** Runs of text merged into one markdown block, with thoughts and tool calls between them, in reply order. */
function segmentsOf(message: Message): Segment[] {
  // Replies saved before thoughts were content parts keep theirs in one block at the top.
  const out: Segment[] = message.reasoning ? [{ kind: 'thought', text: message.reasoning, ms: message.thoughtMs }] : [];
  for (const part of message.content) {
    const last = out[out.length - 1];
    if (part.type === 'text') {
      if (last?.kind === 'text') last.text += part.text;
      else out.push({ kind: 'text', text: part.text, at: part.at });
    } else if (part.type === 'tool') out.push({ kind: 'tool', part });
    else if (part.type === 'thought') out.push({ kind: 'thought', text: part.text, ms: part.ms });
  }
  return out;
}

// While a reply streams, text after its last tool call may be the answer or a note before the next
// call; there is no telling until the response ends. Notes are a sentence or two, so the work folds
// away once the text runs past this, and otherwise when the reply finishes.
const ANSWER_CHARS = 240;

/**
 * Splits a reply that used tools into the work (thoughts, tool calls and notes, up to the last
 * thought or call) and the answer after it. Replies without tool calls aren't split, unless
 * `thoughts` says a reply that only thought counts as work too.
 */
function splitWork(segments: Segment[], thoughts: boolean) {
  const end = segments.findLastIndex((s) => s.kind !== 'text');
  const work = segments.slice(0, end + 1);
  if (!work.some((s) => s.kind === 'tool' || (thoughts && s.kind === 'thought'))) return null;
  const answer = segments.slice(end + 1) as Extract<Segment, { kind: 'text' }>[];
  return { work, answer, text: answer.map((s) => s.text).join('').trim(), at: answer[0]?.at };
}

function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Milliseconds since `since`, ticking every second while `live`. */
function useElapsed(since: number, live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return Math.max(0, now - since);
}

/** The end of a stretch of text on one line, so the newest words stay in view as it streams. */
const tail = (text: string) => text.replace(/\s+/g, ' ').trim().slice(-300);

/**
 * What the model is doing right now, in one line: the running call, the end of its streaming
 * thoughts or note, or "Thinking…" between steps. Tapping it opens the steps.
 */
function CurrentStep({ seg, onPress }: { seg: Segment | null; onPress: () => void }) {
  const { colors } = useTheme();
  let icon: keyof typeof Feather.glyphMap = 'activity';
  let text = 'Thinking…';
  let running = false;
  if (seg?.kind === 'tool') {
    icon = toolIcon(seg.part.name);
    text = describeCall(seg.part.name, seg.part.input);
    running = seg.part.status === 'writing' || seg.part.status === 'running';
  } else if (seg) {
    if (seg.kind === 'text') icon = 'edit-3';
    text = tail(seg.text) || text;
  }
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={`${text}, show steps`}
      style={({ pressed }) => [styles.step, pressed && { opacity: 0.6 }]}
    >
      <Feather name={icon} size={14} color={colors.textTertiary} />
      <Text
        numberOfLines={1}
        // Streaming text keeps its newest words; a call keeps the start of its description.
        ellipsizeMode={seg && seg.kind !== 'tool' ? 'head' : 'tail'}
        style={[styles.stepText, { color: colors.textTertiary }]}
      >
        {text}
      </Text>
      {running && <ActivityIndicator size="small" color={colors.textTertiary} style={styles.stepSpinner} />}
    </Pressable>
  );
}

/**
 * The work behind an answer under a "Working for Ns" header that becomes "Worked for Ns" once the
 * answer comes. Folded while under way, it still shows the model's notes, then `step` (the current
 * step) in place of the thoughts and calls.
 */
function Work({
  segments,
  open,
  onToggle,
  working,
  since,
  ms,
  step,
  render,
  content,
}: {
  segments: Segment[];
  open: boolean;
  onToggle: () => void;
  /** Whether the work is still under way: the reply streams and no answer has come yet. */
  working: boolean;
  /** When the reply started, for the running time. */
  since: number;
  /** How long the work took, once done. */
  ms: number;
  step: ReactNode;
  render: (seg: Segment, i: number) => ReactNode;
  content: ContentPart[];
}) {
  const { colors } = useTheme();
  const elapsed = useElapsed(since, working);
  const { sites, searched } = useMemo(() => sitesOf(content), [content]);
  const label = working ? `Working for ${duration(elapsed)}` : `Worked for ${duration(ms)}`;
  return (
    <>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${open ? 'hide' : 'show'} steps`}
        style={({ pressed }) => [styles.workHeader, pressed && { opacity: 0.6 }]}
      >
        <Text style={[styles.workLabel, { color: colors.textSecondary }]}>{label}</Text>
        <Feather
          name="chevron-down"
          size={14}
          color={colors.textSecondary}
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
      </Pressable>
      {/* Under the header rather than after the steps: a note the model writes before its next
          call shows after the steps and joins them when the call lands, which would push the
          sites down on every round. */}
      <SiteChips sites={sites} searched={searched} />
      {open ? (
        segments.map(render)
      ) : (
        <>
          {/* Folded while under way, the model's notes between steps still show; only thoughts and calls fold. */}
          {working && segments.map((seg, i) => seg.kind === 'text' && render(seg, i))}
          {step}
        </>
      )}
    </>
  );
}

// Split long reasoning into stable append-only chunks so streaming only re-layouts the tail ~1KB
// instead of forcing Android to rebuild a giant StaticLayout on every token flush.
const THOUGHT_CHUNK_TARGET = 1200;
const THOUGHT_CHUNK_MAX = 2400;

function splitThoughtChunks(text: string): string[] {
  if (text.length <= THOUGHT_CHUNK_MAX) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > THOUGHT_CHUNK_MAX) {
    const minCut = start + THOUGHT_CHUNK_TARGET;
    const maxCut = start + THOUGHT_CHUNK_MAX;
    const nl = text.indexOf('\n', minCut);
    if (nl !== -1 && nl <= maxCut) {
      chunks.push(text.slice(start, nl));
      start = nl + 1;
    } else {
      const sp = text.lastIndexOf(' ', maxCut);
      const cut = sp > minCut ? sp : maxCut;
      chunks.push(text.slice(start, cut));
      start = cut === sp ? sp + 1 : cut;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

const ThoughtChunk = memo(function ThoughtChunk({
  text,
  color,
  live,
  fadeInitial,
}: {
  text: string;
  color: string;
  live: boolean;
  fadeInitial: boolean;
}) {
  const content = useFadeText(text, live, color, { fadeInitial });
  return (
    <Text selectable={!areasSelect} style={[styles.thoughtsText, { color }]}>
      {content}
    </Text>
  );
});

/**
 * One stretch of the model's thinking: a "Thought for Ns" pill that shows or hides the text.
 * Folded while it streams, the pill is followed by the newest of it on one line.
 */
function Thoughts({ text, ms, live, keepOpen }: { text: string; ms?: number; live: boolean; keepOpen: boolean }) {
  const { colors } = useTheme();
  // Expanded while it streams, or for good when `keepOpen`; a tap pins the choice either way.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? (live || keepOpen);
  const chunks = useMemo(() => (open ? splitThoughtChunks(text) : []), [open, text]);
  return (
    <>
      <ThinkingIndicator
        thinking={live}
        expanded={open}
        toggleable
        thoughtMs={ms}
        onToggle={() => setOpenOverride(!open)}
      />
      {open && (
        // Capped in height, so while thoughts stream it follows their end until the user drags back to read.
        <NestedScroll style={styles.thoughts} follow={live}>
          <SelectionArea style={[styles.thoughtsInner, { borderLeftColor: colors.border }]}>
            {chunks.map((chunk, i) => (
              <ThoughtChunk
                key={i}
                text={chunk}
                color={colors.textSecondary}
                live={live && i === chunks.length - 1}
                fadeInitial={i === 0}
              />
            ))}
          </SelectionArea>
        </NestedScroll>
      )}
      {!open && live && <CurrentStep seg={{ kind: 'thought', text }} onPress={() => setOpenOverride(true)} />}
    </>
  );
}

function MessageBubbleInner({ conversationId, message, isLast, onRegenerate, onEdit, onBranch, busy }: Props) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const showSpeed = useSettings((s) => s.decodeSpeed);
  const showCache = useSettings((s) => s.cacheHits);
  const friendly = useSettings((s) => s.friendlyModelNames);
  const detail = useSettings((s) => s.chatDetail);
  // The user's own choice to show or hide the work, kept over what the detail level would do.
  const [workOverride, setWorkOverride] = useState<boolean | null>(null);
  // A reply from an on-device model first waits on the model loading and the prompt being read.
  const localModel = useChats((s) => {
    const c = s.conversations[conversationId];
    return c?.endpointId === LOCAL_ENDPOINT_ID && (!c.backendId || c.backendId === 'local') ? c.model : undefined;
  });
  const activity = useActivityLabel(message.status === 'streaming' ? localModel : undefined);
  const stats = formatStats(message.stats, { speed: showSpeed, cache: showCache });
  const text = messageText(message);
  const images = message.content.filter((p): p is ImagePart => p.type === 'image');
  const files = message.content.filter((p): p is FilePart => p.type === 'file');

  const copy = async () => {
    await Clipboard.setStringAsync(text);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (message.role === 'user') {
    // Text the user picked from the chat to ask about rides at the top of the message as quotes.
    const { quotes, text: asked } = splitQuotes(text);
    return (
      <View style={styles.userRow}>
        <Images images={images} align="flex-end" />
        <Files files={files} align="flex-end" />
        {quotes.map((q, i) => (
          <View key={i} style={[styles.quote, { backgroundColor: colors.surface }]}>
            <Feather name="corner-down-right" size={14} color={colors.textSecondary} style={styles.quoteIcon} />
            <Text numberOfLines={2} style={[styles.quoteText, { color: colors.textSecondary }]}>
              {q.replace(/\s+/g, ' ')}
            </Text>
          </View>
        ))}
        {!!asked && (
          // Held, the text selects where it can; otherwise holding copies it all.
          <Pressable onLongPress={areasSelect ? undefined : copy} style={[styles.userBubble, { backgroundColor: colors.userBubble }]}>
            <SelectionArea>
              <Text selectable={!areasSelect} style={[styles.userText, { color: colors.text }]}>
                {asked}
              </Text>
            </SelectionArea>
          </Pressable>
        )}
        {(!!onEdit || !!message.fork) && (
          <View style={styles.userActions}>
            {!!message.fork && <Versions conversationId={conversationId} forkId={message.fork} disabled={busy} />}
            {!!text && (
              <Pressable onPress={copy} hitSlop={8} style={styles.action} accessibilityLabel="Copy message">
                <Feather name={copied ? 'check' : 'copy'} size={16} color={colors.textSecondary} />
              </Pressable>
            )}
            {!!onEdit && !busy && (
              <Pressable onPress={() => onEdit(message.id)} hitSlop={8} style={styles.action} accessibilityLabel="Edit message">
                <Feather name="edit-2" size={16} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
        )}
      </View>
    );
  }

  const streaming = message.status === 'streaming';
  const segments = segmentsOf(message);
  const lastSeg = segments[segments.length - 1];
  // A bare pulsing pill while the model is working with nothing streaming yet: before its first
  // token, and while it works out its next step after a round of tool calls. Streamed thoughts
  // pulse in their own pill instead.
  const waiting =
    streaming &&
    (!lastSeg ||
      (lastSeg.kind === 'tool' && (lastSeg.part.status === 'done' || lastSeg.part.status === 'error')) ||
      (lastSeg.kind === 'thought' && lastSeg.ms != null));
  // Compact and normal fold a reply's thinking away with its other work.
  const brief = detail === 'compact' || detail === 'normal';
  const split = splitWork(segments, brief);
  const answered = !!split?.text && (!streaming || split.text.length > ANSWER_CHARS);
  const working = streaming && !answered;
  // Compact and normal start folded; detailed shows the work until the answer comes; verbose keeps it.
  const workOpen = workOverride ?? (detail === 'verbose' || (detail === 'detailed' && !answered));
  // Folded work that's still under way shows its current step in one line, except when compact.
  const workStep =
    split && working && !workOpen && detail !== 'compact' ? (
      <CurrentStep seg={waiting ? null : split.work[split.work.length - 1]} onPress={() => setWorkOverride(true)} />
    ) : null;
  // From the start of the reply to the start of its answer; replies saved without that time add up their steps.
  const workedMs =
    split && answered && split.at
      ? split.at - message.createdAt
      : (split?.work ?? []).reduce(
          (ms, s) => ms + (s.kind === 'tool' ? (s.part.durationMs ?? 0) : s.kind === 'thought' ? (s.ms ?? 0) : 0),
          0
        );
  const sources = message.status === 'done' ? sourcesOf(message.content) : [];
  // Gathered at the end of the turn, since the calls that made them fold away with the work.
  const made = streaming ? [] : filesOf(message.content);

  // Questions waiting on the user show under the work rather than in it, where folding could hide them.
  const asking = message.content.filter((p): p is ToolPart => p.type === 'tool' && p.name === 'ask_user' && p.status === 'running');

  const render = (seg: Segment, i: number) =>
    seg.kind === 'tool' ? (
      !asking.includes(seg.part) && <ToolCall key={seg.part.id} part={seg.part} />
    ) : seg.kind === 'thought' ? (
      <Thoughts
        key={`r${i}`}
        text={seg.text}
        ms={seg.ms}
        live={streaming && seg === lastSeg && seg.ms == null}
        keepOpen={detail === 'verbose'}
      />
    ) : (
      !!seg.text.trim() && <Markdown key={`t${i}`} value={seg.text} live={streaming && seg === lastSeg} />
    );

  return (
    <View style={styles.assistantRow}>
      {split ? (
        <>
          <Work
            segments={split.work}
            open={workOpen}
            onToggle={() => setWorkOverride(!workOpen)}
            working={working}
            since={message.createdAt}
            ms={workedMs}
            step={workStep}
            render={render}
            content={message.content}
          />
          {split.answer.map((seg, i) => render(seg, split.work.length + i))}
        </>
      ) : (
        segments.map(render)
      )}
      {asking.map((part) => (
        <QuestionCard key={part.id} part={part} />
      ))}
      {/* Folded work already says the model is at it, in its header and current step. */}
      {waiting && !(split && !workOpen) && (
        <ThinkingIndicator
          thinking
          expanded={false}
          toggleable={false}
          label={activity}
          onToggle={() => {}}
        />
      )}
      {!!made.length && <TurnFiles files={made} />}
      {!onRegenerate && <RemoteReply chatId={conversationId} reply={message.remote} reconnect={!!message.error} />}
      {message.error && message.status !== 'error' && <Text style={{ color: colors.textSecondary }}>{message.error}</Text>}

      {message.status === 'error' && (
        <View style={[styles.error, { backgroundColor: colors.dangerBg, borderColor: colors.danger }]}>
          <View style={styles.reasonRow}>
            <Feather name="alert-circle" size={15} color={colors.danger} style={styles.reasonIcon} />
            <Text style={[styles.errorText, { color: colors.danger }]}>{message.error || 'Interrupted by an error'}</Text>
          </View>
          {onRegenerate && <Pressable
            onPress={() => onRegenerate(message.id)}
            style={[styles.retry, { borderColor: colors.danger }]}
            hitSlop={6}
          >
            <Feather name="rotate-ccw" size={14} color={colors.danger} />
            <Text style={{ color: colors.danger, fontWeight: '500' }}>Retry</Text>
          </Pressable>}
        </View>
      )}

      {message.status === 'done' && !!message.interrupted && (
        <View style={[styles.interrupted, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Feather name="pause-circle" size={14} color={colors.textSecondary} />
          <Text style={[styles.interruptedText, { color: colors.textSecondary }]}>{message.interrupted}</Text>
        </View>
      )}

      {message.status === 'done' && (
        <View style={styles.actions}>
          {!!message.fork && <Versions conversationId={conversationId} forkId={message.fork} disabled={busy} />}
          {!!text && (
            <Pressable onPress={copy} hitSlop={8} style={styles.action} accessibilityLabel="Copy reply">
              <Feather name={copied ? 'check' : 'copy'} size={16} color={colors.textSecondary} />
            </Pressable>
          )}
          {/* Regenerating keeps the reply it replaces as another version, so any reply can be redone. */}
          {onRegenerate && !busy && (
            <Pressable onPress={() => onRegenerate(message.id)} hitSlop={8} style={styles.action} accessibilityLabel="Regenerate reply">
              <Feather name="refresh-cw" size={16} color={colors.textSecondary} />
            </Pressable>
          )}
          {/* Branching off the newest reply would only copy the whole chat. */}
          {onBranch && !busy && !isLast && (
            <Pressable onPress={() => onBranch(message.id)} hitSlop={8} style={styles.action} accessibilityLabel="Branch in new chat">
              <MaterialCommunityIcons name="call-split" size={18} color={colors.textSecondary} />
            </Pressable>
          )}
          {!!message.model &&
            (friendly && message.model !== 'Clanker' ? (
              <View style={styles.modelBrand}>
                {brandOfModel(message.model) && <BrandIcon brand={brandOfModel(message.model)!} size={13} />}
                <Text numberOfLines={1} style={[styles.model, { color: colors.textTertiary, marginLeft: brandOfModel(message.model) ? 0 : 6 }]}>
                  {friendlyModelName(message.model) || message.model}
                </Text>
              </View>
            ) : (
              <Text numberOfLines={1} style={[styles.model, { color: colors.textTertiary }]}>
                {message.model}
              </Text>
            ))}
          {!!stats && <Text style={[styles.stats, { color: colors.textTertiary }]}>· {stats}</Text>}
          {!!sources.length && (
            <View style={styles.sources}>
              <SourcesButton sources={sources} />
            </View>
          )}
        </View>
      )}
      {!!message.memorySaved?.length && (
        <Pressable
          onPress={() => router.push('/settings/memory')}
          hitSlop={6}
          style={({ pressed }) => [styles.memory, pressed && { opacity: 0.5 }]}
          accessibilityLabel={`Memory updated: ${message.memorySaved.join('; ')}`}
        >
          <Feather name="bookmark" size={13} color={colors.textTertiary} />
          <Text numberOfLines={1} style={[styles.memoryText, { color: colors.textTertiary }]}>
            Memory updated · {message.memorySaved.join('; ')}
          </Text>
        </Pressable>
      )}
      {!!message.skillSaved?.length && (
        <Pressable
          onPress={() =>
            message.skillSaved!.length === 1
              ? router.push({ pathname: '/skills/skill', params: { name: message.skillSaved![0].name } })
              : router.push('/skills')
          }
          hitSlop={6}
          style={({ pressed }) => [styles.memory, pressed && { opacity: 0.5 }]}
          accessibilityLabel={skillLabel(message.skillSaved)}
        >
          <Feather name="book-open" size={13} color={colors.textTertiary} />
          <Text numberOfLines={1} style={[styles.memoryText, { color: colors.textTertiary }]}>
            {skillLabel(message.skillSaved)}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleInner);

/** "Skill learned · a · Skill improved · b", for the line under a reply the skill review changed. */
function skillLabel(saved: { name: string; created: boolean }[]) {
  const created = saved.filter((s) => s.created).map((s) => s.name);
  const improved = saved.filter((s) => !s.created).map((s) => s.name);
  return [created.length && `Skill learned · ${created.join(', ')}`, improved.length && `Skill improved · ${improved.join(', ')}`]
    .filter(Boolean)
    .join(' · ');
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', paddingHorizontal: 16, marginVertical: 10, gap: 6 },
  userBubble: { maxWidth: '82%', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10 },
  userText: { fontSize: 16, lineHeight: 23 },
  quote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    maxWidth: '82%',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  quoteIcon: { marginTop: 3 },
  quoteText: { fontSize: 14, lineHeight: 20, flexShrink: 1 },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, maxWidth: '82%' },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '82%',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 7,
    paddingRight: 12,
    paddingVertical: 7,
  },
  fileName: { fontSize: 15, flexShrink: 1 },
  assistantRow: { paddingHorizontal: 16, marginVertical: 6, gap: 2 },
  thoughts: { maxHeight: 260, marginVertical: 4 },
  thoughtsInner: { borderLeftWidth: 3, paddingLeft: 12, paddingRight: 4 },
  thoughtsText: { fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2, marginLeft: -6 },
  userActions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -2, marginRight: -6 },
  versions: { flexDirection: 'row', alignItems: 'center' },
  versionStep: { paddingVertical: 6, paddingHorizontal: 2 },
  versionText: { fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 26, textAlign: 'center' },
  action: { padding: 6 },
  modelBrand: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 6, minWidth: 0, flexShrink: 1 },
  model: { fontSize: 12, marginLeft: 6, flexShrink: 1 },
  stats: { fontSize: 12, fontVariant: ['tabular-nums'] },
  sources: { marginLeft: 'auto' },
  memory: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: 4 },
  memoryText: { fontSize: 13, flexShrink: 1 },
  workHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, marginLeft: 2, alignSelf: 'flex-start' },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, marginLeft: 2, maxWidth: '100%' },
  stepText: { fontSize: 14, flexShrink: 1 },
  stepSpinner: { transform: [{ scale: 0.7 }], marginVertical: -4 },
  workLabel: { fontSize: 15, fontWeight: '500' },
  error: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10, marginTop: 4 },
  reasonRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  reasonIcon: { marginTop: 2.5 },
  errorText: { flex: 1, fontSize: 14, lineHeight: 20 },
  interrupted: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 4,
  },
  interruptedText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
