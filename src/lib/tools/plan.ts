import { useChats, type Todo, type TodoStatus } from '@/store/chats';
import { useSettings } from '@/store/settings';
import { notifyQuestion } from '../notifications';
import { clearGoal, goalMaxTurns, startGoal, todoSummary } from '../planning';
import type { Tool } from './index';

// Not toolOn from ./index, which imports this file: these are only the user's switches in Settings.
const off = (name: string) => useSettings.getState().disabledTools.includes(name);

/** Plan mode's plan, the todo list and the goal tools: how a model plans, tracks and sustains work. */

// ---- plan approval -----------------------------------------------------------------------------

/** How exit_plan_mode's output starts, so the chat can show how the user answered. */
export const PLAN_APPROVED = 'The user approved the plan.';
export const PLAN_REVISE = 'The user wants to keep planning.';
export const PLAN_LEFT = 'The user left plan mode without approving the plan.';

/** How the user answered a submitted plan, read from the call's output; undefined while it waits or if it never got one. */
export function planOutcome(output: string | undefined): 'approved' | 'revise' | 'left' | undefined {
  if (!output) return undefined;
  if (output.startsWith(PLAN_APPROVED)) return 'approved';
  if (output.startsWith(PLAN_REVISE)) return 'revise';
  if (output.startsWith(PLAN_LEFT)) return 'left';
  return undefined;
}

type Decision = { approved: true } | { feedback: string } | { left: true };

// Calls waiting for the user's decision, by call id. The reply is paused on them; nothing survives
// a restart, where the store marks the call interrupted like any other that was running.
const waiting = new Map<string, { conversationId: string; decide: (d: Decision) => void }>();
// Decisions on calls that show already but haven't started: earlier calls of their step still run.
const early = new Map<string, Decision>();

function decide(callId: string, decision: Decision) {
  const call = waiting.get(callId);
  if (call) call.decide(decision);
  else early.set(callId, decision);
}

export const approvePlan = (callId: string) => decide(callId, { approved: true });

/** Sends the plan back for more work, with what to change if the user said. */
export const revisePlan = (callId: string, feedback: string) => decide(callId, { feedback: feedback.trim() });

/**
 * Answers the chat's waiting plan with a message the user typed in the composer: feedback for the
 * next version. False when the chat has no plan waiting.
 */
export function answerPlanInWords(conversationId: string, words: string) {
  for (const call of waiting.values()) {
    if (call.conversationId !== conversationId) continue;
    call.decide({ feedback: words.trim() });
    return true;
  }
  return false;
}

/** Ends the chat's waiting plan, when the user leaves plan mode without deciding on it. */
export function cancelWaitingPlan(conversationId: string) {
  for (const call of waiting.values()) if (call.conversationId === conversationId) call.decide({ left: true });
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The first line of the plan with its Markdown marks off, for a plan that came without a title. */
function titleOf(plan: string) {
  const line =
    plan
      .split('\n')
      .map((l) => l.replace(/^[\s#>*\-\d.)]+/, '').replace(/[*_`]/g, '').trim())
      .find(Boolean) ?? 'Approved plan';
  return line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line;
}

export const exitPlanMode: Tool = {
  name: 'exit_plan_mode',
  description:
    'In plan mode only: submit your finished plan for the user to approve. They see it with buttons to accept it or keep refining it, and this call waits for their choice. ' +
    'When they accept, plan mode ends, the plan becomes the goal and you carry it out; when they want changes you get their feedback and submit a revised plan. ' +
    'Call it once you have researched enough to give a concrete plan, not before, and not to ask a question (use ask_user for that).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short name for the work, a few words; it becomes the goal once approved.' },
      plan: {
        type: 'string',
        description:
          'The whole plan in Markdown: a short summary, the numbered steps, what each one touches (files, apps, accounts), and the risks or decisions that remain. Concrete enough to carry out without further questions.',
      },
    },
    required: ['title', 'plan'],
  },
  async run(input, { conversationId, callId, signal }) {
    if (!useChats.getState().conversations[conversationId]?.plan) {
      throw new Error(
        'Plan mode is not on, so there is no plan to submit. Carry on with the work, or ask the user first if something is unclear.'
      );
    }
    const plan = text(input.plan);
    if (!plan) throw new Error('Pass the plan, in Markdown, as "plan".');
    const title = text(input.title) || titleOf(plan);

    let decision = early.get(callId);
    early.delete(callId);
    if (!decision) {
      if (signal.aborted) throw new Error('Stopped before the user decided on the plan.');
      void notifyQuestion(conversationId, `Plan ready for your approval: ${title}`);
      decision = await new Promise<Decision>((resolve, reject) => {
        const onAbort = () => {
          waiting.delete(callId);
          reject(new Error('Stopped before the user decided on the plan.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.set(callId, {
          conversationId,
          decide: (d) => {
            signal.removeEventListener('abort', onAbort);
            waiting.delete(callId);
            resolve(d);
          },
        });
      });
    }

    if ('left' in decision) {
      return { output: `${PLAN_LEFT} Don't carry the plan out. Say briefly where things stand and ask what they want next.` };
    }
    if (!('approved' in decision)) {
      return {
        output:
          `${PLAN_REVISE} ` +
          (decision.feedback
            ? `Their feedback:\n\n${decision.feedback}\n\n`
            : 'They gave no specifics, so look for what could be clearer or riskier, or ask them.\n\n') +
          'Plan mode stays on: revise the plan (look further or ask questions if you need to) and call exit_plan_mode again with the whole updated plan.',
      };
    }

    useChats.getState().setPlan(conversationId, undefined);
    // The plan becomes the goal, so the work goes on turn after turn until it is done. Without a way
    // to finish a goal there is nothing to keep going on, so the plan is just carried out.
    const goal = !off('goal_done');
    if (goal) startGoal(conversationId, title, 'plan', plan);
    return {
      output:
        `${PLAN_APPROVED} Plan mode is off, so every tool works again. ` +
        (goal ? `The goal is now "${title}": the app keeps the work going turn after turn until you call goal_done. ` : '') +
        (!off('todo_write') ? "First write the plan's steps as a todo list with todo_write, then " : 'Now ') +
        'carry the plan out step by step, keeping to what was approved; if something turns out to need a different approach, tell the user and ask before changing course.' +
        (goal ? ' When everything is done and checked, call goal_done with a short summary.' : ''),
    };
  },
};

// ---- todo list ---------------------------------------------------------------------------------

const MAX_TODOS = 40;

const STATUS: Record<string, TodoStatus> = {
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  active: 'in_progress',
  started: 'in_progress',
};

/** The items of a todo_write call, as far as they parse. Works on calls still being written. */
export function todosOf(input: Record<string, unknown>): Todo[] {
  const list: unknown[] = Array.isArray(input.todos) ? input.todos : [];
  return list.slice(0, MAX_TODOS).flatMap((item): Todo[] => {
    if (typeof item === 'string') return item.trim() ? [{ content: item.trim(), status: 'pending' }] : [];
    if (!item || typeof item !== 'object') return [];
    const { content, status } = item as { content?: unknown; status?: unknown };
    if (typeof content !== 'string' || !content.trim()) return [];
    return [{ content: content.trim(), status: STATUS[String(status ?? '').toLowerCase()] ?? 'pending' }];
  });
}

export const todoWrite: Tool = {
  name: 'todo_write',
  description:
    'Keep a todo list for the task in hand, which the user sees live above their message box. Pass the WHOLE list every time (it replaces the last one): each item with a status of "pending", "in_progress" or "completed". ' +
    'Use it for work with three or more steps, or when the user gives you several things to do: write the list before starting, keep exactly one item in_progress, and mark each item completed as soon as it is truly done, not in batches. ' +
    'Add items you discover along the way and drop ones that stopped mattering. Skip it for a single quick step or a plain question. An empty list clears it.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete list, in the order to do it.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The step, as a short imperative, e.g. "Add the settings toggle".' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(input, { conversationId }) {
    if (!Array.isArray(input.todos)) {
      throw new Error('Pass the whole list as "todos": [{ "content": "...", "status": "pending" }].');
    }
    const todos = todosOf(input);
    useChats.getState().setTodos(conversationId, todos);
    if (!todos.length) return { output: 'Todo list cleared.' };
    const { done, total, current } = todoSummary(todos);
    const active = todos.filter((t) => t.status === 'in_progress').length;
    return {
      output:
        `Todo list updated: ${done} of ${total} done.` +
        (done === total ? ' Everything is done; check the work, then wrap up.' : current ? ` Next: ${current}.` : '') +
        (active > 1
          ? ' More than one item is in progress; keep to one at a time.'
          : active === 0 && done < total
            ? ' Mark the item you are starting as in_progress.'
            : ''),
    };
  },
};

// ---- goals -------------------------------------------------------------------------------------

const goalOf = (conversationId: string) => useChats.getState().conversations[conversationId]?.goal;

export const goalStart: Tool = {
  name: 'goal_start',
  description:
    'Start a goal for this chat: one concrete, checkable outcome you keep working toward, turn after turn, until it is done. While it is set the app keeps the work going with automatic messages, so you are not left to stop after a single reply. ' +
    'Use it only for substantial work that needs sustained effort across many steps, such as when the user says to keep going until something is finished, fixed or built. Never for questions, quick tasks or open-ended chat. ' +
    'Fails when a goal is already set (change it with goal_edit). End it with goal_done.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description:
          'The outcome to reach and how to tell it is reached, in a sentence or two, e.g. "Every test in tests/ passes and the build is clean".',
      },
    },
    required: ['goal'],
  },
  async run(input, { conversationId }) {
    const goal = text(input.goal);
    if (!goal) throw new Error('Pass the goal as "goal".');
    const current = goalOf(conversationId);
    if (current) {
      throw new Error(`A goal is already set: "${current.text}". Change it with goal_edit, or finish it with goal_done first.`);
    }
    startGoal(conversationId, goal, 'agent');
    return {
      output: `Goal set: "${goal}". The app now keeps the work going (up to ${goalMaxTurns()} automatic turns in a row) until you call goal_done. Start on it now.`,
    };
  },
};

export const goalEdit: Tool = {
  name: 'goal_edit',
  description:
    "Reword the chat's current goal when the work has changed shape or the outcome needs to be clearer, for example after the user redirects you. Don't narrow a goal just to be able to finish it sooner. Fails when there is no goal.",
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The goal as it should read now.' },
    },
    required: ['goal'],
  },
  async run(input, { conversationId }) {
    const goal = text(input.goal);
    if (!goal) throw new Error('Pass the new goal as "goal".');
    const current = goalOf(conversationId);
    if (!current) throw new Error('No goal is set in this chat. Start one with goal_start if the work needs it.');
    useChats.getState().setGoal(conversationId, { ...current, text: goal });
    return { output: `Goal changed to "${goal}".` };
  },
};

export const goalDelete: Tool = {
  name: 'goal_delete',
  description:
    'Remove the current goal without finishing it, because the user asked to drop it or it no longer applies. This is not how you finish a goal you achieved (use goal_done). Fails when there is no goal.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why it is being removed, in a few words.' },
    },
  },
  async run(input, { conversationId }) {
    const current = goalOf(conversationId);
    if (!current) throw new Error('No goal is set in this chat.');
    clearGoal(conversationId);
    const reason = text(input.reason);
    return {
      output: `Goal "${current.text}" removed${reason ? ` (${reason})` : ''}. The app no longer keeps the work going on its own.`,
    };
  },
};

export const goalDone: Tool = {
  name: 'goal_done',
  description:
    'Finish the goal for this chat, which stops the app from keeping the work going. Call it once the goal is fully achieved and you have checked the result, or with achieved: false when it can’t be achieved or only the user can unblock it.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What was done, in a sentence or two; or why it stopped.' },
      achieved: { type: 'boolean', description: 'False when stopping without achieving the goal. Default true.' },
    },
    required: ['summary'],
  },
  async run(input, { conversationId }) {
    const goal = goalOf(conversationId);
    if (!goal) throw new Error('No goal is set in this chat.');
    clearGoal(conversationId);
    return {
      output:
        input.achieved === false
          ? `Stopped working toward the goal "${goal.text}". Tell the user why and what they can do.`
          : `Goal "${goal.text}" marked achieved. Tell the user the outcome.`,
    };
  },
};

export const PLAN_TOOLS: Tool[] = [exitPlanMode, todoWrite, goalStart, goalEdit, goalDelete, goalDone];
