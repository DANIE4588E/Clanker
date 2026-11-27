import { useChats } from '@/store/chats';
import type { ToolOutcome } from './tools';
import { markObserved } from './tools/observe';
import { workspaceFilesChanged } from './workspace';

/**
 * Background jobs: scripts and shell commands the model started with `background: true`. They
 * outlive the reply that started them (not an app restart), and the model collects their results
 * with job_output. Each job also updates the tool row that started it.
 */

export type JobStatus = 'running' | 'done' | 'error' | 'killed';

type Job = {
  id: string;
  conversationId: string;
  messageId: string;
  toolId: string;
  tool: string;
  label: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  outcome?: ToolOutcome;
  /** Whether the model has read the result with job_output. */
  collected: boolean;
  /** When the job was first seen collected (see prune). */
  collectedAt?: number;
  controller: AbortController;
  done: Promise<void>;
  /** Called once when the job finishes; see waitForJob. */
  waiters: Set<() => void>;
};

const MAX_RUNNING = 4;
const jobs = new Map<string, Job>();

// Collected jobs that finished this long ago drop out of the chat's job list (see jobsOf).
const STALE_MS = 30 * 60_000;

/**
 * Forgets finished jobs, with their output, once the model has collected them and they have been
 * out of the job list for a while; until then job_output can still read them again.
 */
function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running' || !job.collected) continue;
    // job_output and job_kill mark a job collected; it's timed from when that's first seen here.
    job.collectedAt ??= now;
    if ((job.finishedAt ?? Infinity) < now - STALE_MS && job.collectedAt < now - STALE_MS) jobs.delete(id);
  }
}

function newId() {
  for (;;) {
    const id = `j${Math.random().toString(36).slice(2, 6)}`;
    if (!jobs.has(id)) return id;
  }
}

export function runningJobs() {
  prune();
  return [...jobs.values()].filter((j) => j.status === 'running').length;
}

/** Starts `run` detached and returns the job; throws when too many are running. */
export function startJob(opts: {
  conversationId: string;
  messageId: string;
  toolId: string;
  tool: string;
  label: string;
  run: (signal: AbortSignal, jobId: string) => Promise<ToolOutcome>;
}) {
  if (runningJobs() >= MAX_RUNNING) {
    throw new Error(`${MAX_RUNNING} background jobs are already running. Wait for one with job_output, or stop one with job_kill.`);
  }
  const controller = new AbortController();
  const id = newId();
  const job: Job = {
    id,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    toolId: opts.toolId,
    tool: opts.tool,
    label: opts.label,
    status: 'running',
    startedAt: Date.now(),
    collected: false,
    controller,
    done: Promise.resolve(),
    waiters: new Set(),
  };
  jobs.set(id, job);
  useChats.getState().patchTool(opts.conversationId, opts.messageId, opts.toolId, { background: { job: id, status: 'running' } });
  job.done = opts
    .run(controller.signal, id)
    .catch((e): ToolOutcome => ({ output: e instanceof Error ? e.message : String(e), isError: true }))
    .then((outcome) => {
      job.outcome = outcome;
      job.finishedAt = Date.now();
      if (job.status === 'running') job.status = outcome.isError ? 'error' : 'done';
      if (outcome.files?.length) markObserved(job.conversationId, outcome.files);
      // Scripts and commands write files.
      workspaceFilesChanged();
      useChats.getState().patchTool(job.conversationId, job.messageId, job.toolId, {
        background: { job: id, status: job.status, output: outcome.output },
        ...(outcome.files?.length ? { files: outcome.files } : {}),
      });
    })
    .finally(() => {
      const waiters = [...job.waiters];
      job.waiters.clear();
      for (const wake of waiters) wake();
    });
  return job;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function killJob(id: string) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.status = 'killed';
  job.controller.abort();
  return true;
}

/** Resolves when the job finishes, or after `ms`, or when `signal` aborts. */
export function waitForJob(job: Job, ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    // Whichever comes first lets go of the others, so waits that time out don't pile up on a long job.
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      job.waiters.delete(stop);
      resolve();
    };
    const timer = setTimeout(stop, ms);
    signal.addEventListener('abort', stop);
    if (job.status !== 'running' && job.finishedAt != null) stop();
    else job.waiters.add(stop);
  });
}

function age(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function describeJob(job: Job) {
  const now = Date.now();
  const state =
    job.status === 'running'
      ? `running for ${age(now - job.startedAt)}`
      : `${job.status} after ${age((job.finishedAt ?? now) - job.startedAt)}, ${age(now - (job.finishedAt ?? now))} ago${job.collected ? '' : ', not collected yet'}`;
  return `${job.id} ${job.tool} "${job.label}": ${state}`;
}

/** Jobs started in a chat, newest first. Collected jobs that finished long ago are left out. */
export function jobsOf(conversationId: string) {
  prune();
  const stale = Date.now() - STALE_MS;
  return [...jobs.values()]
    .filter((j) => j.conversationId === conversationId && !(j.collected && (j.finishedAt ?? Infinity) < stale))
    .sort((a, b) => b.startedAt - a.startedAt);
}
