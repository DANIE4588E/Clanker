import { spawn } from 'node:child_process';
import { addText, terminal, toolEvent } from './protocol.mjs';

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.]*(-[a-z0-9.]+)*$/i;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP = 'antigravity';
const needsShell = (command) => /\.(cmd|bat)$/i.test(command);

// cmd.exe's special characters. Each one is caret-escaped, quotes included, so cmd never enters a
// quoted region it could be talked out of, and `%VAR%` becomes `%VAR^%`, a variable that isn't set.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const caret = (value) => value.replace(CMD_META, '^$1');
/** One argument for a program reading its command line with the C runtime's rules (quotes and backslashes). */
const crtQuote = (value) => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
/**
 * The cmd.exe command line for a .cmd/.bat shim. cmd parses it once, and the shim parses its `%*`
 * again when it passes the arguments on, so arguments are escaped twice. cmd can't carry a newline
 * inside an argument at all, so newlines become spaces.
 */
export const cmdLine = (command, args) => [caret(command), ...args.map((arg) => caret(caret(crtQuote(String(arg).replace(/[\r\n]+/g, ' ')))))].join(' ');

/**
 * Spawns the CLI. A .cmd/.bat shim only runs through cmd.exe, whose parser would act on `&`, `|`,
 * `%VAR%` and quotes inside a prompt, so its command line is fully escaped by hand (see cmdLine).
 * The direct .exe path, which the official installer puts on PATH, takes arguments as they are
 * and keeps multi-line prompts intact.
 */
const cliSpawn = (command, args, options) => {
  if (!needsShell(command)) return spawn(command, args, options);
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine(command, args)}"`], { ...options, windowsVerbatimArguments: true });
};

/** Runs the CLI with no stdin and returns its stdout; the failure carries stderr's tail. */
const collect = (command, args, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const child = cliSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const timer = setTimeout(() => { child.kill(); reject(new Error('It took too long to answer.')); }, timeoutMs);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  // `agy models` has been seen to write its table and still exit nonzero; usable stdout wins.
  child.once('close', (code) => { clearTimeout(timer); code === 0 || stdout.trim() ? resolve(stdout) : reject(new Error(stderr.trim().split(/\r?\n/).pop() || `exit ${code}`)); });
});

// Fire-and-forget on purpose: the stop route marks the run 'stopping' the moment this returns, so a
// later process death reads as cancelled — awaiting the kill would let it read as failed instead.
const killTree = (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32' && child.pid) {
    // agy leaves helper processes behind when only its own is killed.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => child.kill());
    return;
  }
  child.kill();
};

/**
 * `agy models`' TSV → the backend's model routes. The CLI lists one row per effort variant
 * (`gemini-4-neon-high`); variants that differ only in an effort suffix are folded back into one
 * route with those suffixes as its effort choices, so the phone's model-plus-effort picker maps
 * onto what agy actually takes.
 */
export function parseAntigravityModels(stdout) {
  const groups = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.split('\t')[0]?.trim();
    if (!id || !MODEL_ID.test(id)) continue;
    const suffix = id.match(EFFORT_SUFFIX)?.[1];
    const base = suffix ? id.slice(0, -(suffix.length + 1)) : id;
    const group = groups.get(base) ?? { variants: [], efforts: [] };
    group.variants.push(id);
    if (suffix) group.efforts.push(suffix);
    groups.set(base, group);
  }
  const models = [], modelOptions = {};
  for (const [base, group] of groups) {
    const route = `${GROUP}/${base}`;
    group.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    // Effort variants read as one model with a slider, so medium leads when it exists.
    if (group.efforts.length) group.defaultEffort = group.efforts.includes('medium') ? 'medium' : group.efforts.at(-1);
    models.push(route);
    modelOptions[route] = { efforts: [...group.efforts], ...(group.defaultEffort ? { defaultEffort: group.defaultEffort } : {}) };
  }
  return { models, modelOptions, groups };
}

/** The `--model` value agy lists for a route plus effort: the variant id when one exists. */
export function resolveAntigravityModel(groups, route, effort) {
  const base = route.startsWith(`${GROUP}/`) ? route.slice(GROUP.length + 1) : route;
  const group = groups.get(base);
  if (!group) return base;
  // A stale client asking for an effort the model doesn't list runs at the default rather than failing.
  for (const wanted of [effort, group.defaultEffort]) {
    const variant = wanted ? `${base}-${wanted}` : undefined;
    if (variant && group.variants.includes(variant)) return variant;
  }
  return base;
}

/**
 * One stream-json message into the run's transcript. Text streams as `text_delta`s, so the turn's
 * final response is already there by the time the result arrives, except when nothing streamed.
 * Returns the conversation id when the message carries one, for resuming later turns.
 */
export function applyAntigravityEvent(run, message) {
  if (message?.event === 'step_update') {
    const step = message.step_update ?? {};
    if (step.step_type === 'agent_response' && step.text_delta) addText(run, step.text_delta);
    if (step.step_type === 'tool') {
      const info = step.tool_info ?? {};
      const id = `agy-${step.step_index}`;
      const name = step.tool_name ?? info.name ?? 'Remote tool';
      if (step.state === 'ACTIVE') toolEvent(run, { id, name, input: info.parameters });
      else if (step.state === 'DONE' || step.state === 'ERROR') {
        toolEvent(run, { id, name, ...(step.state === 'ERROR' ? { error: true } : {}), duration: step.duration_seconds, ...(info.output === undefined ? {} : { output: info.output }) }, true);
      }
    }
    return undefined;
  }
  if (message?.event === 'init') return message.conversation_id || undefined;
  if (message?.event !== 'result') return undefined;
  const result = message.result ?? {};
  if (result.status === 'SUCCESS') {
    run.state = 'completed';
    if (!run.content.some((part) => part.type === 'text' && part.text.trim()) && result.response) addText(run, result.response);
  } else {
    run.state = 'failed';
    run.error = result.error || 'Antigravity reported an error without details.';
  }
  const usage = result.usage ?? {};
  const metrics = {};
  if (result.duration_seconds > 0 && usage.output_tokens > 0) metrics.tokensPerSec = Math.round((usage.output_tokens / result.duration_seconds) * 10) / 10;
  if (usage.input_tokens > 0 && usage.cache_read_tokens > 0) metrics.cacheHit = Math.min(1, Math.round((usage.cache_read_tokens / usage.input_tokens) * 100) / 100);
  if (Object.keys(metrics).length) run.metrics = { ...run.metrics, ...metrics };
  return result.conversation_id || undefined;
}

/**
 * Drives the Google Antigravity CLI (`agy`) in print mode: one `agy -p` child per turn, with
 * `--conversation <id>` resuming the same conversation across a chat's turns. Print mode never
 * waits on a permission prompt — an ask_question is auto-skipped on the host — so this adapter
 * surfaces no controls; text and tool activity stream through `--output-format stream-json`,
 * and stopping runs by killing the turn's process.
 */
export class AntigravityAdapter {
  constructor(config) {
    this.config = config;
    this.kind = 'antigravity';
    this.path = config.antigravityPath ?? 'agy';
    this.extraArgs = Array.isArray(config.antigravityArgs) ? config.antigravityArgs.map(String) : [];
    this.modelOptions = {};
    this.groups = new Map();
    this.turns = new Map();
    this.modelList = [];
    this.modelsAt = 0;
  }
  async models() {
    if (this.modelList.length && Date.now() - this.modelsAt < 60000) return this.modelList;
    let stdout;
    try { stdout = await collect(this.path, ['models']); }
    catch (error) { throw new Error(`Could not read models from the Antigravity CLI (\`${this.path} models\`). Install agy and sign in on this device: ${error.message}`); }
    const parsed = parseAntigravityModels(stdout);
    if (!parsed.models.length) throw new Error('The Antigravity CLI listed no models. Sign in on this device first, then test the connection again.');
    this.groups = parsed.groups;
    this.modelOptions = parsed.modelOptions;
    this.modelList = parsed.models;
    this.modelsAt = Date.now();
    return parsed.models;
  }
  // A conversation only exists once a turn has run; the real id is learned from that turn's events.
  async ensureSession(session) { return session.upstreamCandidate; }
  async start(run, session) {
    if (!this.modelList.length) await this.models();
    const prompt = `${session.instructions ? `Project instructions:\n${session.instructions}\n\n` : ''}${run.input}`;
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (CONVERSATION_ID.test(session.agyConversation ?? '')) args.push('--conversation', session.agyConversation);
    args.push('--model', resolveAntigravityModel(this.groups, session.model, run.effort), ...this.extraArgs);
    const child = cliSpawn(this.path, args, { cwd: session.workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const turn = { child, events: [], stderr: '', exit: undefined, consumed: 0, session, notify: null };
    turn.wake = () => { const notify = turn.notify; turn.notify = null; notify?.(); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        // Progress notices can land in the stream between events; they carry no JSON.
        try { turn.events.push(JSON.parse(line)); } catch { /* not an event line */ }
        turn.wake();
      }
    });
    child.stderr.on('data', (chunk) => { turn.stderr = (turn.stderr + chunk).slice(-4000); });
    child.once('error', (error) => { turn.exit = { error: error.message }; turn.wake(); });
    child.once('close', (code, signal) => {
      const tail = buffer.trim();
      buffer = '';
      if (tail) { try { turn.events.push(JSON.parse(tail)); } catch { /* not an event line */ } turn.wake(); }
      turn.exit ??= { code, signal };
      turn.wake();
    });
    this.turns.set(run.id, turn);
    return run.id;
  }
  async observe(run, update, signal) {
    const turn = this.turns.get(run.id);
    if (!turn) {
      // The process died with the bridge before; its outcome can't be read back.
      if (run.state === 'running') await update((r) => { r.state = 'unknown'; r.error = 'The bridge restarted during this Antigravity turn. Check the host; this turn will not be repeated.'; });
      return;
    }
    while (!signal.aborted) {
      const from = turn.consumed;
      turn.consumed = turn.events.length;
      for (const event of turn.events.slice(from)) {
        let conversationId;
        await update((r) => { conversationId = applyAntigravityEvent(r, event); });
        if (CONVERSATION_ID.test(conversationId ?? '')) turn.session.agyConversation = conversationId;
        if (terminal(run.state)) { this.turns.delete(run.id); return; }
      }
      if (turn.exit) {
        this.turns.delete(run.id);
        if (!terminal(run.state)) await update((r) => {
          // Either stop route already asked for this turn to end; its death is the answer, not a failure.
          if (r.stopRequested || r.state === 'stopping') { r.state = 'cancelled'; return; }
          if (turn.exit.error) { r.state = 'failed'; r.error = `Could not start the Antigravity CLI: ${turn.exit.error}`; return; }
          const line = turn.stderr.trim().split(/\r?\n/).filter(Boolean).pop();
          r.state = turn.exit.code === 0 ? 'cancelled' : 'failed';
          if (r.state === 'failed') r.error = `Antigravity ended without a result${turn.exit.code === undefined ? '' : ` (exit ${turn.exit.code})`}.${line ? ` ${line}` : ''}`;
        });
        return;
      }
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); turn.notify = null; signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 2000);
        turn.notify = done;
        if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
      });
    }
  }
  async stop(run) { killTree(this.turns.get(run.id)?.child); }
  async respond() { throw Object.assign(new Error('Antigravity turns handle permission prompts on the host; this bridge cannot answer them.'), { status: 409 }); }
  async close() { for (const turn of this.turns.values()) killTree(turn.child); this.turns.clear(); }
}
