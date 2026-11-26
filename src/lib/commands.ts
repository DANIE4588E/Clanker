import type Feather from '@expo/vector-icons/Feather';
import { pluginOfTool, pluginTools } from './plugins/catalog';
import { splitQuotes } from './quotes';
import { studyAvailable } from './study';

/**
 * Slash commands: typed at the start of a message, they change how the chat handles it rather
 * than pointing the model at something (see lib/mentions for the rest of what "/" offers).
 */
export type CommandName = 'goal' | 'plan' | 'study' | 'compact';

export type Command = { name: CommandName; description: string; icon: keyof typeof Feather.glyphMap };

export const COMMANDS: Command[] = [
  { name: 'goal', description: 'Set a goal and keep working on it until it’s done', icon: 'target' },
  { name: 'plan', description: 'Research first, then propose a plan for you to approve', icon: 'map' },
  { name: 'study', description: 'Learn step by step: guided answers, quizzes and flashcards', icon: 'book-open' },
  { name: 'compact', description: 'Summarise the chat so far to free up context', icon: 'minimize-2' },
];

/** The commands that work now: /study comes with the Study plugin. */
export const availableCommands = () => COMMANDS.filter((c) => c.name !== 'study' || studyAvailable());

/** The message's own text, after any quotes picked from the chat (see lib/quotes). */
const body = (text: string) => splitQuotes(text).text.trim();

const CLEAR_WORDS = /^(clear|stop|off|cancel|done|none|reset|end|delete|remove)$/i;
const PAUSE_WORDS = /^(pause|hold)$/i;
const RESUME_WORDS = /^(resume|continue|unpause)$/i;

export type GoalCommand = { goal: string } | { clear: true } | { pause: true } | { resume: true } | { status: true };

/**
 * What a message starting with /goal asks for: a goal to set; "clear", "stop" and the like to end
 * the current one; "pause" or "resume"; or, with nothing after it, how the goal is doing. Null for
 * any other message.
 */
export function goalCommand(text: string): GoalCommand | null {
  const m = /^\/goal(?=\s|$)([\s\S]*)$/i.exec(body(text));
  if (!m) return null;
  const goal = m[1].trim();
  if (!goal) return { status: true };
  if (CLEAR_WORDS.test(goal)) return { clear: true };
  if (PAUSE_WORDS.test(goal)) return { pause: true };
  if (RESUME_WORDS.test(goal)) return { resume: true };
  return { goal };
}

/** Whether the message only manages the goal (clear, pause, resume, status) and sends nothing to the model. */
export const goalControl = (text: string) => {
  const command = goalCommand(text);
  return !!command && !('goal' in command);
};

const END_PLAN = /^(exit|off|cancel|stop|done|end|clear|none|reset)$/i;

/**
 * What a message starting with /plan asks for: plan mode on, with the task to plan if there is one
 * (an empty string when there isn't), or, with "exit", "off" and the like, plan mode ended.
 */
export function planCommand(text: string): { start: string } | { exit: true } | null {
  const m = /^\/plan(?=\s|$)([\s\S]*)$/i.exec(body(text));
  if (!m) return null;
  const task = m[1].trim();
  return END_PLAN.test(task) ? { exit: true } : { start: task };
}

/** Whether the message starts with /plan. */
export const isPlanRequest = (text: string) => /^\/plan(?=\s|$)/i.test(body(text));

/** Whether the message only switches plan mode on or off, with nothing to send to the model. */
export const planControl = (text: string) => {
  const command = planCommand(text);
  return !!command && ('exit' in command || !command.start);
};

const END_STUDY = /^(exit|off|cancel|stop|done|end|clear|none|reset|quit)$/i;

/**
 * What a message starting with /study asks for: study mode on, with what to study if anything
 * follows (an empty string when nothing does), or, with "off", "exit" and the like, study mode
 * ended. Null for any other message, and while the Study plugin isn't added.
 */
export function studyCommand(text: string): { start: string } | { exit: true } | null {
  const m = /^\/study(?=\s|$)([\s\S]*)$/i.exec(body(text));
  if (!m || !studyAvailable()) return null;
  const topic = m[1].trim();
  return END_STUDY.test(topic) ? { exit: true } : { start: topic };
}

/** Whether the message only switches study mode on or off, with nothing to send to the model. */
export const studyControl = (text: string) => {
  const command = studyCommand(text);
  return !!command && ('exit' in command || !command.start);
};

/**
 * What a message starting with /compact asks for: the chat so far replaced by a summary the model
 * writes, with what to focus on if anything follows the command (an empty string when nothing does).
 */
export function compactCommand(text: string): { focus: string } | null {
  const m = /^\/compact(?=\s|$)([\s\S]*)$/i.exec(body(text));
  return m ? { focus: m[1].trim() } : null;
}

// Built-in tools that change files, run code or act; everything else only looks.
const CHANGING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'move_path',
  'delete_path',
  'run_python',
  'run_javascript',
  'run_shell',
  'job_kill',
  'memory_save',
  'memory_update',
  'memory_forget',
  'skill_manage',
  // The plan decides what to work toward; a goal is set when the user approves it.
  'goal_start',
  'goal_edit',
  'goal_delete',
  'goal_done',
]);
const PHONE_LOOKING = new Set(['phone_screen', 'phone_list_apps']);

/** Whether the tool can change something: a file, the phone, or the user's apps and accounts. */
export function changesThings(name: string) {
  if (CHANGING_TOOLS.has(name)) return true;
  if (name.startsWith('phone_')) return !PHONE_LOOKING.has(name);
  // Plugin tools say for themselves; for MCP servers, whatever isn't marked read-only counts.
  const plugin = pluginOfTool(name);
  return !!plugin && !!pluginTools(plugin).find((t) => t.name === name)?.write;
}

export const PLAN_REFUSAL =
  'Not run: plan mode is on, so you may only look into the task (read, search, browse, ask the user), not change anything. Put this step in your plan and submit it with exit_plan_mode; it can be carried out once the user approves.';
