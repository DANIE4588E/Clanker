import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from '@/lib/haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Fragment, memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { attachmentUri } from '@/lib/attachments';
import { answerNow } from '@/lib/chat';
import type { ContentPart, FilePart, ImagePart, ToolPart } from '@/lib/providers';
import { mentionSpans, sentLabels } from '@/lib/mentions';
import { splitQuotes } from '@/lib/quotes';
import { sitesOf, sourcesOf, type Site } from '@/lib/sources';
import { formatStats } from '@/lib/stats';
import { useTheme } from '@/lib/theme';
import { useActivityLabel } from '@/lib/local/useActivityLabel';
import { useWorkspace } from '@/lib/useWorkspace';
import { messageText, useChats, type Message } from '@/store/chats';
import { LOCAL_ENDPOINT_ID } from '@/store/localModels';
import { describeCall } from '@/lib/tools/describe';
import { useSettings } from '@/store/settings';
import { BrandIcon } from './BrandIcon';
import { CompactionMarker } from './CompactionMarker';
import { FileIcon } from './FileIcon';
import { useFindMarker } from './FindHighlight';
import { brandOfModel, friendlyModelName } from '@/lib/modelNames';
import { RemoteReply } from './RemoteReply';
import { areasSelect, SelectionArea } from './SelectionArea';
import { ChatImage } from './ImageCards';
import { Markdown, markdownImageSources } from './Markdown';
import { ReplyProvider } from './study/shared';
import { NestedScroll } from './NestedScroll';
import { PlanCard } from './PlanCard';
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
function segmentsOf(content: ContentPart[], reasoning?: string, thoughtMs?: number): Segment[] {
  // Replies saved before thoughts were content parts keep theirs in one block at the top.
  const out: Segment[] = reasoning ? [{ kind: 'thought', text: reasoning, ms: thoughtMs }] : [];
  for (const part of content) {
    const last = out[out.length - 1];
    if (part.type === 'text') {
      if (last?.kind === 'text') last.text += part.text;
      else out.push({ kind: 'text', text: part.text, at: part.at });
    } else if (part.type === 'tool') out.push({ kind: 'tool', part });
    else if (part.type === 'thought') out.push({ kind: 'thought', text: part.text, ms: part.ms });
  }
  return out;
}

/** A fold of a list's first `count` parts, made from `parts`. */
type Snapshot<S> = { parts: readonly unknown[]; count: number; state: S };

/**
 * Folds `parts` with `step`, picking up from the fold of a prefix made for an earlier version of
 * the same list. Parts are replaced rather than changed, and a streaming reply only changes its
 * last part or adds more, so all but the newest parts fold once rather than on every token.
 * Snapshots are kept by the last part they cover; `copy` keeps them from being changed.
 */
function foldParts<T extends object, S>(
  parts: readonly T[],
  cache: WeakMap<T, Snapshot<S>>,
  init: () => S,
  copy: (state: S) => S,
  step: (state: S, part: T) => void
): S {
  const n = parts.length;
  let state: S | null = null;
  let from = 0;
  // The newest snapshot still in this list: one part back while the last grows, a few after a round of calls lands.
  for (let j = n - 2; j >= 0 && j >= n - 5 && !state; j--) {
    const snap = cache.get(parts[j]);
    if (!snap || snap.count !== j + 1) continue;
    let same = true;
    for (let i = 0; i < j && same; i++) same = snap.parts[i] === parts[i];
    if (same) {
      state = copy(snap.state);
      from = j + 1;
    }
  }
  state ??= init();
  for (let i = from; i < n - 1; i++) step(state, parts[i]);
  if (n >= 2 && from < n - 1) cache.set(parts[n - 2], { parts, count: n - 1, state: copy(state) });
  if (n >= 1 && from < n) step(state, parts[n - 1]);
  return state;
}

const segmentSnapshots = new WeakMap<ContentPart, Snapshot<Segment[]>>();

/** segmentsOf for a reply without top-level reasoning, folded incrementally as it streams. */
function streamedSegments(content: ContentPart[]): Segment[] {
  return foldParts<ContentPart, Segment[]>(
    content,
    segmentSnapshots,
    () => [],
    (s) => s.slice(),
    (out, part) => {
      const last = out[out.length - 1];
      if (part.type === 'text') {
        // A new segment rather than a longer one: snapshots share the segments they hold.
        if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + part.text, at: last.at };
        else out.push({ kind: 'text', text: part.text, at: part.at });
      } else if (part.type === 'tool') out.push({ kind: 'tool', part });
      else if (part.type === 'thought') out.push({ kind: 'thought', text: part.text, ms: part.ms });
    }
  );
}

type SiteFold = { sites: Map<string, Site>; searched: boolean };
const siteSnapshots = new WeakMap<ContentPart, Snapshot<SiteFold>>();

/** sitesOf, folded incrementally as the reply streams. */
function streamedSites(content: ContentPart[]): { sites: Site[]; searched: boolean } {
  const fold = foldParts<ContentPart, SiteFold>(
    content,
    siteSnapshots,
    () => ({ sites: new Map(), searched: false }),
    (s) => ({ sites: new Map(s.sites), searched: s.searched }),
    (s, part) => {
      if (part.type !== 'tool') return;
      // sitesOf for one part, added to what came before it.
      const one = sitesOf([part]);
      s.searched ||= one.searched;
      for (const site of one.sites) if (!s.sites.has(site.host)) s.sites.set(site.host, site);
    }
  );
  return { sites: [...fold.sites.values()], searched: fold.searched };
}

// While a reply streams, the text after its last step could be another progress note. Use its
// length to decide when to stop showing the working timer, independent of which text is visible.
const ANSWER_CHARS = 240;

/** Finds the work boundary for replies with tool calls, or with thoughts in compact and normal mode. */
function splitWork(segments: Segment[], thoughts: boolean) {
  const end = segments.findLastIndex((s) => s.kind !== 'text');
  if (end < 0 || (!thoughts && !segments.some((s) => s.kind === 'tool'))) return null;
  const answer = segments[end + 1];
  return answer?.kind === 'text' ? { end, chars: answer.text.trim().length, at: answer.at } : { end, chars: 0 };
}

function isImageRead(part: ContentPart): part is ToolPart & { input: { path: string }; images: ImagePart[] } {
  return part.type === 'tool' && part.name === 'read_file' && part.status === 'done' &&
    typeof part.input.path === 'string' && !!part.images?.length;
}

/** Images read from the workspace can illustrate the reply at the point where they were read. */
function imageReads(content: ContentPart[], segments: Segment[], ws: ReturnType<typeof useWorkspace>) {
  const reads = content.filter(isImageRead);
  const previews = new Map<ToolPart, string>();
  if (!reads.length) return previews;

  const seen = new Set<string>();
  if (ws) {
    for (const seg of segments) {
      if (seg.kind !== 'text') continue;
      for (const src of markdownImageSources(seg.text)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
        try {
          const path = ws.normalizePath(src);
          // If the original was moved or deleted, the stored preview can still be shown.
          if (path && ws.fileAt(path).exists) seen.add(path);
        } catch {
          // An invalid image destination does not replace a tool preview.
        }
      }
    }
  }
  for (const part of reads) {
    let path = part.input.path;
    try {
      path = ws?.normalizePath(path) ?? path;
    } catch {
      // The stored preview is still usable if the original path cannot be resolved.
    }
    if (!seen.has(path)) previews.set(part, path);
    seen.add(path);
  }
  return previews;
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

const TAIL = 300;

/** The end of a stretch of text on one line, so the newest words stay in view as it streams. */
function tail(text: string) {
  // Only the end is shown, so only the end is tidied: what's left of the last 600 characters, once
  // tidied, ends the same as the whole text tidied, and is the answer when it's long enough.
  const end = text.length > TAIL * 2 ? text.slice(-TAIL * 2).replace(/\s+/g, ' ').trim() : null;
  if (end != null && end.length > TAIL) return end.slice(-TAIL);
  return text.replace(/\s+/g, ' ').trim().slice(-TAIL);
}

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

/** The toggle for the tool calls and thoughts shown in the reply. */
function WorkHeader({
  open,
  onToggle,
  working,
  since,
  ms,
  content,
}: {
  open: boolean;
  onToggle: () => void;
  /** Whether the work is still under way: the reply streams and no answer has come yet. */
  working: boolean;
  /** When the reply started, for the running time. */
  since: number;
  /** How long the work took, once done. */
  ms: number;
  content: ContentPart[];
}) {
  const { colors } = useTheme();
  const elapsed = useElapsed(since, working);
  // Worked out again as the reply streams, but handed on only when the sites change.
  const found = streamedSites(content);
  const siteKey = `${found.searched}:${found.sites.map((s) => s.host).join(' ')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { sites, searched } = useMemo(() => found, [siteKey]);
  const label = working ? `Working for ${duration(elapsed)}` : `Worked for ${duration(ms)}`;
  return (
    <>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${open ? 'hide' : 'show'} steps`}
        accessibilityState={{ expanded: open }}
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
      <SiteChips sites={sites} searched={searched} />
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
const Thoughts = memo(function Thoughts({
  text,
  ms,
  live,
  keepOpen,
}: {
  text: string;
  ms?: number;
  live: boolean;
  keepOpen: boolean;
}) {
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
});

function MessageBubbleInner({ conversationId, message, isLast, onRegenerate, onEdit, onBranch, busy }: Props) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const showSpeed = useSettings((s) => s.decodeSpeed);
  const showCache = useSettings((s) => s.cacheHits);
  const friendly = useSettings((s) => s.friendlyModelNames);
  const detail = useSettings((s) => s.chatDetail);
  const ws = useWorkspace();
  // The user's own choice to show or hide the work, kept over what the detail level would do.
  const [workOverride, setWorkOverride] = useState<boolean | null>(null);
  // A reply from an on-device model first waits on the model loading and the prompt being read.
  const localModel = useChats((s) => {
    const c = s.conversations[conversationId];
    return c?.endpointId === LOCAL_ENDPOINT_ID && (!c.backendId || c.backendId === 'local') ? c.model : undefined;
  });
  const activity = useActivityLabel(message.status === 'streaming' ? localModel : undefined);
  // Find in chat's matches, marked in the user's text (replies mark theirs in Markdown).
  const mark = useFindMarker();
  const stats = formatStats(message.stats, { speed: showSpeed, cache: showCache });
  // A reply that worked for long has hundreds of parts, and it renders again with every streamed
  // token: what's read off its parts is worked out again only when they change.
  const { content, reasoning, thoughtMs } = message;
  const assistant = message.role === 'assistant';
  // A reply's whole text is only wanted once it's done (to copy it, and for its files).
  const streamingReply = assistant && message.status === 'streaming';
  const parts = useMemo(() => {
    const tools = content.filter((p): p is ToolPart => p.type === 'tool');
    return {
      text: streamingReply ? '' : messageText({ content }),
      images: content.filter((p): p is ImagePart => p.type === 'image'),
      files: content.filter((p): p is FilePart => p.type === 'file'),
      segments: assistant ? (reasoning ? segmentsOf(content, reasoning, thoughtMs) : streamedSegments(content)) : [],
      // Questions waiting on the user show under the work rather than in it, where folding could hide them.
      asking: tools.filter((p) => p.name === 'ask_user' && p.status === 'running'),
      // A plan being written or waiting for approval shows there too; once decided it folds into the work.
      planning: tools.filter((p) => p.name === 'exit_plan_mode' && (p.status === 'writing' || p.status === 'running')),
    };
  }, [content, reasoning, thoughtMs, assistant, streamingReply]);
  const { text, images, files, segments, asking, planning } = parts;
  // Gathered at the end of the turn, since the calls that made them fold away with the work.
  const finished = message.status === 'done';
  const sources = useMemo(() => (assistant && finished ? sourcesOf(content) : []), [assistant, finished, content]);
  const made = useMemo(() => (assistant && !streamingReply ? filesOf(content) : []), [assistant, streamingReply, content]);
  const readPreviews = useMemo(
    () => (assistant && !streamingReply ? imageReads(content, segments, ws) : null),
    [assistant, streamingReply, content, segments, ws]
  );

  const copy = async () => {
    await Clipboard.setStringAsync(text);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // The app's own nudge to keep a /goal going: a quiet line rather than a message from the user.
  if (message.role === 'user' && message.auto === 'goal') {
    return (
      <View style={styles.autoRow} accessibilityRole="text">
        <Feather name="target" size={13} color={colors.textTertiary} />
        <Text style={[styles.autoText, { color: colors.textTertiary }]}>Continuing toward the goal</Text>
      </View>
    );
  }

  if (message.role === 'user') {
    // Text the user picked from the chat to ask about rides at the top of the message as quotes.
    const { quotes, text: asked } = splitQuotes(text);
    // The @mentions and /commands it was found to have when sent, shown in color.
    const mentions = message.content.flatMap((p) => (p.type === 'text' ? (p.mentions ?? []) : []));
    return (
      <View style={styles.userRow}>
        <Images images={images} align="flex-end" />
        <Files files={files} align="flex-end" />
        {quotes.map((q, i) => (
          <View key={i} style={[styles.quote, { backgroundColor: colors.surface }]}>
            <Feather name="corner-down-right" size={14} color={colors.textSecondary} style={styles.quoteIcon} />
            <Text numberOfLines={2} style={[styles.quoteText, { color: colors.textSecondary }]}>
              {mark ? mark(q.replace(/\s+/g, ' ')) : q.replace(/\s+/g, ' ')}
            </Text>
          </View>
        ))}
        {!!asked && (
          // Held, the text selects where it can; otherwise holding copies it all.
          <Pressable onLongPress={areasSelect ? undefined : copy} style={[styles.userBubble, { backgroundColor: colors.userBubble }]}>
            <SelectionArea>
              <Text selectable={!areasSelect} style={[styles.userText, { color: colors.text }]}>
                {mentionSpans(asked, sentLabels(mentions)).map((s, i) =>
                  s.mention ? (
                    <Text key={i} style={{ color: colors.accentText }}>
                      {mark ? mark(s.text) : s.text}
                    </Text>
                  ) : (
                    <Fragment key={i}>{mark ? mark(s.text) : s.text}</Fragment>
                  )
                )}
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
  const answered = !!split?.chars && (!streaming || split.chars > ANSWER_CHARS);
  const working = streaming && !answered;
  // Compact and normal start folded; detailed shows the work until the answer comes; verbose keeps it.
  const workOpen = workOverride ?? (detail === 'verbose' || (detail === 'detailed' && working));
  const showSteps = !split || workOpen;
  // Folded work that's still under way shows its current step in one line, except when compact.
  const workStep =
    split && working && !workOpen && detail !== 'compact' ? (
      <CurrentStep seg={waiting ? null : segments[split.end]} onPress={() => setWorkOverride(true)} />
    ) : null;
  // From the start of the reply to the start of its answer; replies saved without that time add up their steps.
  const workedMs =
    split && answered && split.at
      ? split.at - message.createdAt
      : (split ? segments : []).reduce(
          (ms, s) => ms + (s.kind === 'tool' ? (s.part.durationMs ?? 0) : s.kind === 'thought' ? (s.ms ?? 0) : 0),
          0
        );
  // Once the model has thought or called tools, and until its answer is coming, it can be told to
  // answer from what it has. Local chats only (remote ones have no onRegenerate).
  const canAnswerNow =
    working && !!onRegenerate && segments.some((s) => s.kind !== 'text') && (split ? true : lastSeg?.kind !== 'text');

  const render = (seg: Segment, i: number) => {
    if (seg.kind === 'text') {
      return !!seg.text.trim() && <Markdown key={`t${i}`} value={seg.text} live={streaming && seg === lastSeg} />;
    }
    if (seg.kind === 'thought') {
      return showSteps && (
        <Thoughts
          key={`r${i}`}
          text={seg.text}
          ms={seg.ms}
          live={streaming && seg === lastSeg && seg.ms == null}
          keepOpen={detail === 'verbose'}
        />
      );
    }

    const part = seg.part;
    if (asking.includes(part) || planning.includes(part)) return null;
    if (part.name === 'exit_plan_mode') return showSteps && <PlanCard key={part.id} part={part} />;
    const path = readPreviews?.get(part);
    if (!showSteps && !path) return null;
    return (
      <Fragment key={`tool-${part.id}`}>
        {showSteps && <ToolCall part={part} showImages={!readPreviews || !isImageRead(part)} />}
        {path && part.images?.map((img) => (
          <ChatImage key={img.file} src={attachmentUri(img.file)} alt={path.split('/').pop()} link={path} fit="contain" />
        ))}
      </Fragment>
    );
  };

  return (
    <View style={styles.assistantRow}>
      {split && (
        <WorkHeader
          open={workOpen}
          onToggle={() => setWorkOverride(!workOpen)}
          working={working}
          since={message.createdAt}
          ms={workedMs}
          content={message.content}
        />
      )}
      {segments.map(render)}
      {workStep}
      {asking.map((part) => (
        <QuestionCard key={part.id} part={part} />
      ))}
      {planning.map((part) => (
        <PlanCard key={part.id} part={part} />
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
      {canAnswerNow && (
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            answerNow(conversationId);
          }}
          disabled={!!message.answerNow}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Answer now"
          accessibilityHint="Stops the work and answers from what it has found so far"
          accessibilityState={{ disabled: !!message.answerNow }}
          style={({ pressed }) => [
            styles.answerNow,
            { backgroundColor: colors.surface, borderColor: colors.border },
            (pressed || !!message.answerNow) && { opacity: 0.6 },
          ]}
        >
          {message.answerNow ? (
            <ActivityIndicator size="small" color={colors.textSecondary} style={styles.stepSpinner} />
          ) : (
            <Feather name="fast-forward" size={13} color={colors.text} />
          )}
          <Text style={[styles.answerNowText, { color: message.answerNow ? colors.textSecondary : colors.text }]}>
            {message.answerNow ? 'Answering…' : 'Answer now'}
          </Text>
        </Pressable>
      )}
      {!!made.length && <TurnFiles files={made} text={text} />}
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

/** The message, and below it the mark of a /compact that summarised the chat up to it, if any. */
function MessageWithCompaction(props: Props) {
  return (
    <>
      {/* Study cards in a reply send the user's results back to its chat. */}
      <ReplyProvider conversationId={props.conversationId}>
        <MessageBubbleInner {...props} />
      </ReplyProvider>
      <CompactionMarker conversationId={props.conversationId} messageId={props.message.id} />
    </>
  );
}

export const MessageBubble = memo(MessageWithCompaction);

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
  autoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16, marginVertical: 8 },
  autoText: { fontSize: 13 },
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
  answerNow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 6,
  },
  answerNowText: { fontSize: 13, fontWeight: '500' },
});
