import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeRequire = createRequire(path.join(root, 'package.json'));
const ts = nodeRequire('typescript');

/** Loads a TypeScript module from src/lib with its imports answered from `stubs`. */
function load(file, stubs) {
  const source = readFileSync(path.join(root, 'src/lib', file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name in stubs) return stubs[name];
    throw new Error(`${file} imports ${name}, which the test doesn't stub`);
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(require, module, module.exports);
  return module.exports;
}

// ---- a store with one chat ---------------------------------------------------------------------

const state = {
  conversations: { c: { id: 'c' } },
  setGoal: (id, goal) => (state.conversations[id] = { ...state.conversations[id], goal }),
  setPlan: (id, plan) => (state.conversations[id] = { ...state.conversations[id], plan }),
  setTodos: (id, todos) => (state.conversations[id] = { ...state.conversations[id], todos: todos?.length ? todos : undefined }),
};
const settings = { disabledTools: [], goalMaxTurns: 20 };
const stubs = {
  '@/store/chats': { useChats: { getState: () => state } },
  '@/store/settings': { useSettings: { getState: () => settings } },
};
const planning = load('planning.ts', stubs);
const plan = load('tools/plan.ts', { ...stubs, '../notifications': { notifyQuestion: async () => {} }, '../planning': planning });

const chat = () => state.conversations.c;
const ctx = (callId = 'call1') => ({ conversationId: 'c', callId, signal: new AbortController().signal });
const reset = () => {
  state.conversations.c = { id: 'c' };
  settings.disabledTools = [];
};

// ---- plan mode ---------------------------------------------------------------------------------

test('a plan can only be submitted in plan mode', async () => {
  reset();
  await assert.rejects(() => plan.exitPlanMode.run({ title: 'T', plan: 'Do it' }, ctx()), /Plan mode is not on/);
});

test('accepting a plan ends plan mode and makes it the goal', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  const waiting = plan.exitPlanMode.run({ title: 'Move files', plan: '1. Move them' }, ctx());
  plan.approvePlan('call1');
  const { output } = await waiting;
  assert.match(output, /^The user approved the plan\./);
  assert.equal(plan.planOutcome(output), 'approved');
  assert.equal(chat().plan, undefined);
  assert.equal(chat().goal.text, 'Move files');
  assert.equal(chat().goal.by, 'plan');
  assert.equal(chat().goal.plan, '1. Move them');
  assert.match(output, /todo_write/);
});

test('without a way to finish goals, accepting just ends plan mode', async () => {
  reset();
  settings.disabledTools = ['goal_done'];
  state.setPlan('c', { startedAt: 1 });
  const waiting = plan.exitPlanMode.run({ title: 'Move files', plan: '1. Move them' }, ctx());
  plan.approvePlan('call1');
  await waiting;
  assert.equal(chat().plan, undefined);
  assert.equal(chat().goal, undefined);
});

test('asking for changes keeps plan mode on and passes the feedback on', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  const waiting = plan.exitPlanMode.run({ title: 'T', plan: 'P' }, ctx());
  plan.revisePlan('call1', '  Skip step 2  ');
  const { output } = await waiting;
  assert.equal(plan.planOutcome(output), 'revise');
  assert.match(output, /Skip step 2/);
  assert.ok(chat().plan);
  assert.equal(chat().goal, undefined);
});

test('a message typed while the plan waits is feedback on it', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  const waiting = plan.exitPlanMode.run({ title: 'T', plan: 'P' }, ctx());
  assert.equal(plan.answerPlanInWords('other', 'hi'), false);
  assert.equal(plan.answerPlanInWords('c', 'Use fewer steps'), true);
  assert.match((await waiting).output, /Use fewer steps/);
});

test('leaving plan mode releases a waiting plan', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  const waiting = plan.exitPlanMode.run({ title: 'T', plan: 'P' }, ctx());
  plan.cancelWaitingPlan('c');
  const { output } = await waiting;
  assert.equal(plan.planOutcome(output), 'left');
});

test('stopping the reply rejects a waiting plan', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  const controller = new AbortController();
  const waiting = plan.exitPlanMode.run({ title: 'T', plan: 'P' }, { conversationId: 'c', callId: 'call9', signal: controller.signal });
  controller.abort();
  await assert.rejects(() => waiting, /Stopped/);
});

test('a decision made before the call starts is kept for it', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  plan.approvePlan('early1');
  const { output } = await plan.exitPlanMode.run({ title: 'T', plan: 'P' }, ctx('early1'));
  assert.equal(plan.planOutcome(output), 'approved');
});

test('a plan without a title is named from its first line', async () => {
  reset();
  state.setPlan('c', { startedAt: 1 });
  const waiting = plan.exitPlanMode.run({ plan: '## Reorganise the reports folder\n\n1. Go' }, ctx());
  plan.approvePlan('call1');
  await waiting;
  assert.equal(chat().goal.text, 'Reorganise the reports folder');
});

// ---- todo list ---------------------------------------------------------------------------------

test('reads todo items leniently', () => {
  assert.deepEqual(
    plan.todosOf({
      todos: [
        { content: ' Write tests ', status: 'in-progress' },
        { content: 'Ship', status: 'done' },
        { content: 'Celebrate' },
        'Just a string',
        { content: '', status: 'pending' },
        null,
      ],
    }),
    [
      { content: 'Write tests', status: 'in_progress' },
      { content: 'Ship', status: 'completed' },
      { content: 'Celebrate', status: 'pending' },
      { content: 'Just a string', status: 'pending' },
    ]
  );
  assert.deepEqual(plan.todosOf({}), []);
});

test('todo_write replaces the list and reports progress', async () => {
  reset();
  const { output } = await plan.todoWrite.run(
    { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] },
    ctx()
  );
  assert.equal(chat().todos.length, 3);
  assert.match(output, /1 of 3 done\. Next: B\./);
  assert.equal((await plan.todoWrite.run({ todos: [] }, ctx())).output, 'Todo list cleared.');
  assert.equal(chat().todos, undefined);
  await assert.rejects(() => plan.todoWrite.run({}, ctx()), /whole list/);
});

test('todo_write nudges toward one item in progress', async () => {
  reset();
  const two = await plan.todoWrite.run({ todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }] }, ctx());
  assert.match(two.output, /one at a time/);
  const none = await plan.todoWrite.run({ todos: [{ content: 'A', status: 'pending' }] }, ctx());
  assert.match(none.output, /in_progress/);
  const all = await plan.todoWrite.run({ todos: [{ content: 'A', status: 'completed' }] }, ctx());
  assert.match(all.output, /Everything is done/);
});

test('shows the list as the model reads it', () => {
  assert.equal(
    planning.todoText([{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }]),
    '1. [x] A\n2. [~] B\n3. [ ] C'
  );
  assert.deepEqual(
    planning.todoSummary([{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]),
    { done: 1, total: 2, current: 'B' }
  );
});

// ---- goals -------------------------------------------------------------------------------------

test('a model starts, edits, deletes and finishes a goal', async () => {
  reset();
  await assert.rejects(() => plan.goalEdit.run({ goal: 'x' }, ctx()), /No goal/);
  await assert.rejects(() => plan.goalDone.run({ summary: 's' }, ctx()), /No goal/);
  await assert.rejects(() => plan.goalDelete.run({}, ctx()), /No goal/);

  assert.match((await plan.goalStart.run({ goal: 'Fix the build' }, ctx())).output, /Goal set: "Fix the build"/);
  assert.equal(chat().goal.by, 'agent');
  await assert.rejects(() => plan.goalStart.run({ goal: 'Another' }, ctx()), /already set/);

  await plan.goalEdit.run({ goal: 'Fix the build and the tests' }, ctx());
  assert.equal(chat().goal.text, 'Fix the build and the tests');
  assert.equal(chat().goal.by, 'agent');

  assert.match((await plan.goalDelete.run({ reason: 'user changed their mind' }, ctx())).output, /removed \(user changed their mind\)/);
  assert.equal(chat().goal, undefined);

  await plan.goalStart.run({ goal: 'Again' }, ctx());
  assert.match((await plan.goalDone.run({ summary: 'done' }, ctx())).output, /marked achieved/);
  assert.equal(chat().goal, undefined);
  await plan.goalStart.run({ goal: 'Once more' }, ctx());
  assert.match((await plan.goalDone.run({ summary: 'blocked', achieved: false }, ctx())).output, /Stopped working/);
});

test('pausing and resuming a goal', () => {
  reset();
  planning.startGoal('c', 'Ship it', 'user');
  state.setGoal('c', { ...chat().goal, turns: 7, idle: 1 });
  assert.equal(planning.goalActive(chat().goal), true);
  planning.pauseGoal('c', 'You paused it.', true);
  assert.equal(planning.goalActive(chat().goal), false);
  assert.deepEqual(chat().goal.paused, { reason: 'You paused it.', manual: true });
  planning.resumeGoal('c');
  assert.equal(planning.goalActive(chat().goal), true);
  assert.equal(chat().goal.turns, 0);
  assert.equal(chat().goal.idle, undefined);
  assert.equal(chat().goal.paused, undefined);
  planning.clearGoal('c');
  assert.equal(chat().goal, undefined);
});

test('the nudge says how far the goal is and what is left', () => {
  const goal = { text: 'Ship it', setAt: 0, turns: 3, idle: 0 };
  const todos = [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }];
  const note = planning.goalNudgeContext(goal, todos, 20);
  assert.match(note, /automatic turn 3 of 20/);
  assert.match(note, /1 item on your todo list is still open/);
  assert.doesNotMatch(note, /no tool calls/);
  assert.match(planning.goalNudgeContext({ ...goal, idle: 1 }, undefined, 20), /no tool calls/);
});

test('names where a goal stands for the user', () => {
  planning.formatElapsed(1);
  assert.equal(planning.formatElapsed(45_000), '45s');
  assert.equal(planning.formatElapsed(5 * 60_000), '5m');
  assert.equal(planning.formatElapsed(3 * 3_600_000 + 20 * 60_000), '3h 20m');
  const status = planning.goalStatus({ text: 'Ship it', setAt: Date.now() - 60_000, turns: 4, by: 'plan' });
  assert.match(status, /4 of 20 automatic turns/);
  assert.match(status, /Set by the approved plan/);
  assert.match(planning.goalStatus({ text: 'x', setAt: Date.now(), turns: 0, paused: { reason: 'Limit' } }), /Paused: Limit/);
});
