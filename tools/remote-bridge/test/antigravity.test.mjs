import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../src/server.mjs';
import { AntigravityAdapter, applyAntigravityEvent, parseAntigravityModels, resolveAntigravityModel } from '../src/antigravity.mjs';
import { AGY_MODELS_TSV } from './fixtures/agy-models.mjs';

const token = 'fixture-token-abcdefghijklmnopqrstuvwxyz';
const listen = async (server) => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const until = async (fn) => { for (let i = 0; i < 250; i++) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('Fixture timed out.'); };
const freshRun = () => ({ id: 'run1', state: 'running', cursor: 0, content: [], controls: [], files: [] });

test('agy effort variants fold into one route per model with effort options', () => {
  const parsed = parseAntigravityModels(`Fetching available models...\n${AGY_MODELS_TSV}\n\nnot-a-model-line`);
  assert.ok(parsed.models.includes('antigravity/gemini-4-neon'));
  assert.ok(!parsed.models.some((m) => m.endsWith('-high')), 'variant rows do not become models of their own');
  assert.deepEqual(parsed.modelOptions['antigravity/gemini-4-neon'], { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' });
  assert.deepEqual(parsed.modelOptions['antigravity/gpt-oss-120b'], { efforts: ['medium'], defaultEffort: 'medium' });
  // Orchestrators carry suffixes that are not efforts, and no reasoning slider.
  assert.ok(parsed.models.includes('antigravity/gemini-pro-orchestrator-argon'));
  assert.deepEqual(parsed.modelOptions['antigravity/gemini-pro-orchestrator-neon'], { efforts: [] });
  assert.ok(parsed.models.includes('antigravity/gemini-3.8-flash'));
});

test('route plus effort resolves to the model id agy lists', () => {
  const { groups } = parseAntigravityModels(AGY_MODELS_TSV);
  assert.equal(resolveAntigravityModel(groups, 'antigravity/gemini-4-neon', 'high'), 'gemini-4-neon-high');
  assert.equal(resolveAntigravityModel(groups, 'antigravity/gemini-4-neon', undefined), 'gemini-4-neon-medium');
  // Unlisted efforts run at the default rather than failing the turn.
  assert.equal(resolveAntigravityModel(groups, 'antigravity/gemini-4-carbon', 'max'), 'gemini-4-carbon-medium');
  assert.equal(resolveAntigravityModel(groups, 'antigravity/gemini-pro-orchestrator-neon', 'high'), 'gemini-pro-orchestrator-neon');
  assert.equal(resolveAntigravityModel(groups, 'antigravity/brand-new-model', 'low'), 'brand-new-model');
});

test('stream events build the transcript, metrics, and terminal state', () => {
  const run = freshRun();
  assert.equal(applyAntigravityEvent(run, { event: 'init', conversation_id: '11111111-2222-3333-4444-555555555555', model: 'gemini-4-neon-high' }), '11111111-2222-3333-4444-555555555555');
  applyAntigravityEvent(run, { event: 'step_update', step_update: { step_index: 1, step_type: 'user_input', state: 'ACTIVE', text: 'echoed prompt' } });
  applyAntigravityEvent(run, { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'write_to_file', tool_info: { parameters: { file_path: 'hello.txt' } } } });
  applyAntigravityEvent(run, { event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello' } });
  applyAntigravityEvent(run, { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'write_to_file', duration_seconds: 0.42, tool_info: {} } });
  assert.equal(applyAntigravityEvent(run, { event: 'result', result: { conversation_id: '11111111-2222-3333-4444-555555555555', status: 'SUCCESS', response: 'Hello', duration_seconds: 2, usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 500 } } }), '11111111-2222-3333-4444-555555555555');
  // The echoed prompt is not part of the answer, and deltas merge into one text part after the tool.
  assert.deepEqual(run.content.map((p) => p.type), ['tool', 'text']);
  assert.equal(run.content[0].id, 'agy-2');
  assert.equal(run.content[0].status, 'done');
  assert.equal(run.content[0].durationMs, 420);
  assert.equal(run.content[1].text, 'Hello');
  assert.equal(run.state, 'completed');
  assert.deepEqual(run.metrics, { tokensPerSec: 100, cacheHit: 0.5 });
});

test('a result with nothing streamed still carries the answer, and errors fail the run', () => {
  const quiet = freshRun();
  applyAntigravityEvent(quiet, { event: 'result', result: { status: 'SUCCESS', response: 'All done.', duration_seconds: 1, usage: {} } });
  assert.equal(quiet.content.at(-1).text, 'All done.');
  const failed = freshRun();
  applyAntigravityEvent(failed, { event: 'result', result: { status: 'ERROR', error: 'invalid model selection (--model "nope")', finished_reason: 'MODEL_NOT_FOUND' } });
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /invalid model selection/);
});

// The full-bridge runs drive the real adapter through test/fixtures/agy.cmd, a shim that only
// cmd.exe can launch; other platforms keep the unit coverage.
const windows = process.platform === 'win32';
async function bridgeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'clanker-agy-bridge-'));
  const config = {
    kind: 'antigravity', token, stateDir: path.join(root, 'state'), workspaceRoot: path.join(root, 'workspaces'),
    antigravityPath: fileURLToPath(new URL('./fixtures/agy.cmd', import.meta.url)),
  };
  const bridge = await createBridge(config);
  const url = await listen(bridge.server);
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (route, body, init = {}) => fetch(`${url}/v1/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Clanker-Bridge': bridge.state.bridgeId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...init });
  const json = async (route, body) => { const response = await request(route, body); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const done = async (id) => until(async () => { const result = await json(`runs/${id}`); return ['completed', 'cancelled', 'failed'].includes(result.state) && result; });
  return { root, bridge, url, request, json, done };
}

test('antigravity bridge: capabilities, turns, effort as variant id, and conversation resume', { skip: windows ? false : 'agy.cmd shim is Windows-only' }, async (t) => {
  const f = await bridgeFixture(t);
  const info = await f.json('capabilities');
  assert.equal(info.kind, 'antigravity');
  assert.ok(info.models.includes('antigravity/gemini-4-neon'));
  assert.deepEqual(info.modelOptions['antigravity/gemini-4-neon'].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(info.modelSwitching, 'any');

  await f.json('sessions', { chatId: 'chat1', model: 'antigravity/gemini-4-neon', instructions: 'line one\nline two' });
  assert.equal((await f.request('sessions/chat1/runs', { submissionId: 'bad', text: 'x', files: [], effort: 'max' })).status, 400);
  const first = await f.json('sessions/chat1/runs', { submissionId: 'one', text: 'write hello.txt', files: [], effort: 'high' });
  const finished = await f.done(first.id);
  assert.equal(finished.state, 'completed');
  const tool = finished.content.find((p) => p.type === 'tool');
  assert.equal(tool.name, 'write_to_file');
  assert.equal(tool.status, 'done');
  const text = finished.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  // The high effort reaches agy inside the model id, instructions ride along, and the first turn starts fresh.
  // (The .cmd shim's command line can't carry newlines, so they arrive flattened; the direct .exe path keeps them.)
  assert.match(text, /model=gemini-4-neon-high/);
  assert.match(text, /resumed=no/);
  assert.match(text, /prompt="Project instructions: line one line two write hello\.txt"/);
  assert.deepEqual(finished.metrics, { tokensPerSec: 100, cacheHit: 0.5 });
  // The conversation id the first turn reported carries the next one.
  const second = await f.json('sessions/chat1/runs', { submissionId: 'two', text: 'again', files: [] });
  const again = await f.done(second.id);
  assert.match(again.content.filter((p) => p.type === 'text').map((p) => p.text).join(''), /resumed=yes/);
});

test('antigravity bridge: cmd.exe metacharacters in a prompt reach agy as text, never as commands', { skip: windows ? false : 'agy.cmd shim is Windows-only' }, async (t) => {
  const f = await bridgeFixture(t);
  await f.json('sessions', { chatId: 'chat3', model: 'antigravity/gemini-4-neon', instructions: '' });
  const prompt = 'say x" & echo injected> injected.txt & "y %PATH% ^& | (a) <b> !c! \\"d\\ ';
  const { id } = await f.json('sessions/chat3/runs', { submissionId: 'meta', text: prompt, files: [] });
  const finished = await f.done(id);
  assert.equal(finished.state, 'completed');
  const text = finished.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  assert.ok(text.includes(`prompt=${JSON.stringify(prompt)}`), text);
  await assert.rejects(access(path.join(f.root, 'workspaces', 'chat3', 'injected.txt')));
  await assert.rejects(access(path.join(process.cwd(), 'injected.txt')));
});

test('antigravity bridge: failed turns, stop, and no controls', { skip: windows ? false : 'agy.cmd shim is Windows-only' }, async (t) => {
  const f = await bridgeFixture(t);
  await f.json('sessions', { chatId: 'chat2', model: 'antigravity/gemini-4-neon', instructions: '' });
  const failed = await f.json('sessions/chat2/runs', { submissionId: 'boom', text: 'boom please', files: [] });
  assert.equal((await f.done(failed.id)).error, 'invalid model selection (--model "nope")');

  const hung = await f.json('sessions/chat2/runs', { submissionId: 'hang', text: 'hang on', files: [] });
  await until(async () => (await f.json(`runs/${hung.id}`)).content.some((p) => p.type === 'text'));
  await f.json(`runs/${hung.id}/stop`, {});
  assert.equal((await f.done(hung.id)).state, 'cancelled');
  const adapter = new AntigravityAdapter({});
  await assert.rejects(() => adapter.respond(freshRun(), { id: 'c', kind: 'approval', prompt: '?' }, 'once'), (error) => error.status === 409);
});
