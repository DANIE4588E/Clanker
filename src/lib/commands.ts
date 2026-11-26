import type Feather from '@expo/vector-icons/Feather';
import { pluginOfTool, pluginTools } from './plugins/catalog';
import { splitQuotes } from './quotes';

/**
 * Slash commands: typed at the start of a message, they change how the chat handles it rather
 * than pointing the model at something (see lib/mentions for the rest of what "/" offers).
 */
export type CommandName = 'goal' | 'plan';

export type Command = { name: CommandName; description: string; icon: keyof typeof Feather.glyphMap };

export const COMMANDS: Command[] = [
  { name: 'goal', description: 'Set a goal and keep working on it until it’s done', icon: 'target' },
  { name: 'plan', description: 'Look into the task and propose a plan before changing anything', icon: 'map' },
];

/** The message's own text, after any quotes picked from the chat (see lib/quotes). */
const body = (text: string) => splitQuotes(text).text.trim();

const CLEAR_GOAL = /^(clear|stop|off|cancel|done|none|reset|end)$/i;

/**
 * What a message starting with /goal asks for: a goal to set, or, with nothing after it (or
 * "clear", "stop" and the like), the current one cleared. Null for any other message.
 */
export function goalCommand(text: string): { goal: string } | { clear: true } | null {
  const m = /^\/goal(?=\s|$)([\s\S]*)$/i.exec(body(text));
  if (!m) return null;
  const goal = m[1].trim();
  return !goal || CLEAR_GOAL.test(goal) ? { clear: true } : { goal };
}

/** Whether the message only clears the goal: "/goal" alone, or "/goal clear" and the like. */
export const goalClear = (text: string) => {
  const command = goalCommand(text);
  return !!command && 'clear' in command;
};

/** Whether the message starts with /plan. */
export const isPlanRequest = (text: string) => /^\/plan(?=\s|$)/i.test(body(text));

// ---- plan mode ------------------------------------------------------------------------------

/** Chats whose running reply answers a /plan message, and so may only look, not change things. */
const planning = new Set<string>();

export function setPlanning(conversationId: string, on: boolean) {
  if (on) planning.add(conversationId);
  else planning.delete(conversationId);
}

export const isPlanning = (conversationId: string) => planning.has(conversationId);

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
  'Not run: this reply answers /plan, so it may only look into the task, not change anything. Put this step in your plan; it can be carried out once the user agrees.';
