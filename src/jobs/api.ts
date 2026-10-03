import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAskPrompt,
  buildImplementPrompt,
  buildPlanPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  buildTeamleadPrompt,
} from "../lib/prompt-builder.js";
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
  type JobRole,
  type Provider,
} from "./store.js";

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const MAX_TIMEOUT_MS = 120 * 60_000;
const POLL_MS = 300;
/** A job whose worker vanished is only judged crashed after this grace, so a fresh spawn is not misread. */
const SPAWN_GRACE_MS = 3_000;

/** A job may start further jobs until this nesting level; a top-level session is depth 0. */
export const MAX_DELEGATION_DEPTH = 2;

/** Inputs of the role prompt builders; each role reads only the fields it documents. */
export interface RoleFields {
  question?: string;
  context?: string;
  target?: string;
  focus?: string;
  topic?: string;
  questions?: string[];
  scope?: string;
  goal?: string;
  constraints?: string;
  existingPlan?: string;
  task?: string;
  acceptance?: string;
  objective?: string;
}

/**
 * Role jobs are described by `fields` (a flat bag instead of a discriminated union, so MCP and CLI
 * layers can pass their arguments through unchanged). `prompt` is required only for the `custom`
 * role; for other roles it fills the role's primary field when `fields` leaves it out.
 */
export interface StartOptions {
  provider: Provider;
  prompt?: string;
  role?: JobRole;
  fields?: RoleFields;
  cwd?: string;
  model?: string;
  mode?: JobMode;
  timeoutMinutes?: number;
  continueJob?: string;
}

type PrimaryField = "question" | "target" | "topic" | "goal" | "task" | "objective";
const PRIMARY_FIELD: Record<Exclude<JobRole, "custom">, PrimaryField> = {
  ask: "question",
  review: "target",
  research: "topic",
  plan: "goal",
  implement: "task",
  teamlead: "objective",
};

export const isTerminal = (job: Job) => TERMINAL.includes(job.status);
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

/** Renders the prompt a job will send; the builder runs here, in the process that starts the job. */
function renderPrompt(options: StartOptions, role: JobRole, provider: Provider, mode: JobMode) {
  if (role === "custom") {
    if (!options.prompt) throw new Error("A custom job needs a prompt.");
    return options.prompt;
  }
  const primary = PRIMARY_FIELD[role];
  const fields: RoleFields = { ...options.fields };
  if (!fields[primary] && options.prompt) fields[primary] = options.prompt;
  const required = fields[primary];
  if (!required)
    throw new Error(`Role ${role} needs a ${primary} (pass fields.${primary} or prompt).`);
  const { context, constraints } = fields;
  switch (role) {
    case "ask":
      return buildAskPrompt({ question: required, context });
    case "review":
      return buildReviewPrompt({ target: required, focus: fields.focus, context });
    case "research":
      return buildResearchPrompt({
        topic: required,
        questions: fields.questions,
        scope: fields.scope,
        context,
      });
    case "plan":
      return buildPlanPrompt({
        goal: required,
        constraints,
        existingPlan: fields.existingPlan,
        context,
      });
    case "implement":
      return buildImplementPrompt({ task: required, acceptance: fields.acceptance, context });
    case "teamlead":
      return buildTeamleadPrompt({
        objective: required,
        provider,
        otherProvider: provider === "codex" ? "claude" : "codex",
        canWrite: mode === "write",
        constraints,
        context,
      });
  }
}

/** Nesting level of the calling process, set by the worker that spawned it. */
function currentDepth(): number {
  const depth = Number.parseInt(process.env["AGENTS_BRIDGE_DEPTH"] ?? "0", 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

export function startJob(options: StartOptions): Job {
  const role = options.role ?? "custom";
  const depth = currentDepth();
  if (depth >= MAX_DELEGATION_DEPTH)
    throw new Error(
      `Delegation depth limit reached (${depth} >= ${MAX_DELEGATION_DEPTH}); a delegated worker cannot start more jobs.`,
    );
  if (role === "teamlead" && depth > 0)
    throw new Error("Only a top-level session can start a teamlead job.");
  const parentJob = process.env["AGENTS_BRIDGE_JOB_ID"] || undefined;

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
  const mode = options.mode ?? "read-only";
  const job: Job = {
    id: newJobId(),
    provider,
    mode,
    role,
    depth,
    ...(parentJob ? { parentJob } : {}),
    prompt: renderPrompt(options, role, provider, mode),
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
    env: { ...process.env, AGENTS_BRIDGE_DEPTH: String(depth + 1), AGENTS_BRIDGE_JOB_ID: job.id },
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
  children: Job[];
  stdoutTail: string;
  stderrTail: string;
}

/** Snapshot of recent activity; a running job is left running. */
export function observeJob(id: string, maxChars = 3_000): Observation {
  const job = getJob(id);
  return {
    job,
    children: childJobs(id),
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

/** Jobs started by the worker of `id`, oldest first. */
export function childJobs(id: string): Job[] {
  return listJobs({ parent: id, limit: Infinity })
    .reverse()
    .map((job) => getJob(job.id));
}

export function listJobs(options: { cwd?: string; limit?: number; parent?: string } = {}): Job[] {
  const jobs = listJobIds()
    .map((id) => readJob(id))
    .filter((job): job is Job => job !== null)
    .filter((job) => !options.cwd || job.cwd === options.cwd)
    .filter((job) => !options.parent || job.parentJob === options.parent)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs.slice(0, options.limit ?? 20);
}

/** Starts a job and waits up to `waitMs`; `text` is null while it has no stored result. */
export async function askJob(
  options: StartOptions,
  waitMs: number,
): Promise<{ job: Job; text: string | null }> {
  const started = startJob(options);
  await waitJob(started.id, waitMs);
  return readResult(started.id);
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
    ...(job.role === "custom" ? [] : [job.role]),
    job.status,
    `${elapsedSeconds(job)}s`,
  ];
  if (job.parentJob) parts.push(`parent ${job.parentJob}`);
  if (job.error) parts.push(`error: ${job.error}`);
  return parts.join(" · ");
}
