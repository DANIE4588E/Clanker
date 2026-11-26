import { useChats, type Goal, type Todo } from '@/store/chats';
import { useSettings } from '@/store/settings';

/**
 * What plan mode, goals and todo lists share: changing them, saying where they stand to the model
 * (in context notes, so the system prompt stays the same) and to the user.
 */

// ---- goals -----------------------------------------------------------------------------------

/** The message the app sends to keep a goal going. */
export const GOAL_NUDGE = 'Continue working toward the goal.';

/** Turns without a tool call in a row after which a goal pauses, as the model is likely waiting on the user. */
export const GOAL_IDLE_LIMIT = 2;

export const goalActive = (goal: Goal | undefined): goal is Goal => !!goal && !goal.paused;

export const goalMaxTurns = () => useSettings.getState().goalMaxTurns;

export function startGoal(conversationId: string, text: string, by: NonNullable<Goal['by']>, plan?: string) {
  useChats.getState().setGoal(conversationId, { text, setAt: Date.now(), turns: 0, by, ...(plan ? { plan } : {}) });
}

export function clearGoal(conversationId: string) {
  useChats.getState().setGoal(conversationId, undefined);
}

export function pauseGoal(conversationId: string, reason: string, manual = false) {
  const goal = useChats.getState().conversations[conversationId]?.goal;
  if (goal && !goal.paused) useChats.getState().setGoal(conversationId, { ...goal, paused: { reason, ...(manual ? { manual } : {}) } });
}

/** Picks a paused goal back up, with a fresh count of automatic turns. */
export function resumeGoal(conversationId: string) {
  const goal = useChats.getState().conversations[conversationId]?.goal;
  if (!goal?.paused) return;
  const { paused: _, idle: __, ...rest } = goal;
  useChats.getState().setGoal(conversationId, { ...rest, turns: 0 });
}

export function formatElapsed(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const BY = { user: 'you', agent: 'the model', plan: 'the approved plan' } as const;

/** A goal's state for the user: what it is, who set it, and how far the app has taken it. */
export function goalStatus(goal: Goal) {
  const max = goalMaxTurns();
  return [
    `“${goal.text}”`,
    goal.paused ? `Paused: ${goal.paused.reason}` : `Working on it: ${goal.turns} of ${max} automatic turns used.`,
    `Set by ${BY[goal.by ?? 'user']} ${formatElapsed(Date.now() - goal.setAt)} ago.`,
  ].join('\n\n');
}

/** The note that has a model pick a goal back up on its own. */
export function goalNudgeContext(goal: Goal, todos: Todo[] | undefined, max: number) {
  const open = (todos ?? []).filter((t) => t.status !== 'completed').length;
  const stalled = (goal.idle ?? 0) > 0;
  return (
    `[Sent automatically by the app, not typed by the user: the goal isn't marked done yet ("${goal.text}"); automatic turn ${goal.turns} of ${max}. ` +
    (open ? `${open} item${open === 1 ? '' : 's'} on your todo list ${open === 1 ? 'is' : 'are'} still open. ` : '') +
    'Carry on with the next step. Once the goal is fully achieved, call goal_done; if you can\'t go on, or only the user can unblock it, call goal_done with achieved: false, or ask them with ask_user, instead of stopping silently.' +
    (stalled ? ' Your last reply made no tool calls: if the work is finished, say so with goal_done rather than replying again.' : '') +
    ']'
  );
}

// ---- plan mode ---------------------------------------------------------------------------------

export const isPlanning = (conversationId: string) => !!useChats.getState().conversations[conversationId]?.plan;

export const PLAN_RULES = [
  'Plan mode is ON. The user wants a plan they approve before anything is done.',
  '- Research only: read files, search, browse and ask the user questions (ask_user). Anything that writes files, runs code, acts in apps, saves memories or sets goals is refused until the plan is approved.',
  '- Work out what is wanted: look into the relevant files and context yourself, and settle real open questions with ask_user instead of guessing.',
  '- When you have a plan, call exit_plan_mode with a title and the plan in Markdown: a short summary, the numbered steps, what each step touches, and the risks or decisions that remain. The user then approves it or asks you to keep refining; do not ask "shall I proceed?" in your reply instead, since the tool is how they approve.',
  '- If they want changes, revise the plan (look further or ask more if needed) and call exit_plan_mode again with the whole updated plan.',
  '- Once they approve, plan mode ends and the plan becomes the goal; you then carry it out.',
].join('\n');

// ---- todo lists --------------------------------------------------------------------------------

const MARK = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;

export function todoSummary(todos: Todo[]) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  return { done, total: todos.length, current: current?.content };
}

/** The list as the model reads it: one item per line, marked ([x] done, [~] in progress, [ ] to do). */
export const todoText = (todos: Todo[]) => todos.map((t, i) => `${i + 1}. ${MARK[t.status]} ${t.content}`).join('\n');
