// A stand-in for the Antigravity CLI, matching what the adapter relies on:
// `models` prints the id/display TSV (plus a progress line on stderr); print mode takes the
// prompt right after -p, resumes a conversation with --conversation, and answers turn by turn
// with stream-json NDJSON on stdout.
import { AGY_MODELS_TSV } from './agy-models.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (args[0] === 'models') {
  process.stderr.write('Fetching available models...\n');
  process.stdout.write(`${AGY_MODELS_TSV}\n`);
  process.exit(0);
}

const prompt = flag('-p') ?? '';
const conversation = flag('--conversation');
const model = flag('--model');
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const conversationId = conversation ?? '11111111-2222-3333-4444-555555555555';

emit({ event: 'init', subtype: 'success', conversation_id: conversationId, model });
emit({ event: 'step_update', step_update: { step_index: 1, step_type: 'user_input', state: 'ACTIVE', text: prompt } });
if (prompt.startsWith('boom')) {
  emit({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', error: 'invalid model selection (--model "nope")', finished_reason: 'MODEL_NOT_FOUND' } });
  process.exit(1);
}
if (prompt.startsWith('hang')) {
  // Streams its first words, then waits forever (until killed) — like a turn the user stops.
  // The interval keeps the event loop busy; without one, Node exits unsettled top-level awaits itself.
  emit({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Working on it' } });
  await new Promise(() => { setInterval(() => {}, 1000); });
}

emit({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { file_path: 'hello.txt' } } } });
emit({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'write_to_file', duration_seconds: 0.42, tool_info: { name: 'write_to_file', parameters: { file_path: 'hello.txt' } } } });
const response = `model=${model} resumed=${conversation ? 'yes' : 'no'} prompt=${JSON.stringify(prompt)}`;
emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: response.slice(0, 12) } });
emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: response.slice(12) } });
emit({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response, duration_seconds: 2, num_turns: 1, usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 40, cache_read_tokens: 500, total_tokens: 1740 } } });
process.exit(0);
