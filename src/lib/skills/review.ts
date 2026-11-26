import { messageText, useChats } from '@/store/chats';
import { resolveTaskModel, thinkingEffort, useSettings } from '@/store/settings';
import { enabledSkills, useSkills } from '@/store/skills';
import { getAdapter, type Endpoint, type ToolPart } from '../providers';
import { apiKeys } from '../storage';
import { describeCall } from '../tools/describe';
import { buildSkillMd, patchSkillMd, readSkillMd, saveSkill, skillsLearn, slugify } from './index';

/**
 * Self-improving skills, after Hermes Agent: once a reply has done real work, a background request
 * asks a model whether the task taught something worth keeping as a skill, or showed a skill it
 * used to be wrong, and saves what it says. Models with skill_manage are asked to do this
 * themselves as they work; this catches what they leave, and works without tool calling.
 */

// A reply with at least this many tool calls is reviewed: the "complex task" Hermes looks for.
const MIN_TOOL_CALLS = 5;
// The review sees this much of the request, the reply, each call and the whole transcript.
const REQUEST_CHARS = 3000;
const REPLY_CHARS = 3000;
const INPUT_CHARS = 700;
const OUTPUT_CHARS = 400;
const STEPS_CHARS = 18_000;
// Skills the reply loaded are shown in full, so the review can fix them; up to this many, this long.
const USED_SKILLS = 3;
const USED_SKILL_CHARS = 10_000;
const REVIEW_TIMEOUT = 180_000;
const MAX_EDITS = 4;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Skills a reply loaded with skill_view. */
function usedSkills(calls: ToolPart[]) {
  const names = calls.flatMap((c) =>
    c.name === 'skill_view' && c.status === 'done' && typeof c.input.name === 'string' && !c.input.file ? [c.input.name] : []
  );
  return [...new Set(names)].filter((n) => useSkills.getState().skills[n]?.enabled);
}

/**
 * Whether a finished reply is worth reviewing: it did enough work, or it used a skill and hit an
 * error along the way, and the model didn't already look after skills itself.
 */
export function shouldReviewSkills(calls: ToolPart[]) {
  if (!skillsLearn() || calls.some((c) => c.name === 'skill_manage')) return false;
  const errored = calls.some((c) => c.status === 'error');
  return calls.length >= MIN_TOOL_CALLS || (errored && usedSkills(calls).length > 0);
}

function steps(calls: ToolPart[]) {
  const lines = calls.map((c, i) => {
    const { background: _, ...input } = c.input as Record<string, unknown>;
    const head = `${i + 1}. ${describeCall(c.name, c.input)} [${c.name}${c.status === 'error' ? ', failed' : ''}]`;
    const args = clip(JSON.stringify(input), INPUT_CHARS);
    const out = c.output ? `\n   ${c.status === 'error' ? 'error' : 'result'}: ${clip(c.output.trim(), OUTPUT_CHARS)}` : '';
    return `${head}\n   input: ${args}${out}`;
  });
  const text = lines.join('\n');
  if (text.length <= STEPS_CHARS) return text;
  // The start and end of a long run say most: how it began and what finally worked.
  return `${text.slice(0, STEPS_CHARS / 2)}\n[… steps omitted …]\n${text.slice(-STEPS_CHARS / 2)}`;
}

type Decision =
  | { action: 'create'; name?: unknown; description?: unknown; body?: unknown }
  | { action: 'patch'; name?: unknown; edits?: unknown }
  | { action: 'none' };

function parseDecision(raw: string): Decision | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && typeof value.action === 'string' ? value : null;
  } catch {
    return null;
  }
}

let reviewing: Promise<void> = Promise.resolve();

/** Reviews a finished reply for skills to save or fix. Failures are ignored; skills are a nicety. */
export function reviewSkills(
  conversationId: string,
  replyId: string,
  chatEndpoint: Endpoint,
  chatApiKey: string | undefined,
  chatModel: string
) {
  reviewing = reviewing.then(() => reviewOnce(conversationId, replyId, chatEndpoint, chatApiKey, chatModel)).catch(() => {});
  return reviewing;
}

async function reviewOnce(
  conversationId: string,
  replyId: string,
  chatEndpoint: Endpoint,
  chatApiKey: string | undefined,
  chatModel: string
) {
  const conversation = useChats.getState().conversations[conversationId];
  const index = conversation?.messages.findIndex((m) => m.id === replyId) ?? -1;
  if (!conversation || index < 0 || !skillsLearn()) return;
  const reply = conversation.messages[index];
  const calls = reply.content.filter((p): p is ToolPart => p.type === 'tool' && p.status !== 'writing');
  const user = conversation.messages.slice(0, index).findLast((m) => m.role === 'user');
  const request = user ? messageText(user).trim() : '';
  if (!request) return;

  const used = usedSkills(calls).slice(0, USED_SKILLS);
  const usedText = used.flatMap((name) => {
    try {
      return [`<skill name="${name}">\n${clip(readSkillMd(name), USED_SKILL_CHARS)}\n</skill>`];
    } catch {
      return [];
    }
  });
  const existing = enabledSkills();
  const prompt =
    'You maintain a library of skills for an AI assistant in a chat app. A skill is a set of reusable instructions for a ' +
    'kind of task; future chats load one when a task matches its description. Below are the existing skills and a task ' +
    'the assistant just worked on, with its tool calls.\n\n' +
    `Existing skills:\n${existing.length ? existing.map((s) => `- ${s.name}: ${clip(s.description, 300)}`).join('\n') : '(none)'}\n\n` +
    (usedText.length ? `Skills the assistant used in this task, in full:\n${usedText.join('\n\n')}\n\n` : '') +
    `The task:\n<request>\n${clip(request, REQUEST_CHARS)}\n</request>\n<steps>\n${steps(calls)}\n</steps>\n` +
    `<final_reply>\n${clip(messageText(reply).trim(), REPLY_CHARS)}\n</final_reply>\n\n` +
    'Decide whether this task taught something worth keeping.\n' +
    '- Create a skill when the assistant worked out a non-trivial, reusable way of doing a kind of task the user is ' +
    'likely to want again: a workflow, the code or commands that worked, the fix for an error it got stuck on, pitfalls ' +
    'to avoid. Write it for a model that has never seen this chat: when to use it, the steps, the exact code or ' +
    'commands that worked, pitfalls, and how to check the result. Generalise it: leave out the specifics of this one ' +
    'task (file names, the user\'s data) unless they matter every time, and never include personal details or secrets.\n' +
    (usedText.length
      ? '- Improve a skill the assistant used when this task showed it to be wrong, incomplete or out of date: give exact ' +
        'text from the skill to replace and its replacement.\n'
      : '') +
    '- Otherwise change nothing. Most tasks need no skill: one-off requests, simple lookups, tasks any capable assistant ' +
    'does well without help, and tasks that went smoothly with an existing skill. Never make a near-duplicate of an ' +
    'existing skill.\n\n' +
    'Reply with JSON only, no other text, one of:\n' +
    '{"action": "none"}\n' +
    '{"action": "create", "name": "lowercase-hyphenated-name", "description": "What it does and when to use it, in one or two sentences.", "body": "The markdown instructions."}' +
    (usedText.length
      ? '\n{"action": "patch", "name": "a skill shown in full above", "edits": [{"old": "exact text from the skill", "new": "its replacement"}]}'
      : '');

  // A model picked for skills in Settings wins over the chat's own, while it still exists.
  const settings = useSettings.getState();
  const picked = resolveTaskModel(settings.endpoints, settings.skillModel);
  const endpoint = picked?.endpoint ?? chatEndpoint;
  const model = picked?.model ?? chatModel;
  const apiKey = picked && picked.endpoint.id !== chatEndpoint.id ? (await apiKeys.get(endpoint.id)) ?? undefined : chatApiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVIEW_TIMEOUT);
  let raw = '';
  try {
    await getAdapter(endpoint.type).stream({
      endpoint,
      apiKey,
      model,
      // Judging what generalises, and writing it up, goes better with thinking.
      effort: thinkingEffort(settings, { endpointId: endpoint.id, model }),
      signal: controller.signal,
      messages: [{ role: 'user', images: [], text: prompt }],
      onToken: (t) => (raw += t),
    });
  } catch {
    return;
  } finally {
    clearTimeout(timeout);
  }

  const decision = parseDecision(raw);
  // The user may have turned this off while it ran.
  if (!decision || !skillsLearn()) return;
  let saved: { name: string; created: boolean } | null = null;
  try {
    if (decision.action === 'create') {
      const { description, body } = decision;
      const name = typeof decision.name === 'string' ? slugify(decision.name) : '';
      if (!name || typeof description !== 'string' || typeof body !== 'string') return;
      if (useSkills.getState().skills[name]) return;
      const skill = saveSkill({ skillMd: buildSkillMd(name, description, body), name, source: 'auto', conversationId });
      saved = { name: skill.name, created: true };
    } else if (decision.action === 'patch') {
      const { name, edits } = decision;
      if (typeof name !== 'string' || !used.includes(name) || !Array.isArray(edits)) return;
      let applied = 0;
      for (const e of edits.slice(0, MAX_EDITS)) {
        if (!e || typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old || e.old === e.new) continue;
        try {
          patchSkillMd(name, e.old, e.new, false, 'auto', conversationId);
          applied++;
        } catch {
          // Text that isn't in the skill, or is in it more than once: skip that edit.
        }
      }
      if (applied) saved = { name, created: false };
    }
  } catch {
    return;
  }
  if (saved) {
    const current = useChats.getState().conversations[conversationId]?.messages.find((m) => m.id === replyId);
    useChats.getState().updateMessage(conversationId, replyId, { skillSaved: [...(current?.skillSaved ?? []), saved] });
  }
}
