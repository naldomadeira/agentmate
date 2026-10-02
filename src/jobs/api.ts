import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TERMINAL,
  isAlive,
  listJobIds,
  newJobId,
  readJob,
  resultFile,
  stderrFile,
  stdoutFile,
  updateJob,
  writeJob,
  type Job,
  type JobMode,
  type Provider,
} from "./store.js";

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const MAX_TIMEOUT_MS = 120 * 60_000;
const POLL_MS = 300;
/** A job whose worker vanished is only judged crashed after this grace, so a fresh spawn is not misread. */
const SPAWN_GRACE_MS = 3_000;

export interface StartOptions {
  provider: Provider;
  prompt: string;
  cwd?: string;
  model?: string;
  mode?: JobMode;
  timeoutMinutes?: number;
  continueJob?: string;
}

const isTerminal = (job: Job) => TERMINAL.includes(job.status);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where the detached worker re-enters the CLI: built `cli.mjs` next to this chunk, or `src/cli.ts` under tsx. */
function workerCommand(id: string): { command: string; args: string[] } {
  const override = process.env["AGENTS_BRIDGE_CLI"];
  const built = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const source = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const entry = override ?? (fs.existsSync(built) ? built : source);
  // Resolved to an absolute URL because the worker's cwd is the job's, which has no tsx to find.
  const loader = entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
  return { command: process.execPath, args: [...loader, entry, "worker", id] };
}

export function startJob(options: StartOptions): Job {
  let provider = options.provider;
  let sessionNote: string | undefined;
  if (options.continueJob) {
    const prior = readJob(options.continueJob);
    if (!prior) throw new Error(`Cannot continue unknown job: ${options.continueJob}`);
    if (!isTerminal(prior))
      throw new Error(`Job ${prior.id} is still ${prior.status}; wait for it before continuing.`);
    if (!prior.sessionId) throw new Error(`Job ${prior.id} has no session to continue.`);
    if (prior.provider !== provider)
      throw new Error(`Job ${prior.id} ran on ${prior.provider}, not ${provider}.`);
    provider = prior.provider;
    sessionNote = prior.id;
  }

  const timeoutMs = Math.min(
    (options.timeoutMinutes ?? DEFAULT_TIMEOUT_MS / 60_000) * 60_000,
    MAX_TIMEOUT_MS,
  );
  const job: Job = {
    id: newJobId(),
    provider,
    mode: options.mode ?? "read-only",
    prompt: options.prompt,
    cwd: options.cwd ?? process.cwd(),
    ...(options.model ? { model: options.model } : {}),
    timeoutMs,
    status: "queued",
    createdAt: new Date().toISOString(),
    ...(sessionNote ? { continuesJob: sessionNote } : {}),
  };
  writeJob(job);

  const { command, args } = workerCommand(job.id);
  const child = spawn(command, args, {
    cwd: job.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) =>
    updateJob(job.id, {
      status: "error",
      error: `Failed to start worker: ${error.message}`,
      finishedAt: new Date().toISOString(),
    }),
  );
  child.unref();
  return job;
}

/** Reads a job and repairs one whose worker died without recording an outcome. */
export function getJob(id: string): Job {
  const job = readJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  if (isTerminal(job)) return job;
  const age = Date.now() - Date.parse(job.createdAt);
  const workerGone = job.workerPid ? !isAlive(job.workerPid) : age > SPAWN_GRACE_MS * 2;
  if (workerGone && age > SPAWN_GRACE_MS) {
    return updateJob(id, {
      status: "error",
      error: "Worker process exited without recording a result.",
      finishedAt: new Date().toISOString(),
    });
  }
  return job;
}

export async function waitJob(id: string, timeoutMs: number): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(id);
    if (isTerminal(job) || Date.now() >= deadline) return job;
    await sleep(POLL_MS);
  }
}

function tail(file: string, maxChars: number): string {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return "";
  }
}

export interface Observation {
  job: Job;
  stdoutTail: string;
  stderrTail: string;
}

/** Snapshot of recent activity; a running job is left running. */
export function observeJob(id: string, maxChars = 3_000): Observation {
  const job = getJob(id);
  return {
    job,
    stdoutTail: tail(stdoutFile(id), maxChars),
    stderrTail: tail(stderrFile(id), maxChars),
  };
}

export function readResult(id: string): { job: Job; text: string | null } {
  const job = getJob(id);
  try {
    return { job, text: fs.readFileSync(resultFile(id), "utf8") };
  } catch {
    return { job, text: null };
  }
}

export async function cancelJob(id: string): Promise<Job> {
  const job = getJob(id);
  if (isTerminal(job)) return job;
  if (job.workerPid && isAlive(job.workerPid)) {
    process.kill(job.workerPid, "SIGTERM");
    const settled = await waitJob(id, 8_000);
    if (isTerminal(settled)) return settled;
    process.kill(job.workerPid, "SIGKILL");
  }
  return updateJob(id, { status: "canceled", finishedAt: new Date().toISOString() });
}

export function listJobs(options: { cwd?: string; limit?: number } = {}): Job[] {
  const jobs = listJobIds()
    .map((id) => readJob(id))
    .filter((job): job is Job => job !== null)
    .filter((job) => !options.cwd || job.cwd === options.cwd)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs.slice(0, options.limit ?? 20);
}

export function elapsedSeconds(job: Job): number {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}

export function summarize(job: Job): string {
  const parts = [
    `job ${job.id}`,
    `${job.provider}/${job.mode}`,
    job.status,
    `${elapsedSeconds(job)}s`,
  ];
  if (job.error) parts.push(`error: ${job.error}`);
  return parts.join(" · ");
}
