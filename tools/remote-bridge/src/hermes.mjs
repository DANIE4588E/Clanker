import { addText, sse, terminal, toolEvent } from './protocol.mjs';

// Hermes's effort ladder, in its order. Levels a later Hermes adds to its catalogue are kept after
// these. "ultra" is offered only where the catalogue advertises it.
const KNOWN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
function orderEfforts(names) {
  const valid = [...new Set(names.filter((name) => typeof name === 'string' && EFFORT_NAME.test(name)))];
  return [...KNOWN_EFFORTS.filter((name) => valid.includes(name)), ...valid.filter((name) => !KNOWN_EFFORTS.includes(name))];
}
// Event names across Hermes releases. Any other event (subagent.*, message.interim,
// replay.truncated, or one a newer Hermes adds) only refreshes metrics, so it can't break a run.
const TEXT_EVENTS = new Set(['message.delta', 'assistant.delta']);
const REASONING_EVENTS = new Set(['reasoning.delta', 'reasoning_delta', 'reasoning.available', 'thinking.delta']);
const CONTROL_EVENTS = { 'approval.request': 'approval', 'clarification.request': 'clarification', 'clarify.request': 'clarification' };
const SETTLED_EVENTS = new Set(['approval.settled', 'approval.responded', 'clarify.settled', 'clarify.responded', 'clarification.settled', 'clarification.responded']);
// The phone offers one-off decisions only, never Hermes's session-wide or permanent allowances.
const PHONE_APPROVALS = ['once', 'deny'];

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
function applyMetrics(run, data) {
  // Three shapes carry the same measurements: the compatibility patch's `clanker_metrics`, and
  // Hermes's own status-bar projections (its `usage_stats` counters, or the TUI `usage` view),
  // should a Hermes release put them on Runs. Cumulative prompt tokens never stand in for context.
  const usage = object(data.usage);
  const views = [object(data.clanker_metrics), object(data.metrics), object(data.session_usage), object(usage?.usage), usage].filter(Boolean);
  const metrics = { ...run.metrics };
  let context, speed, cache;
  for (const view of views) {
    const used = view.context_used ?? view.context_tokens, budget = view.context_max ?? view.context_length;
    if (!context && finite(used) && used > 0 && finite(budget) && budget > 0) {
      const estimated = typeof view.context_estimated === 'boolean' ? view.context_estimated : view.context_source !== 'provider_usage';
      context = { used: Math.min(used, budget), budget, estimated };
    }
    speed ??= [view.tokens_per_s, view.avg_tps].find(finite);
    if (cache === undefined && finite(view.cache_hit_pct)) cache = Math.min(1, view.cache_hit_pct / 100);
    // A prompt total includes cache reads; so does Runs' `input_tokens` (the session prompt count).
    const prompt = view.prompt_tokens ?? (view === usage ? usage.input_tokens : undefined);
    const cached = view.cache_read_tokens ?? view.prompt_tokens_details?.cached_tokens;
    if (cache === undefined && finite(prompt) && prompt > 0 && finite(cached)) cache = Math.min(1, cached / prompt);
  }
  if (usage && speed === undefined && finite(usage.output_tokens) && finite(usage.decode_ms) && usage.decode_ms >= 100) speed = usage.output_tokens / usage.decode_ms * 1000;
  if (context) metrics.context = context;
  if (speed !== undefined) metrics.tokensPerSec = speed;
  if (cache !== undefined) metrics.cacheHit = cache;
  if (Object.keys(metrics).length) run.metrics = metrics;
}

/** A pending approval or question, from a stream event or a polled `pending_controls` entry. */
function control(data, kind) {
  const id = data.request_id ?? data.prompt_id;
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  let prompt, choices;
  if (kind === 'approval') {
    const description = text(data.prompt) || text(data.description);
    const command = text(data.command);
    prompt = [description, command !== description ? command : ''].filter(Boolean).join('\n\n');
    const offered = Array.isArray(data.choices) ? PHONE_APPROVALS.filter((choice) => data.choices.includes(choice)) : [];
    choices = offered.length > 1 ? offered : PHONE_APPROVALS;
  } else {
    prompt = text(data.question) || text(data.prompt) || text(data.description);
    const offered = Array.isArray(data.choices) ? data.choices.filter((choice) => typeof choice === 'string' && choice.trim() && choice.length <= 500).slice(0, 20) : [];
    if (offered.length) choices = offered;
  }
  return { id, kind, prompt: prompt || JSON.stringify(data), choices, generation: data.execution_generation };
}
const controlKind = (value) => (String(value ?? '').includes('clar') ? 'clarification' : 'approval');

export function applyHermesEvent(run, event, data) {
  if (!object(data)) data = {};
  applyMetrics(run, data);
  if (TEXT_EVENTS.has(event)) addText(run, data.text ?? data.delta ?? data.content ?? '');
  if (REASONING_EVENTS.has(event)) addText(run, data.text ?? data.delta ?? '', 'thought');
  if (event === 'tool.started') toolEvent(run, data);
  if (['tool.completed', 'tool.failed'].includes(event)) toolEvent(run, { ...data, error: data.error || event === 'tool.failed' }, true);
  if (Object.hasOwn(CONTROL_EVENTS, event)) {
    const pending = control(data, CONTROL_EVENTS[event]);
    if (pending && !run.controls.some((c) => c.id === pending.id)) {
      run.controls.push(pending);
      run.state = 'waiting';
    }
  }
  if (SETTLED_EVENTS.has(event)) {
    // Answered elsewhere (Hermes Desktop, another client) or timed out: stop offering it.
    const id = data.request_id ?? data.prompt_id;
    if (id !== undefined && run.controls.some((c) => c.id === id)) {
      run.controls = run.controls.filter((c) => c.id !== id);
      if (!run.controls.length && run.state === 'waiting') run.state = 'running';
    }
  }
  if (event === 'run.completed') {
    // The terminal output is authoritative; progress commentary must not be mistaken for the answer.
    if (typeof data.output === 'string' && data.output) {
      run.content = run.content.filter((p) => p.type !== 'text'); addText(run, data.output);
    }
    run.state = 'completed';
  }
  if (['run.failed', 'run.cancelled', 'run.interrupted'].includes(event)) {
    run.state = event === 'run.cancelled' ? 'cancelled' : 'failed'; run.error = data.error?.message ?? data.error ?? 'Remote run interrupted.';
  }
}

export class HermesAdapter {
  constructor(config) { this.config = config; this.kind = 'hermes'; }
  async request(route, body, extraHeaders = {}) {
    const response = await fetch(`${this.config.upstreamUrl.replace(/\/+$/, '')}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.config.upstreamKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Object.assign(new Error(`Hermes ${response.status}: ${(await response.text()).slice(0, 500)}`), { status: response.status });
    return response.json();
  }
  async models() {
    // Feature detection, not version checks: Hermes describes its own API. A feature counts when
    // its flag is set or, should a release drop the flag, when its route is advertised.
    const capabilities = await this.request('/v1/capabilities');
    const required = { run_status: 'run_status', run_events_sse: 'run_events', run_stop: 'run_stop' };
    for (const [feature, endpoint] of Object.entries(required)) {
      if (!capabilities.features?.[feature] && !capabilities.endpoints?.[endpoint]) throw new Error(`Hermes is missing ${feature}. Update Hermes before connecting.`);
    }
    const aliases = await this.request('/v1/models');
    const routes = new Map((aliases.data ?? []).map((entry) => [entry.id, { model: entry.id }]));
    const options = Object.fromEntries([...routes.keys()].map((id) => [id, { efforts: DEFAULT_EFFORTS }]));
    let defaultRoute;
    try {
      const inventory = await this.request('/api/model/options?include_unconfigured=false');
      defaultRoute = `${inventory.provider}/${inventory.model}`;
      for (const provider of inventory.providers ?? []) {
        if (provider?.authenticated !== true || typeof provider.slug !== 'string') continue;
        const unavailable = new Set((provider.unavailable_models ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.id));
        for (const model of provider.models ?? []) {
          const id = typeof model === 'string' ? model : model?.id;
          if (typeof id !== 'string' || unavailable.has(id)) continue;
          routes.set(`${provider.slug}/${id}`, { provider: provider.slug, model: id });
          const caps = object(provider.capabilities?.[id]);
          const advertised = Array.isArray(caps?.supported_efforts) ? orderEfforts(caps.supported_efforts) : DEFAULT_EFFORTS;
          options[`${provider.slug}/${id}`] = { efforts: caps?.reasoning === false ? [] : advertised.filter((effort) => effort !== 'none' || caps?.can_disable_reasoning !== false) };
        }
      }
    } catch (error) {
      // A Hermes without the catalogue has only the compatibility aliases. A real auth or
      // provider failure must remain visible instead of silently hiding the catalogue.
      if (![404, 405].includes(error.status)) throw error;
    }
    for (const [route, efforts] of Object.entries(this.config.modelEfforts ?? {})) {
      if (!Array.isArray(efforts) || efforts.some((effort) => !KNOWN_EFFORTS.includes(effort)) || new Set(efforts).size !== efforts.length) throw new Error(`Invalid modelEfforts for ${route}. Use distinct Hermes effort names.`);
      if (routes.has(route)) options[route] = { efforts: KNOWN_EFFORTS.filter((e) => efforts.includes(e)) };
    }
    if (routes.has('hermes-agent') && options[defaultRoute] && !Object.hasOwn(this.config.modelEfforts ?? {}, 'hermes-agent')) options['hermes-agent'] = options[defaultRoute];
    this.modelRoutes = routes;
    this.modelOptions = options;
    return [...routes.keys()];
  }
  async modelRequest(session) {
    if (session.modelRequest) return session.modelRequest;
    if (!this.modelRoutes) await this.models();
    const route = this.modelRoutes.get(session.model);
    if (!route) throw new Error('The selected Hermes provider/model is unavailable. Refresh models for a new chat.');
    session.modelRequest = route;
    return route;
  }
  async ensureSession(session) {
    const id = session.upstreamCandidate ?? session.id;
    let result;
    try { result = await this.request('/api/sessions', {
      id, source: 'api_server', ...await this.modelRequest(session),
      system_prompt: `This chat works in ${session.workspace}. Read uploaded files there. Save files you create or edit inside this directory so the user can download them.\n${session.instructions}`,
    }); } catch (error) {
      if (error.status !== 409) throw error;
      result = await this.request(`/api/sessions/${encodeURIComponent(id)}`);
      result = result.session ?? result;
      if ((result.id ?? result.session_id) !== id || result.source !== 'api_server') throw new Error('The upstream session identity belongs to another surface.');
    }
    // Current Hermes wraps the row as { object, session }; older ones returned it bare.
    result = result.session ?? result;
    return result.id ?? result.session_id ?? id;
  }
  async start(run, session) {
    const result = await this.request('/v1/runs', {
      session_id: session.upstreamId, input: run.input,
      instructions: `Use this chat's workspace: ${session.workspace}. Write deliverable files here.\n${session.instructions}`,
      ...await this.modelRequest(session),
      ...(run.effort ? { model_options: { reasoning_effort: run.effort, reasoning: run.effort === 'none' ? { enabled: false } : { enabled: true, effort: run.effort } } } : {}),
    }, { 'Idempotency-Key': run.id });
    if (!result.run_id) throw new Error('Hermes returned no run identity.');
    return result.run_id;
  }
  async observe(run, update, signal) {
    const response = await fetch(`${this.config.upstreamUrl.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(run.upstreamId)}/events`, {
      headers: { Authorization: `Bearer ${this.config.upstreamKey}`, ...(run.hermesSeq === undefined ? {} : { 'Last-Event-ID': String(run.hermesSeq) }) }, signal,
    });
    // No live stream for this run (Hermes restarted, or already retired it): its status is still
    // polled, so the turn finishes from that instead of reporting a broken connection.
    if (response.status === 404) { await response.body?.cancel(); return; }
    for await (const item of sse(response)) {
      const data = object(item.data) ?? {};
      const seq = data.seq ?? (item.id === undefined ? undefined : Number(item.id));
      if (seq !== undefined && seq <= (run.hermesSeq ?? -1)) continue;
      await update((r) => {
        r.error = undefined;
        applyHermesEvent(r, data.event ?? item.event, data);
        if (Number.isInteger(seq)) r.hermesSeq = seq;
      });
      if (terminal(run.state)) return;
    }
    if (!terminal(run.state)) await this.reconcile(run, update);
  }
  async reconcile(run, update) {
    let status;
    try { status = await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      await update((r) => { r.state = 'unknown'; r.error = 'Hermes no longer has this run receipt. Check the host before acknowledging interruption; the turn will not be replayed.'; });
      return;
    }
    await update((r) => {
      applyMetrics(r, status);
      if (status.status === 'completed') applyHermesEvent(r, 'run.completed', status);
      else if (['failed', 'interrupted', 'cancelled'].includes(status.status)) applyHermesEvent(r, status.status === 'cancelled' ? 'run.cancelled' : 'run.failed', status);
      else if (status.status === 'unknown') { r.state = 'unknown'; r.error = 'Hermes restarted with an unknown execution outcome. Resolve it on the host before continuing.'; }
      else {
        r.state = status.status?.startsWith('waiting') ? 'waiting' : status.status === 'stopping' ? 'stopping' : 'running';
        if (Array.isArray(status.pending_controls)) {
          r.controls = status.pending_controls.map((c) => object(c) && control(c, controlKind(c.kind))).filter(Boolean);
          if (r.controls.length && r.state === 'running') r.state = 'waiting';
        }
      }
    });
  }
  async stop(run) { await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}/stop`, {}); }
  async respond(run, control, answer) {
    const body = { request_id: control.id, execution_generation: control.generation };
    if (control.kind === 'clarification') body.answer = answer;
    else body.choice = answer;
    await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}/${control.kind === 'clarification' ? 'clarify' : 'approval'}`, body);
  }
  async acknowledge(run) {
    if (!run.upstreamId) return;
    let status;
    try { status = await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}`); }
    catch (error) { if (error.status === 404) return; throw error; }
    if (status.status === 'unknown') {
      await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}/resolve-unknown`, { admission_id: status.admission_id, execution_generation: status.execution_generation });
    } else if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) {
      throw Object.assign(new Error('Hermes still reports this task as active. Stop it on the host first.'), { status: 409 });
    }
  }
}
