import { interruptContent, messageText, takeCutOffReplies, useChats, type CompressionBlock, type Conversation, type Message, type QueuedMessage } from '@/store/chats';
import { resolveBudget, resolveEffort, resolveTaskModel, useSettings } from '@/store/settings';
import { localToolsOn } from '@/store/localModels';
import { useUI } from '@/store/ui';
import { deleteAttachment, duplicateAttachment, readAttachmentBase64, saveToWorkspace } from './attachments';
import { autoCompress, buildWire, compactEnd, compactHistory, historyTokens, historyUnits, unitsOf } from './context';
import { compactRequest, dismissCompactionError, setCompaction } from './compact';
import { ensureMemoryBase, extractMemories, memoryOn } from './memory';
import { compactCommand, goalCommand, goalControl, planCommand, planControl, studyCommand, studyControl, type GoalCommand } from './commands';
import { resolveMentions } from './mentions';
import { enterStudyMode, leaveStudyMode } from './study';
import { clearGoal, GOAL_IDLE_LIMIT, GOAL_NUDGE, goalActive, goalMaxTurns, goalNudgeContext, isPlanning, pauseGoal, resumeGoal, startGoal } from './planning';
import { askToNotify, notifyReplyFinished } from './notifications';
import { workspaceFor, workspaceOf } from './projects';
import { parsePartialJson } from './partialJson';
import { firstLine } from './quotes';
import { ensureSkillBase } from './skills';
import { reviewSkills, shouldReviewSkills } from './skills/review';
import {
  getAdapter,
  isSubscriptionType,
  ProviderError,
  type AttachmentPart,
  type ContentPart,
  type Endpoint,
  type StreamResult,
  type ToolCallDraft,
  type ToolPart,
  type WireMessage,
} from './providers';
import { useSubscriptionUsage } from '@/store/subscriptionUsage';
import { recordStep, stepStats } from './stats';
import { apiKeys, flushJsonStorage, uid } from './storage';
import { availableTools, executeTool, toolOn } from './tools';
import { answerInWords } from './tools/ask';
import { answerPlanInWords, cancelWaitingPlan } from './tools/plan';
import { endPhoneRun, onPhoneStop } from './tools/phone';
import { markObserved } from './tools/observe';
import { isRemoteChat, remoteEffortForChat, sendRemoteMessage, sendRemoteQueue, stopRemoteChat } from './remote/chat';
import { systemPrompt, writeContextNote } from './tools/prompt';
import { chatWorkspace } from './workspace';

const controllers = new Map<string, AbortController>();
/** Running replies' "answer now" hooks, by chat (see answerNow). */
const wrapUps = new Map<string, () => void>();

const ANSWER_NOW =
  '[The user pressed "Answer now". Stop working: make no more tool calls, and answer the user directly from what you have ' +
  'found and done so far. Where something is still unchecked or unfinished, say so briefly.]';

/** The history with `request` from the app at its end, on the newest turn rather than a turn of its own. */
function withRequest(messages: WireMessage[], request: string): WireMessage[] {
  const last = messages[messages.length - 1];
  const rest = messages.slice(0, -1);
  if (last?.role === 'tool' && last.results?.length) {
    const results = [...last.results];
    const r = results[results.length - 1];
    results[results.length - 1] = { ...r, output: `${r.output}\n\n${request}` };
    return [...rest, { ...last, results }];
  }
  if (last?.role === 'user') return [...rest, { ...last, text: `${last.text}\n\n${request}` }];
  return [...messages, { role: 'user', text: request, images: [] }];
}

const withAnswerNow = (messages: WireMessage[]) => withRequest(messages, ANSWER_NOW);

// Batch tokens so the store (and the markdown re-render) updates at most ~25 times a second.
const FLUSH_MS = 40;
// Tool call arguments longer than this, still being written, are parsed for the chat at most this often.
const DRAFT_FREE_CHARS = 2000;
const DRAFT_PARSE_MS = 250;

/** Whether a request failed because the prompt is longer than the model's context window. */
function isOverflow(e: unknown) {
  if (!(e instanceof Error)) return false;
  if (e instanceof ProviderError && e.status && ![400, 413, 422, 500].includes(e.status)) return false;
  return /context.{0,20}(length|window|limit|size)|too long|too many tokens|maximum.{0,30}(tokens|length)|token limit|exceeds?.{0,40}(context|tokens)|input length/i.test(
    e.message
  );
}

/** The arguments of a tool call the model is still writing, as far as they parse. */
function draftInput(args: string): Record<string, unknown> {
  const value = parsePartialJson(args);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fallbackTitle(text: string) {
  const line = firstLine(text);
  return line ? (line.length > 40 ? line.slice(0, 40).trimEnd() + '…' : line) : 'Image';
}

/**
 * Adds the user's message to the conversation, or with `replacing`, a new version of that message.
 * `auto` marks a message the app sends for the user (see keepGoalGoing).
 */
function postUserMessage(id: string, text: string, attachments: AttachmentPart[], replacing?: string, auto?: 'goal') {
  const { tools } = useSettings.getState();
  // With tools on, attachments are also copied into the workspace so the agent can work on them,
  // unless they're there already (an edited message keeping its files).
  const ws = workspaceFor(id);
  const parts = tools
    ? attachments.map((a) => {
        try {
          if (a.path && ws.fileAt(a.path).exists) return a;
          return { ...a, path: saveToWorkspace(ws, a) };
        } catch {
          return a;
        }
      })
    : attachments;
  // A text file inlined whole is already read, as far as read-before-write goes.
  markObserved(
    id,
    parts.flatMap((p) => (p.type === 'file' && p.path && p.text != null && !p.file ? [p.path] : []))
  );

  // /goal and /plan change the chat's mode as they are sent; anything else the user sends starts
  // the count of automatic turns over and picks up a goal the app paused.
  const chats = useChats.getState();
  const goalCmd = goalCommand(text);
  const planCmd = planCommand(text);
  if (goalCmd) {
    applyGoalCommand(id, goalCmd);
    // Setting a goal means getting on with it, which plan mode would refuse.
    if ('goal' in goalCmd) leavePlanMode(id);
  } else if (!auto) {
    const goal = chats.conversations[id]?.goal;
    if (goal && (goal.turns || goal.idle || (goal.paused && !goal.paused.manual))) {
      const { idle: _, ...rest } = goal;
      chats.setGoal(id, goal.paused?.manual ? { ...goal, turns: 0, idle: 0 } : { ...rest, turns: 0, paused: undefined });
    }
  }
  if (planCmd) {
    if ('exit' in planCmd) leavePlanMode(id);
    else enterPlanMode(id);
  }
  const studyCmd = studyCommand(text);
  if (studyCmd) {
    if ('exit' in studyCmd) leaveStudyMode(id);
    else enterStudyMode(id);
  }
  const goal = useChats.getState().conversations[id]?.goal;

  // What the message's @mentions and /commands point at, worked out now (after attachments are
  // saved, so they resolve too) and kept with it: the note for the model, the mentions to color.
  let resolved: { context?: string; mentions: string[] } = { mentions: [] };
  try {
    const attached = parts.flatMap((p) => (p.type === 'file' ? [p.name] : []));
    resolved =
      auto === 'goal' && goal
        ? { context: goalNudgeContext(goal, useChats.getState().conversations[id]?.todos, goalMaxTurns()), mentions: [] }
        : resolveMentions(id, text, attached);
  } catch {
    // The message goes as typed.
  }
  const { context, mentions } = resolved;

  const message = {
    role: 'user' as const,
    content: [
      ...parts,
      ...(text
        ? [{ type: 'text' as const, text, ...(context ? { context } : {}), ...(mentions.length ? { mentions } : {}) }]
        : []),
    ],
    status: 'done' as const,
    ...(auto ? { auto } : {}),
  };
  if (replacing) useChats.getState().branch(id, replacing, message);
  else useChats.getState().addMessage(id, message);
}

/** Does what /goal asked for: set the goal, end it, pause or resume it. Its status is shown by the composer. */
function applyGoalCommand(id: string, command: GoalCommand) {
  if ('goal' in command) startGoal(id, command.goal, 'user');
  else if ('clear' in command) clearGoal(id);
  else if ('pause' in command) pauseGoal(id, 'You paused it.', true);
  else if ('resume' in command) resumeGoal(id);
}

/** Puts the chat in plan mode: replies research and propose a plan, and nothing changes until it is approved. */
export function enterPlanMode(id: string) {
  if (!useChats.getState().conversations[id]?.plan) useChats.getState().setPlan(id, { startedAt: Date.now() });
}

/** Takes the chat out of plan mode; a plan waiting for approval goes unanswered. */
export function leavePlanMode(id: string) {
  if (useChats.getState().conversations[id]?.plan) useChats.getState().setPlan(id, undefined);
  cancelWaitingPlan(id);
}

/** Starts a new conversation (when `conversationId` is null) or continues one, and streams the reply. */
export function sendMessage(conversationId: string | null, text: string, attachments: AttachmentPart[], auto?: 'goal') {
  if (isRemoteChat(conversationId)) return sendRemoteMessage(conversationId, text, attachments);
  const { active } = useSettings.getState();
  if (!active) throw new Error('Add an endpoint in Settings to start chatting.');
  const chats = useChats.getState();
  const ui = useUI.getState();
  const id =
    conversationId ??
    chats.create(active.endpointId, active.model, {
      ...(ui.newChatMemoryOff ? { memory: false as const } : {}),
      ...(ui.newChatProjectId ? { projectId: ui.newChatProjectId } : {}),
    });

  chats.setModel(id, active.endpointId, active.model);
  dismissCompactionError(id);
  postUserMessage(id, text, attachments, undefined, auto);
  if (!conversationId) chats.rename(id, fallbackTitle(text), false);

  void runCompletion(id);
  return id;
}

/**
 * Asks the model again for the reply `messageId`, as a new version of the chat from there on; the
 * reply and what followed it stay behind as the version before. A failed reply is replaced instead.
 */
export function regenerate(conversationId: string, messageId: string) {
  if (isRemoteChat(conversationId) || controllers.has(conversationId)) return;
  const { active } = useSettings.getState();
  const chats = useChats.getState();
  const message = chats.conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') return;
  if (active) chats.setModel(conversationId, active.endpointId, active.model);
  void runCompletion(conversationId, { branchFrom: { messageId, replace: message.status === 'error' } });
}

/**
 * Sends an edited version of the user's message `messageId` and gets a new reply to it. The
 * message as it was and everything after it stay behind as the version before.
 */
export function editMessage(conversationId: string, messageId: string, text: string, attachments: AttachmentPart[]) {
  if (isRemoteChat(conversationId)) throw new Error('Messages in remote chats can\u2019t be edited.');
  if (controllers.has(conversationId)) throw new Error('Wait for the reply to finish first.');
  const { active } = useSettings.getState();
  if (!active) throw new Error('Add an endpoint in Settings to start chatting.');
  const chats = useChats.getState();
  const message = chats.conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'user') throw new Error('That message is no longer in the chat.');
  chats.setModel(conversationId, active.endpointId, active.model);
  postUserMessage(conversationId, text, attachments, messageId);
  void runCompletion(conversationId);
}

/**
 * The attachments of the user's message `messageId`, as copies for an edit of it: removing one
 * from the box, or sending, leaves the message as it was untouched.
 */
export function attachmentsForEdit(conversationId: string, messageId: string): AttachmentPart[] {
  const message = useChats.getState().conversations[conversationId]?.messages.find((m) => m.id === messageId);
  return (message?.content ?? []).flatMap((p): AttachmentPart[] =>
    p.type === 'image' || p.type === 'file' ? [p.file ? { ...p, file: duplicateAttachment(p.file) } : p] : []
  );
}

/** A branched chat's title: the one it came from, marked as a branch. */
function branchedTitle(title: string) {
  return title.endsWith(BRANCHED) ? title : `${title}${BRANCHED}`;
}
const BRANCHED = ' (branched)';

/** A message's content with files of its own, for a copy of the chat. */
function copyContent(content: ContentPart[]): ContentPart[] {
  return content.map((p): ContentPart => {
    if ((p.type === 'image' || p.type === 'file') && p.file) return { ...p, file: duplicateAttachment(p.file) };
    if (p.type !== 'tool') return p;
    return {
      ...p,
      ...(p.images ? { images: p.images.map((img) => ({ ...img, file: duplicateAttachment(img.file) })) } : {}),
      // A job still running belongs to the chat it was started in.
      ...(p.background?.status === 'running' ? { background: { ...p.background, status: 'lost' as const } } : {}),
    };
  });
}

/**
 * Starts a new chat with the conversation up to and including `messageId`, as it shows now. It
 * keeps the model, project, memory and compressed context, and takes a copy of the chat's own
 * workspace. Returns the new chat's id.
 */
export function branchToNewChat(conversationId: string, messageId: string) {
  const chats = useChats.getState();
  const c = chats.conversations[conversationId];
  if (!c || isRemoteChat(conversationId)) throw new Error('Remote chats can\u2019t be branched.');
  const index = c.messages.findIndex((m) => m.id === messageId);
  if (index < 0) throw new Error('That message is no longer in the chat.');
  const id = uid();
  const now = Date.now();

  // Message ids stay as they were: compressions and context notes refer to them.
  const messages = c.messages.slice(0, index + 1).map(({ fork: _, ...m }): Message => ({ ...m, content: copyContent(m.content) }));
  const kept = new Set(unitsOf(messages).map((u) => u.key));
  // Blocks cut through by the branch point give way to the ones they had swallowed, where those fit.
  const keep = (b: CompressionBlock): CompressionBlock[] =>
    kept.has(b.start) && kept.has(b.end) ? [b] : (b.children ?? []).flatMap(keep);
  const compressions = (c.compressions ?? []).flatMap(keep);
  const ids = new Set(messages.map((m) => m.id));
  const notes = Object.fromEntries(Object.entries(c.notes ?? {}).filter(([key]) => ids.has(key.split(':')[0])));

  // A chat with a workspace of its own gets a copy; project and shared ones go on sharing theirs.
  const from = workspaceOf(c);
  const own = from.key === `chat:${c.id}`;
  if (own) {
    const to = chatWorkspace(id);
    try {
      for (const entry of from.walk()) {
        to.ensureParent(entry.path);
        from.fileAt(entry.path).copySync(to.fileAt(entry.path));
      }
    } catch {
      // What copied stays; the model sees the workspace as it is.
    }
  }

  const branch: Conversation = {
    id,
    title: branchedTitle(c.title),
    titled: c.titled,
    branchedFrom: c.id,
    createdAt: now,
    updatedAt: now,
    backendId: 'local',
    endpointId: c.endpointId,
    model: c.model,
    messages,
    ...(compressions.length ? { compressions } : {}),
    ...(Object.keys(notes).length ? { notes } : {}),
    // Copies get new modification times, so the model reads files again before changing them.
    ...(!own && c.observed ? { observed: c.observed } : {}),
    ...(c.memory === false ? { memory: false as const } : {}),
    ...(c.memoryBase ? { memoryBase: c.memoryBase } : {}),
    ...(c.skillBase ? { skillBase: c.skillBase } : {}),
    ...(c.projectId ? { projectId: c.projectId } : {}),
    ...(c.workspace ? { workspace: c.workspace } : {}),
  };
  chats.insert(branch);
  return id;
}

/** Resumes an interrupted or failed assistant reply in place without adding a user message. */
export function continueReply(conversationId: string) {
  if (isRemoteChat(conversationId) || controllers.has(conversationId)) return;
  const chats = useChats.getState();
  const conversation = chats.conversations[conversationId];
  const last = conversation?.messages[conversation.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  if (last.status !== 'error' && !last.interrupted) return;
  const { active } = useSettings.getState();
  if (active) chats.setModel(conversationId, active.endpointId, active.model);
  void runCompletion(conversationId, { resumeMessageId: last.id });
}

/**
 * Picks up, in place and with each chat's own model, the replies the app was closed in the middle
 * of, as Continue would. Called once the app has started. A reply is only picked up on its own
 * once: if the app is closed again before it finishes (a model too big for the phone's memory, say),
 * it waits for the user's Continue rather than starting over at every launch.
 */
export function resumeInterruptedReplies() {
  for (const id of takeCutOffReplies()) {
    if (controllers.has(id)) continue;
    const messages = useChats.getState().conversations[id]?.messages;
    const last = messages?.[messages.length - 1];
    if (last?.role !== 'assistant' || last.status !== 'done' || !last.interrupted) continue;
    void runCompletion(id, { resumeMessageId: last.id, auto: true });
  }
}

/**
 * Has the running reply stop what it's doing (the response it's writing, the tool call it's
 * running) and answer right away from what it has found so far, with no more tool calls.
 */
export function answerNow(conversationId: string) {
  wrapUps.get(conversationId)?.();
}

export function stopStreaming(conversationId: string) {
  if (isRemoteChat(conversationId)) return stopRemoteChat(conversationId);
  controllers.get(conversationId)?.abort();
}

// The Stop button on the phone-control overlay stops the replies operating the phone.
onPhoneStop(stopStreaming);

const queueOf = (conversationId: string) => useChats.getState().conversations[conversationId]?.queue ?? [];

/**
 * Sends a message, or while a reply is running, queues it to go out once the reply is done or, as
 * Settings choose, to steer the reply at its next step.
 */
export function submitMessage(conversationId: string | null, text: string, attachments: AttachmentPart[]) {
  if (conversationId && isRemoteChat(conversationId)) {
    const chat = useChats.getState().conversations[conversationId];
    if (!chat?.remote?.submissionId) return sendRemoteMessage(conversationId, text, attachments);
    useChats.getState().setQueue(conversationId, [...(chat.queue ?? []), { id: uid(), text, attachments, remoteEffort: remoteEffortForChat(conversationId) }]);
    return conversationId;
  }
  // "/goal clear", "/goal pause" and the like, and "/plan" on its own or "/plan exit", act at once,
  // even mid-reply, and send nothing. (The composer explains /goal itself when there is no goal.)
  if (!attachments.length) {
    const goalCmd = goalCommand(text);
    if (goalCmd && goalControl(text) && conversationId) {
      applyGoalCommand(conversationId, goalCmd);
      return conversationId;
    }
    const planCmd = planCommand(text);
    if (planCmd && planControl(text)) {
      const { active } = useSettings.getState();
      // Plan mode on a chat yet to start needs the chat, so an empty one is made for it.
      const id = conversationId ?? (active && 'start' in planCmd ? useChats.getState().create(active.endpointId, active.model) : null);
      if (id) {
        if ('start' in planCmd) enterPlanMode(id);
        else leavePlanMode(id);
        return id;
      }
    }
    // "/study" on its own turns study mode on, and "/study off" ends it, without sending anything.
    const studyCmd = studyCommand(text);
    if (studyCmd && studyControl(text)) {
      const { active } = useSettings.getState();
      const id = conversationId ?? (active && 'start' in studyCmd ? useChats.getState().create(active.endpointId, active.model) : null);
      if (id) {
        if ('start' in studyCmd) enterStudyMode(id);
        else leaveStudyMode(id);
        return id;
      }
    }
    // /compact runs at once, or once the running reply is done; it never steers a reply.
    // (The composer stops it in a chat with nothing to compact.)
    const compactCmd = compactCommand(text);
    if (compactCmd && conversationId) {
      if (controllers.has(conversationId)) {
        useChats.getState().setQueue(conversationId, [...queueOf(conversationId), { id: uid(), text, attachments: [] }]);
      } else {
        void compactChat(conversationId, compactCmd.focus);
      }
      return conversationId;
    }
  }
  if (!conversationId || !controllers.has(conversationId)) return sendMessage(conversationId, text, attachments);
  // While the model waits on a question or on a decision about its plan, a message answers it.
  // Attachments can't go in the answer, so they follow it into the reply at the next step.
  if (
    answerInWords(conversationId, text || '(No text; files the user attached follow.)') ||
    answerPlanInWords(conversationId, text || '(No text; files the user attached follow.)')
  ) {
    if (attachments.length) {
      useChats.getState().setQueue(conversationId, [...queueOf(conversationId), { id: uid(), text: '', attachments, steer: true }]);
    }
    return conversationId;
  }
  const message: QueuedMessage = { id: uid(), text, attachments };
  if (useSettings.getState().followUp === 'steer') message.steer = true;
  useChats.getState().setQueue(conversationId, [...queueOf(conversationId), message]);
  return conversationId;
}

/** Sends the queued message (by default the oldest) as the next turn. It stays queued if sending fails. */
function sendFromQueue(conversationId: string, queuedId?: string) {
  const queue = queueOf(conversationId);
  const message = queuedId ? queue.find((m) => m.id === queuedId) : queue[0];
  if (!message) return;
  useChats.getState().setQueue(conversationId, queue.filter((m) => m !== message));
  const compactCmd = message.attachments.length ? null : compactCommand(message.text);
  if (compactCmd) {
    void compactChat(conversationId, compactCmd.focus);
    return;
  }
  try {
    sendMessage(conversationId, message.text, message.attachments);
  } catch (e) {
    useChats.getState().setQueue(conversationId, queue);
    throw e;
  }
}

/** Steers the running reply with a queued message, or sends it right away when nothing is running. */
export function sendQueuedNow(conversationId: string, queuedId: string) {
  if (isRemoteChat(conversationId)) return sendRemoteQueue(conversationId, queuedId);
  if (!controllers.has(conversationId)) return sendFromQueue(conversationId, queuedId);
  // A queued /compact can't join a reply; it goes once the reply is done.
  useChats
    .getState()
    .setQueue(
      conversationId,
      queueOf(conversationId).map((m) => (m.id === queuedId && !compactCommand(m.text) ? { ...m, steer: true } : m))
    );
}

/** Takes a message out of the queue to be edited, its attachments kept. */
export function takeQueued(conversationId: string, queuedId: string) {
  const queue = queueOf(conversationId);
  const message = queue.find((m) => m.id === queuedId);
  if (message) useChats.getState().setQueue(conversationId, queue.filter((m) => m !== message));
  return message;
}

export function deleteQueued(conversationId: string, queuedId: string) {
  const message = takeQueued(conversationId, queuedId);
  for (const a of message?.attachments ?? []) if (a.file) deleteAttachment(a.file);
}

/**
 * Whether /compact has anything to do in the chat: a local chat with history not already
 * compacted, or a reply running that will add some.
 */
export function canCompact(conversationId: string | null) {
  if (!conversationId || isRemoteChat(conversationId)) return false;
  return controllers.has(conversationId) || !!compactEnd(conversationId);
}

/**
 * /compact: has the chat's model summarise the conversation so far, and puts the summary in place
 * of that history from the next turn on. The messages stay on screen; only what the model is sent
 * changes. It holds the chat like a reply does: messages sent meanwhile queue up behind it, and
 * stopStreaming cancels it. How it is going shows through useCompaction (see lib/compact).
 */
export async function compactChat(id: string, focus = '') {
  if (isRemoteChat(id) || controllers.has(id)) return;
  const chats = useChats.getState();
  if (!chats.conversations[id]) return;
  const { active } = useSettings.getState();
  if (active) chats.setModel(id, active.endpointId, active.model);
  const conversation = useChats.getState().conversations[id]!;
  const settings = useSettings.getState();
  const endpoint = settings.endpoints.find((e) => e.id === conversation.endpointId);
  const fail = (error: string) => setCompaction(id, { status: 'error', error });
  if (!endpoint) return fail('This chat’s endpoint no longer exists. Pick another model.');
  // Where the summary will end, fixed now; anything after it (there should be nothing) stays as it is.
  const end = compactEnd(id);
  if (!end) return fail('There’s nothing new to compact yet.');

  const controller = new AbortController();
  controllers.set(id, controller);
  setCompaction(id, { status: 'running', startedAt: Date.now() });
  let failed = false;
  try {
    const apiKey = (await apiKeys.get(endpoint.id)) ?? undefined;
    // The system prompt, tools and history a reply would send now, so the request reads from the
    // prompt cache rather than paying for the whole chat again.
    const toolsOn = settings.tools && (endpoint.type !== 'local' || localToolsOn(conversation.model));
    const offered = toolsOn ? availableTools(id) : [];
    const tools = offered.length ? offered : undefined;
    ensureMemoryBase(id);
    if (tools) ensureSkillBase(id);
    const system = systemPrompt(id, !!tools);
    const effort = resolveEffort(settings, { endpointId: endpoint.id, model: conversation.model });
    const base64Cache = new Map<string, string | null>();
    const readBase64 = async (file: string) => {
      if (!base64Cache.has(file)) base64Cache.set(file, await readAttachmentBase64(file).catch(() => null));
      return base64Cache.get(file)!;
    };

    const summarise = async (withTools: boolean) => {
      for (let attempt = 0; ; attempt++) {
        let text = '';
        let streamed = false;
        try {
          const current = useChats.getState().conversations[id];
          if (!current) throw new Error('This chat no longer exists.');
          const messages = await buildWire(historyUnits(current), current.compressions ?? [], {
            endpointType: endpoint.type,
            withTools,
            tagged: withTools,
            notes: withTools ? current.notes : undefined,
            readBase64,
          });
          await getAdapter(endpoint.type).stream({
            endpoint,
            apiKey,
            model: conversation.model,
            effort: effort?.level,
            system,
            tools: withTools ? tools : undefined,
            messages: withRequest(messages, compactRequest(focus)),
            signal: controller.signal,
            onToken: (token) => {
              streamed = true;
              text += token;
            },
            onReasoning: () => {
              streamed = true;
            },
          });
          return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        } catch (e) {
          // Over the model's real window: compress the oldest history mechanically and try again.
          const retry =
            attempt < 3 &&
            !streamed &&
            !controller.signal.aborted &&
            isOverflow(e) &&
            autoCompress(id, '', 0, historyTokens(id, '') / 2);
          if (!retry) throw e;
        }
      }
    };

    let summary = await summarise(!!tools);
    // A model that reached for a tool instead of writing gets asked again with none on offer.
    if (summary.length < 20 && tools && !controller.signal.aborted) summary = await summarise(false);
    if (summary.length < 20) throw new Error('The model didn’t write a summary. Try again, or with another model.');
    compactHistory(id, end, summary);
  } catch (e) {
    if (!controller.signal.aborted) {
      failed = true;
      fail(e instanceof Error ? e.message : String(e));
    }
  } finally {
    controllers.delete(id);
    if (!failed) setCompaction(id, undefined);
    // "Send now" on a queued message has nothing to join; it waits its turn like the rest.
    const queue = queueOf(id);
    if (queue.some((m) => m.steer)) useChats.getState().setQueue(id, queue.map(({ steer: _, ...m }) => m));
    flushJsonStorage();
  }
  // Messages sent while it ran go out now; after a failure or a cancel they wait for the user.
  if (!failed && !controller.signal.aborted) {
    try {
      sendFromQueue(id);
    } catch {
      // No model to send with; the message stays queued.
    }
  }
}

async function runCompletion(
  id: string,
  opts?: { resumeMessageId?: string; auto?: boolean; branchFrom?: { messageId: string; replace?: boolean } }
) {
  const chats = useChats.getState();
  const conversation = chats.conversations[id];
  if (!conversation) return;
  const settings = useSettings.getState();
  const endpoint = settings.endpoints.find((e) => e.id === conversation.endpointId);
  const effort = resolveEffort(settings, { endpointId: conversation.endpointId, model: conversation.model });

  // Only the first reply starts the new version; a steered reply follows it in that version.
  let branchFrom = opts?.branchFrom;
  const startReply = () => {
    const message = { role: 'assistant' as const, content: [], status: 'streaming' as const, model: conversation.model };
    const from = branchFrom;
    branchFrom = undefined;
    return from
      ? useChats.getState().branch(id, from.messageId, message, { replace: from.replace })
      : useChats.getState().addMessage(id, message);
  };
  // A steered reply goes on in a new message after the user's (see `steer`); continuing an
  // interrupted reply reopens it in place so prior thoughts, tool calls and text stay intact.
  let replyId: string;
  if (opts?.resumeMessageId) {
    replyId = opts.resumeMessageId;
    useChats.getState().updateMessage(id, replyId, {
      status: 'streaming',
      error: undefined,
      interrupted: undefined,
      // Continued by the user, a reply may be picked up on its own again if the app closes on it.
      autoResumed: opts.auto ? true : undefined,
      model: conversation.model,
    });
  } else {
    replyId = startReply();
  }

  if (!endpoint) {
    chats.updateMessage(id, replyId, { status: 'error', error: 'This endpoint no longer exists. Pick another model.' });
    return;
  }

  const controller = new AbortController();
  controllers.set(id, controller);
  // "Answer now" cuts the step under way short with its own signal (Stop aborts it too). One last
  // response then answers from what the reply has, at the lowest effort, its tool calls ignored.
  let wrapUp = false;
  let stepController = new AbortController();
  controller.signal.addEventListener('abort', () => stepController.abort());
  wrapUps.set(id, () => {
    if (wrapUp || controller.signal.aborted) return;
    wrapUp = true;
    useChats.getState().updateMessage(id, replyId, { answerNow: true });
    stepController.abort();
  });
  void askToNotify();
  let buffer = '';
  let reasoningBuffer = '';
  // Tool calls the model is still writing in the current response, by stream index, with the id
  // their part has in the reply. Shown as they grow, then swapped for the finished calls.
  // `parsedAt`: when the draft's arguments were last parsed for the chat.
  const drafts = new Map<number, { draft: ToolCallDraft; partId: string; parsedAt?: number }>();
  const changedDrafts = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // `final` shows every draft as it stands, at the end of a response.
  const flush = (final = false) => {
    if (timer) clearTimeout(timer);
    timer = null;
    const now = Date.now();
    const parts: ToolPart[] = [];
    for (const index of changedDrafts) {
      const entry = drafts.get(index);
      if (!entry) {
        changedDrafts.delete(index);
        continue;
      }
      const { draft, partId, parsedAt } = entry;
      // Long arguments (a whole file being written) are parsed again, and the row redrawn, a few
      // times a second rather than with every flush: each parse reads them from the start.
      if (!final && parsedAt != null && draft.args.length > DRAFT_FREE_CHARS && now - parsedAt < DRAFT_PARSE_MS) continue;
      entry.parsedAt = now;
      changedDrafts.delete(index);
      parts.push({ type: 'tool', id: partId, name: draft.name, input: draftInput(draft.args), status: 'writing' });
    }
    // One store update for all of it, so the chat renders once per flush rather than once per kind.
    useChats.getState().appendStream(id, replyId, { reasoning: reasoningBuffer, text: buffer, drafts: parts });
    buffer = '';
    reasoningBuffer = '';
    // Drafts held back go out with a later flush.
    if (changedDrafts.size) timer = setTimeout(flush, FLUSH_MS);
  };

  // Wall time of the current stretch of thinking, recorded on its part when answer text or the
  // end of the response follows it. Each response (and each stretch within one) is timed apart.
  let thinkingStartedAt = 0;
  const markThoughtDone = () => {
    if (!thinkingStartedAt) return;
    const ms = Date.now() - thinkingStartedAt;
    thinkingStartedAt = 0;
    // The part may still be in the buffer.
    flush();
    useChats.getState().finishThought(id, replyId, ms);
  };

  // With every tool turned off one by one, the chat runs as if tools were off altogether. On-device
  // models only get them when turned on for the model: the prompt they add is slow to read on a phone.
  const toolsOn = settings.tools && (endpoint.type !== 'local' || localToolsOn(conversation.model));
  const offered = toolsOn ? availableTools(id) : [];
  const tools = offered.length ? offered : undefined;
  // The memories this chat's system prompt shows are fixed on its first request.
  ensureMemoryBase(id);
  // So are the skills it lists, once it has the tools to load them.
  if (tools) ensureSkillBase(id);
  const system = systemPrompt(id, !!tools);
  const budget = resolveBudget(endpoint, conversation.model);
  const { compression } = useSettings.getState();
  const reply = () => useChats.getState().conversations[id]?.messages.find((m) => m.id === replyId);
  // Ids of the reply's finished tool calls. Some servers reuse ids like "call_0" across responses;
  // ids must be unique within the reply.
  const takenIds = () =>
    new Set(reply()?.content.flatMap((p) => (p.type === 'tool' && p.status !== 'writing' ? [p.id] : [])));
  const settleDrafts = (parts: ToolPart[]) => {
    drafts.clear();
    useChats.getState().settleDrafts(id, replyId, parts);
  };
  // Messages sent to steer the reply join it between steps, where the history is whole: the reply
  // so far is closed, they follow it as one user turn, and a new reply picks up from there.
  const steer = () => {
    const queue = queueOf(id);
    const steers = queue.filter((m) => m.steer);
    if (!steers.length) return false;
    const chats = useChats.getState();
    chats.setQueue(id, queue.filter((m) => !m.steer));
    chats.updateMessage(id, replyId, { status: 'done', answerNow: undefined });
    postUserMessage(
      id,
      steers.map((m) => m.text).filter(Boolean).join('\n\n'),
      steers.flatMap((m) => m.attachments)
    );
    replyId = startReply();
    return true;
  };

  // Attachments and tool images are re-sent every step; read each file once per reply.
  const base64Cache = new Map<string, string | null>();
  const readBase64 = async (file: string) => {
    if (!base64Cache.has(file)) base64Cache.set(file, await readAttachmentBase64(file).catch(() => null));
    return base64Cache.get(file)!;
  };
  // Rebuilt every step: tool results grow the history and compression reshapes it.
  const buildMessages = () => {
    const current = useChats.getState().conversations[id];
    if (!current) return Promise.resolve([]);
    return buildWire(historyUnits(current, replyId), current.compressions ?? [], {
      endpointType: endpoint.type,
      withTools: !!tools,
      tagged: !!tools,
      notes: tools ? current.notes : undefined,
      readBase64,
    });
  };

  // In plan mode a reply may only look into the task, and tools that change things are refused (see
  // executeTool). Without tools there is no way to submit a plan, so the chat leaves plan mode.
  if (conversation.plan && !(tools && toolOn('exit_plan_mode', id))) leavePlanMode(id);

  let apiKey: string | undefined;
  let interrupted: string | undefined;
  try {
    apiKey = (await apiKeys.get(endpoint.id)) ?? undefined;
    for (let step = 1; ; step++) {
      // Past the trigger share of the budget, old history is compressed mechanically down to the
      // target. The model is asked to compress well before that, with summaries that keep more.
      autoCompress(id, replyId, (budget * compression.trigger) / 100, (budget * compression.target) / 100);
      // What changes between steps (time, workspace, jobs) goes after the newest history item and
      // stays there, so the system prompt and earlier history are a stable, cacheable prefix.
      if (tools) writeContextNote({ conversationId: id, replyId, budget });
      // The response that answers now, once asked for; a step started before that gets cut short.
      const final = wrapUp;
      stepController = new AbortController();
      const stepSignal = final ? controller.signal : stepController.signal;
      // Where this step's parts begin, so a step cut short can take back its half-written text.
      const partsBefore = reply()?.content.length ?? 0;
      let answered = false;
      let streamed = false;
      // For timing the response's decode where the server doesn't: from its first chunk to its end.
      let firstChunkAt = 0;
      let streamedChars = 0;
      const chunk = (chars: number) => {
        streamed = true;
        firstChunkAt ||= Date.now();
        streamedChars += chars;
      };
      let result: StreamResult | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const messages = await buildMessages();
          result = await getAdapter(endpoint.type).stream({
            endpoint,
            apiKey,
            model: conversation.model,
            // Answering now shouldn't mean a long think first.
            effort: final && effort ? endpoint.efforts?.[conversation.model]?.[0] ?? effort.level : effort?.level,
            system,
            // Still offered when answering now: some APIs refuse tool calls in the history without them.
            tools,
            messages: final ? withAnswerNow(messages) : messages,
            signal: stepSignal,
            onToken: (token) => {
              chunk(token.length);
              answered ||= !!token.trim();
              markThoughtDone();
              buffer += token;
              timer ??= setTimeout(flush, FLUSH_MS);
            },
            onReasoning: (token) => {
              chunk(token.length);
              thinkingStartedAt ||= Date.now();
              reasoningBuffer += token;
              timer ??= setTimeout(flush, FLUSH_MS);
            },
            onToolDraft: (draft) => {
              chunk(0);
              markThoughtDone();
              const partId =
                drafts.get(draft.index)?.partId ?? (takenIds().has(draft.id) ? `${draft.id}_${uid()}` : draft.id);
              drafts.set(draft.index, { draft, partId, parsedAt: drafts.get(draft.index)?.parsedAt });
              changedDrafts.add(draft.index);
              timer ??= setTimeout(flush, FLUSH_MS);
            },
          });
          break;
        } catch (e) {
          // Cut short to answer now; the answer follows as the next response.
          if (!final && wrapUp && !controller.signal.aborted) break;
          // Over the model's real window (the budget is only an estimate): compress harder and retry.
          const retry =
            attempt < 3 &&
            !streamed &&
            !controller.signal.aborted &&
            isOverflow(e) &&
            autoCompress(id, replyId, 0, historyTokens(id, replyId) / 2);
          if (!retry) throw e;
        }
      }
      flush(true);
      markThoughtDone();
      if (!result) {
        // The step's thoughts stay; its unfinished calls go, and so does text the answer will replace.
        settleDrafts([]);
        const content = reply()?.content ?? [];
        useChats
          .getState()
          .updateMessage(id, replyId, { content: content.filter((p, i) => i < partsBefore || p.type !== 'text') });
        continue;
      }
      if (final) {
        // Calls made anyway are dropped: the reply ends here.
        settleDrafts([]);
        if (!answered) interrupted = 'Stopped without an answer';
        const stats = stepStats(result.usage, streamedChars, firstChunkAt ? Date.now() - firstChunkAt : 0);
        if (stats) recordStep(id, replyId, stats);
        break;
      }
      const toolChars = result.toolCalls.reduce((n, c) => n + c.name.length + JSON.stringify(c.input).length, 0);
      const stats = stepStats(result.usage, streamedChars + toolChars, firstChunkAt ? Date.now() - firstChunkAt : 0);
      if (stats) recordStep(id, replyId, stats);
      if (!tools || !result.toolCalls.length) {
        settleDrafts([]);
        // Rounds count per reply, and a steered one starts over. An answer asked for as it finished stands.
        if (!wrapUp && steer()) {
          step = 0;
          continue;
        }
        break;
      }
      // Read every step, so setting a limit mid-reply can rein in a model that's spinning.
      const { maxSteps } = useSettings.getState();
      if (maxSteps && step >= maxSteps) {
        settleDrafts([]);
        interrupted = `Stopped after ${maxSteps} rounds of tool calls`;
        break;
      }

      const taken = takenIds();
      // A finished call keeps its draft's id, so its row stays as it was (opened or not).
      const drafted = new Map([...drafts.values()].map((d) => [d.draft.id, d.partId]));
      const stepId = uid();
      const calls = result.toolCalls.map((c, i): ToolPart => ({
        type: 'tool',
        id: drafted.get(c.id) ?? (taken.has(c.id) ? `${c.id}_${uid()}` : c.id),
        name: c.name,
        input: c.input,
        status: 'running',
        step: stepId,
        ...(c.signature ? { signature: c.signature } : {}),
        ...(i === 0 && result.thinking ? { thinking: result.thinking } : {}),
      }));
      settleDrafts(calls);
      // One at a time: calls in a batch often depend on each other's files.
      for (const call of calls) {
        if (stepSignal.aborted) break;
        const started = Date.now();
        const outcome = await executeTool(call, {
          signal: stepSignal,
          conversationId: id,
          messageId: replyId,
          step: stepId,
          budget,
        });
        useChats.getState().patchTool(id, replyId, call.id, {
          status: outcome.isError ? 'error' : 'done',
          output: outcome.output,
          durationMs: Date.now() - started,
          ...(outcome.images?.length ? { images: outcome.images } : {}),
          ...(outcome.files?.length ? { files: outcome.files } : {}),
          ...(outcome.sources?.length ? { sources: outcome.sources } : {}),
        });
      }
      if (controller.signal.aborted) throw new Error('Stopped');
      if (wrapUp) {
        // Calls the answer cut off before they ran stay in the history as not run.
        for (const call of calls) {
          if (reply()?.content.some((p) => p.type === 'tool' && p.id === call.id && p.status === 'running')) {
            useChats.getState().patchTool(id, replyId, call.id, { status: 'error', output: 'Not run: the user asked for an answer now.' });
          }
        }
        continue;
      }
      if (steer()) step = 0;
    }
    const chats = useChats.getState();
    chats.updateMessage(id, replyId, { status: 'done', error: undefined, interrupted, answerNow: undefined });
    if (!interrupted && !controller.signal.aborted) chats.markReplyUnread(id);
  } catch (e) {
    flush(true);
    markThoughtDone();
    const content = interruptContent(reply()?.content ?? []);
    if (controller.signal.aborted) {
      useChats.getState().updateMessage(id, replyId, {
        status: 'done',
        content,
        error: undefined,
        interrupted: 'Stopped by user',
        answerNow: undefined,
      });
    } else {
      const error = e instanceof Error ? e.message : String(e);
      useChats.getState().updateMessage(id, replyId, {
        status: 'error',
        error,
        interrupted: undefined,
        content,
        answerNow: undefined,
      });
      void notifyReplyFinished(id, replyId);
      return;
    }
  } finally {
    if (timer) clearTimeout(timer);
    controllers.delete(id);
    wrapUps.delete(id);
    endPhoneRun(id, controller.signal.aborted);
    // Steers that never reached a step boundary wait in the queue like any other message.
    const queue = queueOf(id);
    if (queue.some((m) => m.steer)) useChats.getState().setQueue(id, queue.map(({ steer: _, ...m }) => m));
    flushJsonStorage();
  }

  const stopped = controller.signal.aborted || !!interrupted;
  const latest = useChats.getState().conversations[id];
  if (isSubscriptionType(endpoint.type)) {
    const usageStore = useSubscriptionUsage.getState();
    const accountId = usageStore.lastUsedAccount[endpoint.id];
    void usageStore.refresh(endpoint, { force: true, ...(accountId ? { accountId } : {}) });
  }
  if (latest && !latest.titled && useSettings.getState().titleGeneration) void generateTitle(id, endpoint, apiKey, conversation.model);
  // A reply where the model managed memory itself needs no second pass, nor does a stopped one.
  const managed = reply()?.content.some((p) => p.type === 'tool' && p.name.startsWith('memory_'));
  if (latest && !stopped && !managed && memoryOn(id) && useSettings.getState().memoryAuto) {
    void extractMemories(id, replyId, endpoint, apiKey, conversation.model);
  }
  // A reply that did real work is reviewed for skills worth saving or fixing (see lib/skills/review).
  const calls = reply()?.content.filter((p): p is ToolPart => p.type === 'tool' && p.status !== 'writing') ?? [];
  if (latest && !stopped && shouldReviewSkills(calls)) {
    void reviewSkills(id, replyId, endpoint, apiKey, conversation.model);
  }
  // The next queued message goes out as the following turn. A stopped reply holds the queue until
  // the user sends from it.
  if (!stopped) {
    try {
      sendFromQueue(id);
    } catch {
      // No model to send with; the message stays queued.
    }
  }
  // A goal the user stopped mid-reply waits for them rather than starting again on its own.
  if (controller.signal.aborted) pauseGoal(id, 'You stopped the reply.');
  // With nothing queued, a goal not yet marked done keeps the work going; not after "Answer now",
  // which asks for the work to stop. goal_done is looked up now rather than among the reply's
  // tools, since a goal set by steering arrives after those were picked.
  if (!stopped && !wrapUp && !controllers.has(id) && toolsOn && toolOn('goal_done', id)) keepGoalGoing(id, calls.length > 0);
  // Unless a queued message went out as the next turn (or the user stopped it manually), notify.
  if (!controller.signal.aborted && !controllers.has(id)) void notifyReplyFinished(id, replyId);
}

/**
 * Sends the next turn toward the chat's goal for the user. It pauses the goal instead when the
 * limit of automatic turns in a row is reached, or after replies without a single tool call: the
 * model is then likely done or waiting for the user, and another nudge would only repeat itself.
 */
function keepGoalGoing(id: string, worked: boolean) {
  const chats = useChats.getState();
  const goal = chats.conversations[id]?.goal;
  // Plan mode holds a goal still: the plan, once approved, takes its place.
  if (!goalActive(goal) || isPlanning(id)) return;
  const idle = worked ? 0 : (goal.idle ?? 0) + 1;
  if (idle >= GOAL_IDLE_LIMIT) {
    chats.setGoal(id, { ...goal, idle, paused: { reason: 'The model stopped making progress and may be waiting for you. Reply to carry on.' } });
    return;
  }
  const max = goalMaxTurns();
  if (goal.turns >= max) {
    chats.setGoal(id, { ...goal, idle, paused: { reason: `It used its ${max} automatic turns in a row. Reply or resume to carry on.` } });
    return;
  }
  chats.setGoal(id, { ...goal, turns: goal.turns + 1, idle });
  try {
    sendMessage(id, GOAL_NUDGE, [], 'goal');
  } catch {
    // No model to send with; the goal waits for the user.
  }
}

async function generateTitle(id: string, chatEndpoint: Endpoint, chatApiKey: string | undefined, chatModel: string) {
  // A model picked for titles in Settings wins over the chat's own, while it still exists.
  const { endpoints, titleModel } = useSettings.getState();
  const picked = resolveTaskModel(endpoints, titleModel);
  const endpoint = picked?.endpoint ?? chatEndpoint;
  const model = picked?.model ?? chatModel;
  const apiKey = picked && picked.endpoint.id !== chatEndpoint.id ? (await apiKeys.get(endpoint.id)) ?? undefined : chatApiKey;
  const conversation = useChats.getState().conversations[id];
  const firstUser = conversation?.messages.find((m) => m.role === 'user');
  if (!firstUser) return;
  const userText = messageText(firstUser).slice(0, 1500) || '(the user sent an attachment)';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let title = '';
  try {
    await getAdapter(endpoint.type).stream({
      endpoint,
      apiKey,
      model,
      // Titles don't need deliberation; the lowest level keeps them quick.
      effort: endpoint.efforts?.[model]?.[0],
      signal: controller.signal,
      messages: [
        {
          role: 'user',
          images: [],
          text:
            'Write a short title (2-6 words) for a conversation that starts with the message below. ' +
            'Reply with the title only: no quotes, no punctuation at the end.\n\n' +
            `Message: ${userText}`,
        },
      ],
      onToken: (t) => (title += t),
    });
  } catch {
    return;
  } finally {
    clearTimeout(timeout);
  }

  title = title
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .split('\n')[0]
    .replace(/^(title:\s*)/i, '')
    .replace(/^["'*#\s]+|["'*.\s]+$/g, '')
    .slice(0, 60);
  const current = useChats.getState().conversations[id];
  if (current && title && !current.titled) useChats.getState().rename(id, current.branchedFrom ? branchedTitle(title) : title);
}
