import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { deleteAttachment } from '@/lib/attachments';
import type { AttachmentPart, ContentPart, Role, ToolPart } from '@/lib/providers';
import { splitJsonFileStorage, uid } from '@/lib/storage';
import { chatWorkspace } from '@/lib/workspace';
import type { Memory } from './memory';
import type { SkillRef } from './skills';
import type { RemoteReply, RemoteSession } from '@/lib/remote/types';
import { removeRemoteCache } from '@/lib/remote/cache';

export type MessageStatus = 'streaming' | 'done' | 'error';

export interface Message {
  remote?: RemoteReply;
  id: string;
  role: Role;
  content: ContentPart[];
  createdAt: number;
  status: MessageStatus;
  error?: string;
  /** Reason the reply stopped early (user stopped, step limit, app closed). */
  interrupted?: string;
  /**
   * Set when the app picked the reply back up on its own after being closed mid-reply (see
   * resumeInterruptedReplies in lib/chat). A reply cut off again while so marked is left for the user.
   */
  autoResumed?: true;
  /** Set while a running reply wraps up to answer from what it has (see answerNow in lib/chat). */
  answerNow?: true;
  model?: string;
  /** Thinking from replies saved before thoughts became `thought` content parts. */
  reasoning?: string;
  /** How long the legacy `reasoning` took, in ms. */
  thoughtMs?: number;
  /** Memories the after-reply pass saved or changed from this reply. */
  memorySaved?: string[];
  /** Skills the after-reply review saved or improved from this reply, by name. */
  skillSaved?: { name: string; created: boolean }[];
  /** Numbers from each model response that made up this reply (see lib/stats). */
  steps?: StepStats[];
  /** Decode speed and cache hits over the chat's last few responses, as of this reply's last one. */
  stats?: ReplyStats;
  /** Set on the first message of each version of a fork: the key of the fork in `forks`. */
  fork?: string;
  /** A user message the app sent on the user's behalf: 'goal' keeps a goal going (see lib/chat). */
  auto?: 'goal';
}

/**
 * Where the conversation splits into versions, made by editing a message or regenerating a reply.
 * Each version is the run of messages from the split to the end of the chat as it was. The one
 * on screen lives in `messages` and its slot here is empty; switching swaps them.
 */
export interface Fork {
  versions: Message[][];
  /** The version shown. */
  current: number;
}

/**
 * One model response: `tokens` generated over `ms` (0 when too quick to time), and the prompt
 * tokens it sent and had cached, where the server said.
 */
export type StepStats = { tokens: number; ms: number; input?: number; cached?: number };

export type ReplyStats = { tokensPerSec?: number; cacheHit?: number };

/**
 * A range of the history the model replaced with its own summary, to save context. `start` and
 * `end` are history unit keys (see lib/context). The originals stay in `messages`; only what is
 * sent to the model changes. A block that swallowed earlier blocks keeps them as `children`.
 */
export interface CompressionBlock {
  id: string;
  start: string;
  end: string;
  summary: string;
  createdAt: number;
  /** Made by the app when the context ran over budget, not by the model. */
  auto?: boolean;
  /** Set on a block the user made with /compact: the estimated tokens of history it replaced. */
  compacted?: number;
  children?: CompressionBlock[];
}

/**
 * The volatile state (time, history size, workspace, jobs) sent after a history unit when it was
 * the latest one. Kept and resent as it was, so earlier history never changes and prompts cache.
 */
export interface ContextNote {
  text: string;
  /** The workspace listing, when the note shows it (only when it changed since the last one). */
  workspace?: string;
  /** Memory changes since the chat began, when the note shows them (only when they changed). */
  memory?: string;
  /** Skill changes since the chat began, when the note shows them (only when they changed). */
  skills?: string;
  /** Plan mode's rules, goal and todo list as the note showed them (empty: none); shown only when they changed. */
  plan?: string;
  goal?: string;
  todos?: string;
}

/** A message the user sent while a reply was running, waiting to go out. */
export interface QueuedMessage {
  remoteEffort?: string;
  id: string;
  text: string;
  attachments: AttachmentPart[];
  /** Joins the running reply at its next step (see lib/chat) instead of waiting for it to finish. */
  steer?: boolean;
}

export interface Conversation {
  /** Immutable execution backend; missing on legacy chats means built-in Clanker. */
  backendId?: string;
  remote?: RemoteSession;
  id: string;
  title: string;
  /** True once a model-generated (or user-set) title replaced the placeholder. */
  titled: boolean;
  createdAt: number;
  updatedAt: number;
  endpointId: string;
  model: string;
  messages: Message[];
  /** Top-level compression blocks, in history order. */
  compressions?: CompressionBlock[];
  /**
   * Workspace files the model has seen, as path → "mtime:size" when it last read or wrote them.
   * write_file and edit_file refuse files that are missing here or changed since.
   */
  observed?: Record<string, string>;
  /** Context notes by history unit key (see lib/context). */
  notes?: Record<string, ContextNote>;
  /** False for a temporary chat, which neither uses nor saves memories. */
  memory?: false;
  /**
   * The memories as they were at the chat's first request. They go in its system prompt, which
   * must not change; later changes reach the model through context notes.
   */
  memoryBase?: Memory[];
  /** The skills offered at the chat's first request with tools; like memoryBase, for a stable system prompt. */
  skillBase?: SkillRef[];
  /** The project the chat belongs to; it works in the project's workspace. */
  projectId?: string;
  /** Set on chats from before workspaces were per chat: they keep the one they all shared. */
  workspace?: 'shared';
  /** When it was pinned to the top of the chat lists; unset when it isn't. */
  pinnedAt?: number;
  /** When it was archived: hidden from the chat lists unless Settings shows archived chats. */
  archivedAt?: number;
  /** Messages waiting for the running reply, oldest first. */
  queue?: QueuedMessage[];
  /** The chat this one was branched off (see lib/chat branchToNewChat); its titles say so. */
  branchedFrom?: string;
  /** The versions hidden behind each fork in the chat (see Fork), by key. */
  forks?: Record<string, Fork>;
  /** What the chat is working toward, until the model marks it done or it is cleared. */
  goal?: Goal;
  /** Set while the chat is in plan mode: replies only look into the task, then propose a plan. */
  plan?: PlanMode;
  /** The agent's todo list for the task in hand (see the todo_write tool). */
  todos?: Todo[];
}

/** A goal: replies keep going on their own until the model calls goal_done (see lib/chat). */
export interface Goal {
  text: string;
  setAt: number;
  /** Turns the app has sent in a row to keep it going; a message from the user starts the count over. */
  turns: number;
  /**
   * Set while the goal waits for the user instead of being kept going. `manual` means the user
   * paused it, so only they resume it; otherwise their next message does.
   */
  paused?: { reason: string; manual?: boolean };
  /** Who set it: the user with /goal, the model with goal_start, or the approval of a plan. */
  by?: 'user' | 'agent' | 'plan';
  /** The approved plan the goal carries out, in Markdown. */
  plan?: string;
  /** Turns in a row that ended without a single tool call, which hints the model is stuck or waiting. */
  idle?: number;
}

/** Plan mode (see lib/chat and lib/tools/planning): the chat researches and proposes before anything changes. */
export interface PlanMode {
  startedAt: number;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
}

interface ChatsState {
  conversations: Record<string, Conversation>;
  create: (endpointId: string, model: string, opts?: { memory?: false; projectId?: string; backendId?: string; remote?: RemoteSession }) => string;
  setRemote: (id: string, patch: Partial<RemoteSession>) => void;
  remove: (id: string) => void;
  rename: (id: string, title: string, titled?: boolean) => void;
  setModel: (id: string, endpointId: string, model: string) => void;
  /** Takes effect from the next turn; the bridge checks the model is one it offers. */
  setRemoteModel: (id: string, model: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  /** Archiving also unpins. */
  setArchived: (id: string, archived: boolean) => void;
  /**
   * Puts the chat in a project (undefined: in none, with a workspace of its own). Only the record:
   * lib/projects moveChatToProject also brings its files. What the model has seen and the
   * memories its prompt shows start over, since its files and memory pool can change.
   */
  moveTo: (id: string, projectId: string | undefined) => void;
  addMessage: (id: string, message: Omit<Message, 'id' | 'createdAt'>) => string;
  updateMessage: (id: string, messageId: string, patch: Partial<Message>) => void;
  appendText: (id: string, messageId: string, text: string) => void;
  /** Extends the thought part at the end of the reply, or starts a new one after other parts. */
  appendReasoning: (id: string, messageId: string, text: string) => void;
  /** Records how long the reply's latest thought part took. */
  finishThought: (id: string, messageId: string, ms: number) => void;
  patchTool: (id: string, messageId: string, toolId: string, patch: Partial<ToolPart>) => void;
  /** Updates tool calls still being written in place, by id, and appends the ones that are new. */
  putDrafts: (id: string, messageId: string, drafts: ToolPart[]) => void;
  /**
   * What a reply streamed since the last update, in one store update rather than one per kind:
   * thinking, then text, then the calls still being written (as appendReasoning, appendText and putDrafts).
   */
  appendStream: (id: string, messageId: string, chunk: { reasoning?: string; text?: string; drafts?: ToolPart[] }) => void;
  /** Replaces the calls still being written with `parts`, where the first of them was. */
  settleDrafts: (id: string, messageId: string, parts: ContentPart[]) => void;
  setCompressions: (id: string, blocks: CompressionBlock[]) => void;
  setNote: (id: string, key: string, note: ContextNote) => void;
  setQueue: (id: string, queue: QueuedMessage[]) => void;
  setMemoryBase: (id: string, memories: Memory[]) => void;
  setSkillBase: (id: string, skills: SkillRef[]) => void;
  /** Sets the chat's goal, or with undefined, clears it. */
  setGoal: (id: string, goal: Goal | undefined) => void;
  /** Puts the chat in plan mode, or with undefined, takes it out. */
  setPlan: (id: string, plan: PlanMode | undefined) => void;
  /** Replaces the chat's todo list; undefined or an empty list clears it. */
  setTodos: (id: string, todos: Todo[] | undefined) => void;
  /** Records file signatures as seen by the model; null forgets a path. */
  observe: (id: string, entries: Record<string, string | null>) => void;
  /** Removes the message with `messageId` and everything after it. */
  truncateFrom: (id: string, messageId: string) => void;
  /**
   * Starts a new version of the chat at `messageId` with `message` in its place, keeping that
   * message and everything after it as the version before. With `replace`, the old run is
   * dropped instead (a failed reply being retried). Returns the new message's id.
   */
  branch: (id: string, messageId: string, message: Omit<Message, 'id' | 'createdAt'>, opts?: { replace?: boolean }) => string;
  /** Shows version `index` of a fork in place of the one on screen. */
  switchVersion: (id: string, forkId: string, index: number) => void;
  /** Adds a whole conversation, as made by copying one (see lib/chat branchToNewChat). */
  insert: (conversation: Conversation) => void;
}

/** A tool call the model is still writing. */
function isDraft(part: ContentPart): boolean {
  return part.type === 'tool' && part.status === 'writing';
}

function withText(content: ContentPart[], text: string): ContentPart[] {
  const last = content[content.length - 1];
  return last?.type === 'text'
    ? [...content.slice(0, -1), { ...last, text: last.text + text }]
    : [...content, { type: 'text', text, at: Date.now() }];
}

function withReasoning(content: ContentPart[], text: string): ContentPart[] {
  const last = content[content.length - 1];
  return last?.type === 'thought' && last.ms == null
    ? [...content.slice(0, -1), { ...last, text: last.text + text }]
    : [...content, { type: 'thought', text }];
}

function withDrafts(content: ContentPart[], drafts: ToolPart[]): ContentPart[] {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const next = content.map((p) => {
    const draft = p.type === 'tool' && isDraft(p) && byId.get(p.id);
    if (!draft) return p;
    byId.delete(draft.id);
    return draft;
  });
  return [...next, ...byId.values()];
}

/** Every message in the chat, the versions hidden behind its forks included. */
export function allMessages(c: Pick<Conversation, 'messages' | 'forks'>): Message[] {
  return [...c.messages, ...Object.values(c.forks ?? {}).flatMap((f) => f.versions.flat())];
}

function imagesOf(messages: Pick<Message, 'content'>[]) {
  return messages.flatMap((m) =>
    m.content.flatMap((p) =>
      p.type === 'tool'
        ? (p.images ?? []).map((img) => img.file)
        : (p.type === 'image' || p.type === 'file') && p.file
          ? [p.file]
          : []
    )
  );
}

/**
 * Chats whose last reply was still being written when the app was closed, found as the chats load.
 * Declared before the store: storage is read synchronously, so loading runs as the store is made.
 */
const cutOffAtLaunch = new Set<string>();

/** The chats with a reply the app was closed in the middle of, once: later calls get none. */
export function takeCutOffReplies(): string[] {
  const ids = [...cutOffAtLaunch];
  cutOffAtLaunch.clear();
  return ids;
}

export const useChats = create<ChatsState>()(
  persist(
    (set, get) => {
      const patchConversation = (id: string, fn: (c: Conversation) => Partial<Conversation>) =>
        set((s) => {
          const c = s.conversations[id];
          if (!c) return s;
          return { conversations: { ...s.conversations, [id]: { ...c, ...fn(c) } } };
        });

      // A message in a version off screen still takes updates, as from a background job finishing.
      const patchMessage = (id: string, messageId: string, fn: (m: Message) => Partial<Message>) =>
        patchConversation(id, (c) => {
          const patch = (list: Message[]) => list.map((m) => (m.id === messageId ? { ...m, ...fn(m) } : m));
          if (c.messages.some((m) => m.id === messageId) || !c.forks) return { messages: patch(c.messages) };
          const forks = Object.fromEntries(
            Object.entries(c.forks).map(([key, f]) => [key, { ...f, versions: f.versions.map(patch) }])
          );
          return { forks };
        });

      return {
        conversations: {},
        create: (endpointId, model, opts) => {
          const id = uid();
          const now = Date.now();
          set((s) => ({
            conversations: {
              ...s.conversations,
              [id]: {
                id,
                title: 'New chat',
                titled: false,
                createdAt: now,
                updatedAt: now,
                endpointId,
                model,
                backendId: opts?.backendId ?? 'local',
                ...(opts?.remote ? { remote: opts.remote } : {}),
                messages: [],
                ...(opts?.memory === false ? { memory: false as const } : {}),
                ...(opts?.projectId ? { projectId: opts.projectId } : {}),
              },
            },
          }));
          return id;
        },
        remove: (id) => {
          const c = get().conversations[id];
          if (!c) return;
          try { removeRemoteCache(id); } catch {}
          imagesOf([...allMessages(c), ...(c.queue ?? []).map((q) => ({ content: q.attachments }))]).forEach(deleteAttachment);
          if (!c.projectId && !c.workspace) {
            try {
              chatWorkspace(id).remove();
            } catch {
              // The files stay behind; Settings → Agent → Workspace files can still delete them.
            }
          }
          set((s) => {
            const { [id]: _, ...rest } = s.conversations;
            return { conversations: rest };
          });
        },
        rename: (id, title, titled = true) => patchConversation(id, () => ({ title, titled })),
        setModel: (id, endpointId, model) => patchConversation(id, (c) =>
          c.backendId && c.backendId !== 'local' ? {} : { endpointId, model }),
        setRemoteModel: (id, model) => patchConversation(id, (c) =>
          c.backendId && c.backendId !== 'local' ? { model } : {}),
        setRemote: (id, patch) => patchConversation(id, (c) => ({ remote: { ...c.remote!, ...patch } })),
        setPinned: (id, pinned) => patchConversation(id, () => ({ pinnedAt: pinned ? Date.now() : undefined })),
        setArchived: (id, archived) =>
          patchConversation(id, (c) => ({
            archivedAt: archived ? Date.now() : undefined,
            pinnedAt: archived ? undefined : c.pinnedAt,
          })),
        moveTo: (id, projectId) =>
          patchConversation(id, () => ({ projectId, workspace: undefined, observed: undefined, memoryBase: undefined })),
        addMessage: (id, message) => {
          const messageId = uid();
          const now = Date.now();
          patchConversation(id, (c) => ({
            updatedAt: now,
            messages: [...c.messages, { ...message, id: messageId, createdAt: now }],
          }));
          return messageId;
        },
        updateMessage: (id, messageId, patch) => patchMessage(id, messageId, () => patch),
        appendText: (id, messageId, text) => patchMessage(id, messageId, (m) => ({ content: withText(m.content, text) })),
        appendReasoning: (id, messageId, text) =>
          patchMessage(id, messageId, (m) => ({ content: withReasoning(m.content, text) })),
        appendStream: (id, messageId, { reasoning, text, drafts }) => {
          if (!reasoning && !text && !drafts?.length) return;
          patchMessage(id, messageId, (m) => {
            let content = m.content;
            if (reasoning) content = withReasoning(content, reasoning);
            if (text) content = withText(content, text);
            if (drafts?.length) content = withDrafts(content, drafts);
            return { content };
          });
        },
        finishThought: (id, messageId, ms) =>
          patchMessage(id, messageId, (m) => {
            const index = m.content.findLastIndex((p) => p.type === 'thought');
            if (index < 0) return {};
            return { content: m.content.map((p, i) => (i === index ? { ...p, ms } : p)) };
          }),
        patchTool: (id, messageId, toolId, patch) =>
          patchMessage(id, messageId, (m) => ({
            content: m.content.map((p) => (p.type === 'tool' && p.id === toolId ? { ...p, ...patch } : p)),
          })),
        putDrafts: (id, messageId, drafts) => patchMessage(id, messageId, (m) => ({ content: withDrafts(m.content, drafts) })),
        settleDrafts: (id, messageId, parts) =>
          patchMessage(id, messageId, (m) => {
            const first = m.content.findIndex(isDraft);
            if (first < 0) return { content: [...m.content, ...parts] };
            const before = m.content.slice(0, first);
            const after = m.content.slice(first).filter((p) => !isDraft(p));
            return { content: [...before, ...parts, ...after] };
          }),
        setCompressions: (id, compressions) => patchConversation(id, () => ({ compressions })),
        setNote: (id, key, note) => patchConversation(id, (c) => ({ notes: { ...c.notes, [key]: note } })),
        setQueue: (id, queue) => patchConversation(id, () => ({ queue: queue.length ? queue : undefined })),
        setMemoryBase: (id, memoryBase) => patchConversation(id, () => ({ memoryBase })),
        setSkillBase: (id, skillBase) => patchConversation(id, () => ({ skillBase })),
        setGoal: (id, goal) => patchConversation(id, () => ({ goal })),
        setPlan: (id, plan) => patchConversation(id, () => ({ plan })),
        setTodos: (id, todos) => patchConversation(id, () => ({ todos: todos?.length ? todos : undefined })),
        observe: (id, entries) =>
          patchConversation(id, (c) => {
            const observed = { ...c.observed };
            for (const [path, sig] of Object.entries(entries)) {
              if (sig == null) delete observed[path];
              else observed[path] = sig;
            }
            return { observed };
          }),
        truncateFrom: (id, messageId) =>
          patchConversation(id, (c) => {
            const index = c.messages.findIndex((m) => m.id === messageId);
            if (index < 0) return {};
            // Images in the dropped messages are kept: regenerate only drops assistant replies.
            return { messages: c.messages.slice(0, index) };
          }),
        branch: (id, messageId, message, opts) => {
          const newId = uid();
          const now = Date.now();
          patchConversation(id, (c) => {
            const index = c.messages.findIndex((m) => m.id === messageId);
            if (index < 0) return {};
            const head = c.messages[index];
            const before = c.messages.slice(0, index);
            const added = { ...message, id: newId, createdAt: now };
            if (opts?.replace) {
              return { updatedAt: now, messages: [...before, head.fork ? { ...added, fork: head.fork } : added] };
            }
            const forkId = head.fork ?? uid();
            const fork = c.forks?.[forkId] ?? { versions: [[]], current: 0 };
            const old = c.messages.slice(index).map((m, i) => (i === 0 ? { ...m, fork: forkId } : m));
            const versions = [...fork.versions.map((v, i) => (i === fork.current ? old : v)), []];
            return {
              updatedAt: now,
              messages: [...before, { ...added, fork: forkId }],
              forks: { ...c.forks, [forkId]: { versions, current: versions.length - 1 } },
            };
          });
          return newId;
        },
        switchVersion: (id, forkId, to) =>
          patchConversation(id, (c) => {
            const fork = c.forks?.[forkId];
            const index = c.messages.findIndex((m) => m.fork === forkId);
            if (!fork || index < 0 || to === fork.current || !fork.versions[to]?.length) return {};
            const versions = fork.versions.map((v, i) => (i === fork.current ? c.messages.slice(index) : i === to ? [] : v));
            return {
              messages: [...c.messages.slice(0, index), ...fork.versions[to]],
              forks: { ...c.forks, [forkId]: { versions, current: to } },
            };
          }),
        insert: (conversation) =>
          set((s) => ({ conversations: { ...s.conversations, [conversation.id]: conversation } })),
      };
    },
    {
      name: 'chats',
      // A file per chat, so saving while a reply streams writes that chat rather than every one.
      storage: splitJsonFileStorage('conversations'),
      partialize: (s) => ({ conversations: s.conversations }),
      version: 2,
      // v0 chats all worked in one shared workspace; they keep it, while new chats get their own.
      migrate: (persisted, version) => {
        const state = persisted as Pick<ChatsState, 'conversations'>;
        if (version < 1) for (const c of Object.values(state?.conversations ?? {})) c.workspace = 'shared';
        if (version < 2) for (const c of Object.values(state?.conversations ?? {})) c.backendId = 'local';
        return state;
      },
      // A reply, tool call or background job that was running when the app was killed can never finish,
      // and messages meant to steer it wait in the queue like any other.
      merge: (persisted, current) => {
        const conversations = (persisted as Pick<ChatsState, 'conversations'>)?.conversations ?? {};
        for (const c of Object.values(conversations)) {
          c.backendId ??= 'local';
          if (c.queue) c.queue = c.queue.map(({ steer: _, ...q }) => q);
          const settle = (m: Message): Message => {
            const content = m.content.map((p) =>
              p.type === 'tool' && p.background?.status === 'running' ? { ...p, background: { ...p.background, status: 'lost' as const } } : p
            );
            return m.status === 'streaming' && c.backendId === 'local'
              ? { ...m, status: 'done', content: interruptContent(content), interrupted: 'Interrupted when the app closed' }
              : { ...m, content };
          };
          // A reply cut off at the end of the chat is picked up again once the app is up, unless it
          // was already being picked up: the reply itself may be what keeps getting the app killed.
          const last = c.messages[c.messages.length - 1];
          if (last?.role === 'assistant' && last.status === 'streaming' && c.backendId === 'local' && !last.autoResumed) {
            cutOffAtLaunch.add(c.id);
          }
          c.messages = c.messages.map(settle);
          for (const f of Object.values(c.forks ?? {})) f.versions = f.versions.map((v) => v.map(settle));
        }
        return { ...current, conversations };
      },
    }
  )
);

/**
 * Settles a reply that stopped partway, so the history stays valid for the API: tool calls that
 * never got a result are marked failed, and calls the model never finished writing are dropped.
 */
export function interruptContent(content: ContentPart[]): ContentPart[] {
  return content
    .filter((p) => !isDraft(p))
    .map((p) =>
      p.type === 'tool' && p.status === 'running'
        ? { ...p, status: 'error', output: p.output ?? 'Interrupted before it finished.' }
        : p
    );
}

export function messageText(message: Pick<Message, 'content'>) {
  return message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** Whether a reply is being written in the chat. Only its last message can be (a steered reply ends before the next starts). */
export function isWorking(c: Pick<Conversation, 'messages'>) {
  return c.messages[c.messages.length - 1]?.status === 'streaming';
}

/**
 * Every conversation, for lists of chats. It changes when a chat comes or goes or what lists show
 * of it does (title, times, pins, project, message count, whether it's working), not with every
 * token a reply streams.
 */
export function useChatList(): Record<string, Conversation> {
  const signature = useChats(
    useShallow((s) =>
      Object.values(s.conversations).flatMap((c) => [
        c.id,
        c.title,
        c.updatedAt,
        c.pinnedAt,
        c.archivedAt,
        c.projectId,
        c.messages.length,
        isWorking(c),
      ])
    )
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => useChats.getState().conversations, [signature]);
}
