// Hermes wire shapes across releases: the bridge detects features and tolerates new events
// instead of checking Hermes's version. Same file as Clanker's tools/remote-bridge test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyHermesEvent, HermesAdapter } from '../src/hermes.mjs';

const fresh = () => ({ state: 'running', content: [], controls: [] });

test('Hermes 0.23 controls: approvals stay one-off, questions keep their choices, settled prompts go away', () => {
  const run = fresh();
  applyHermesEvent(run, 'approval.request', { event: 'approval.request', kind: 'approval', prompt_id: 'a1', execution_generation: 2, description: 'Run a shell command', command: 'rm -rf build', choices: ['once', 'deny', 'session', 'always'] });
  assert.deepEqual(run.controls[0], { id: 'a1', kind: 'approval', prompt: 'Run a shell command\n\nrm -rf build', choices: ['once', 'deny'], generation: 2 });
  applyHermesEvent(run, 'clarify.request', { kind: 'clarify', prompt_id: 'c1', execution_generation: 2, question: 'Which folder?', choices: ['src', 'docs', 7], multi_select: false });
  assert.deepEqual(run.controls[1], { id: 'c1', kind: 'clarification', prompt: 'Which folder?', choices: ['src', 'docs'], generation: 2 });
  assert.equal(run.state, 'waiting');
  applyHermesEvent(run, 'approval.settled', { prompt_id: 'a1', execution_generation: 2 });
  assert.equal(run.state, 'waiting');
  applyHermesEvent(run, 'clarify.settled', { prompt_id: 'c1', execution_generation: 2 });
  assert.deepEqual(run.controls, []); assert.equal(run.state, 'running');
});

test('unknown events and odd payloads are harmless', () => {
  const run = fresh();
  for (const event of ['subagent.start', 'message.interim', 'replay.truncated', 'run.queued', 'approval.responded', 'something.new']) applyHermesEvent(run, event, { text: 'ignored', extra: { nested: true } });
  applyHermesEvent(run, 'message.delta', null);
  applyHermesEvent(run, 'approval.request', { description: 'no identity' });
  assert.deepEqual(run, fresh());
  applyHermesEvent(run, 'thinking.delta', { delta: 'Hmm' });
  assert.deepEqual(run.content, [{ type: 'thought', text: 'Hmm' }]);
});

test('Hermes native usage projections fill the meters; per-turn token counts alone do not', () => {
  const run = fresh();
  applyHermesEvent(run, 'run.completed', { usage: { input_tokens: 5000, output_tokens: 80, total_tokens: 5080 } });
  assert.equal(run.metrics, undefined);
  applyHermesEvent(run, 'session.usage', { session_usage: { context_tokens: 9000, context_length: 128000, context_source: 'provider_usage', tokens_per_s: 51.2, prompt_tokens: 40000, cache_read_tokens: 10000 } });
  assert.deepEqual(run.metrics, { context: { used: 9000, budget: 128000, estimated: false }, tokensPerSec: 51.2, cacheHit: 0.25 });
  const tui = fresh();
  applyHermesEvent(tui, 'usage.update', { usage: { usage: { context_used: 300, context_max: 1000, context_estimated: true, cache_hit_pct: 50, avg_tps: 20 } } });
  assert.deepEqual(tui.metrics, { context: { used: 300, budget: 1000, estimated: true }, tokensPerSec: 20, cacheHit: 0.5 });
});

async function host(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new HermesAdapter({ upstreamUrl: `http://127.0.0.1:${server.address().port}`, upstreamKey: 'key' });
}

test('features are detected from advertised routes; catalogue effort levels pass through in Hermes order', async (t) => {
  const adapter = await host(t, (req, res) => {
    const send = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/capabilities') return send({ features: {}, endpoints: { run_status: {}, run_events: {}, run_stop: {} } });
    if (req.url === '/v1/models') return send({ data: [{ id: 'hermes-agent' }] });
    if (req.url.startsWith('/api/model/options')) return send({ provider: 'p', model: 'm', providers: [{ slug: 'p', authenticated: true, models: ['m', { id: 'n' }], capabilities: { m: { reasoning: true, supported_efforts: ['high', 'ultra', 'turbo', 'low', 'Bad Name'] } } }] });
    res.writeHead(404); res.end();
  });
  assert.deepEqual(await adapter.models(), ['hermes-agent', 'p/m', 'p/n']);
  assert.deepEqual(adapter.modelOptions['p/m'].efforts, ['low', 'high', 'ultra', 'turbo']);
  assert.deepEqual(adapter.modelOptions['hermes-agent'].efforts, adapter.modelOptions['p/m'].efforts);
  assert.ok(!adapter.modelOptions['p/n'].efforts.includes('ultra'));
});

test('a Hermes without the needed Runs features is reported, and a retired event stream falls back to polling', async (t) => {
  let polled = 0;
  const adapter = await host(t, (req, res) => {
    const send = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/capabilities') return send({ features: { run_status: true } });
    if (req.url === '/v1/runs/r1') { polled++; return send({ status: 'completed', output: 'Done.' }); }
    res.writeHead(404); res.end('{"error":"not found"}');
  });
  await assert.rejects(adapter.models(), /missing run_events_sse/);
  const run = { ...fresh(), upstreamId: 'r1' };
  const update = async (fn) => fn(run);
  await adapter.observe(run, update, AbortSignal.timeout(5000));
  assert.equal(run.state, 'running');
  await adapter.reconcile(run, update);
  assert.equal(polled, 1); assert.equal(run.state, 'completed'); assert.deepEqual(run.content, [{ type: 'text', text: 'Done.' }]);
});

test('non-JSON stream frames are skipped', async (t) => {
  const adapter = await host(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(': open\n\ndata: not json\n\nid: 0\ndata: {"event":"message.delta","seq":0,"delta":"Hi"}\n\nid: 1\ndata: {"event":"run.completed","seq":1,"output":"Hi there"}\n\n');
  });
  const run = { ...fresh(), upstreamId: 'r2' };
  await adapter.observe(run, async (fn) => fn(run), AbortSignal.timeout(5000));
  assert.equal(run.state, 'completed'); assert.equal(run.hermesSeq, 1); assert.deepEqual(run.content, [{ type: 'text', text: 'Hi there' }]);
});
