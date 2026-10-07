import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventLevel, JobEvent } from "../agents/types.js";
import {
  assertAgentAvailable,
  availableAgents,
  firstAvailableOther,
  getAgent,
} from "../agents/registry.js";
import { agyModelId } from "../agents/agy.js";
import { listModels, getClosestModels } from "./models.js";

import {
  buildAskPrompt,
  buildCrossreviewPrompt,
  buildImplementPrompt,
  buildPlanPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  buildSplitPlanPrompt,
  buildSplitPrompt,
  buildTeamleadPrompt,
} from "../lib/prompt-builder.js";
import { readEvents } from "./events.js";
import { getSession, withSessionNotes } from "./sessions.js";
import {
  DEFAULT_MAX_PARTS,
  DEFAULT_MAX_ROUNDS,
  MAX_PARTS_LIMIT,
  MAX_ROUNDS_LIMIT,
  MIN_MAX_PARTS,
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
  type Effort,
  type JobRole,
  type Provider,
  type RoleFields,
} from "./store.js";

export type { RoleFields } from "./store.js";

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const MAX_TIMEOUT_MS = 120 * 60_000;
const POLL_MS = 300;
/** A job whose worker vanished is only judged crashed after this grace, so a fresh spawn is not misread. */
const SPAWN_GRACE_MS = 3_000;

/** A job may start further jobs until this nesting level; a top-level session is depth 0. */
export const MAX_DELEGATION_DEPTH = 2;

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
  /** Reasoning effort; validated against the provider's adapter before the job is written. */
  effort?: Effort;
  mode?: JobMode;
  timeoutMinutes?: number;
  continueJob?: string;
  /** crossreview only: review rounds before it stops, 1 to 5 (default 2). */
  maxRounds?: number;
  /** split only: most parts the plan may have, 2 to 4 (default 3). */
  maxParts?: number;
  /** Id of an AgentMate session whose notes prefix the prompt and which records the job. */
  sessionId?: string;
  /**
   * teamlead, crossreview, split: the agent that works with `provider`. Defaults to the first
   * installed agent that differs from it (`firstAvailableOther`); `startJob` resolves it up front,
   * checks it is installed and stores it on the job.
   */
  partner?: Provider;
}

type PrimaryField = "question" | "target" | "topic" | "goal" | "task" | "objective";
const PRIMARY_FIELD: Record<Exclude<JobRole, "custom">, PrimaryField> = {
  ask: "question",
  review: "target",
  research: "topic",
  plan: "goal",
  implement: "task",
  teamlead: "objective",
  crossreview: "task",
  split: "goal",
};

export const isTerminal = (job: Job) => TERMINAL.includes(job.status);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where the detached worker re-enters the CLI: built `cli.mjs` next to this chunk, or `src/cli.ts` under tsx. */
function workerCommand(id: string): { command: string; args: string[] } {
  const override = process.env["AGENTMATE_CLI"];
  const built = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const source = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const entry = override ?? (fs.existsSync(built) ? built : source);
  // Resolved to an absolute URL because the worker's cwd is the job's, which has no tsx to find.
  const loader = entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
  return { command: process.execPath, args: [...loader, entry, "worker", id] };
}

/** Renders the prompt a job will send; the builder runs here, in the process that starts the job. */
function renderPrompt(
  options: StartOptions,
  role: JobRole,
  provider: Provider,
  mode: JobMode,
  maxRounds: number,
  maxParts: number,
  partner: Provider | undefined,
) {
  if (role === "custom") {
    if (!options.prompt)
      throw new Error("A custom job needs a prompt. Run `agentmate jobs start --help`.");
    return options.prompt;
  }
  const primary = PRIMARY_FIELD[role];
  const fields: RoleFields = { ...options.fields };
  if (!fields[primary] && options.prompt) fields[primary] = options.prompt;
  const required = fields[primary];
  if (!required)
    throw new Error(
      `Role ${role} needs a ${primary} (pass fields.${primary} or prompt). Run \`agentmate jobs start --help\`.`,
    );
  const { context, constraints } = fields;
  switch (role) {
    case "ask":
      return buildAskPrompt({ question: required, context });
    case "review":
      return buildReviewPrompt({
        target: required,
        focus: fields.focus,
        context,
        shell: getAgent(provider).capabilities.shell,
      });
    case "research":
      return buildResearchPrompt({
        topic: required,
        questions: fields.questions,
        scope: fields.scope,
        context,
      });
    case "plan":
      // The split workflow asks its planner for a parts block through this role.
      if (fields.maxParts)
        return buildSplitPlanPrompt({
          goal: required,
          acceptance: fields.acceptance,
          maxParts: fields.maxParts,
          agents: partner ? [provider, partner] : availableAgents(),
        });
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
        otherProvider: partner ?? firstAvailableOther(provider),
        canWrite: mode === "write",
        constraints,
        context,
      });
    case "crossreview":
      return buildCrossreviewPrompt({
        task: required,
        acceptance: fields.acceptance,
        implementer: provider,
        reviewer: partner ?? firstAvailableOther(provider),
        maxRounds,
      });
    case "split":
      return buildSplitPrompt({
        goal: required,
        acceptance: fields.acceptance,
        planner: provider,
        partner: partner ?? firstAvailableOther(provider),
        maxParts,
        mode,
      });
  }
}

/** Nesting level of the calling process, set by the worker that spawned it. */
function currentDepth(): number {
  const depth = Number.parseInt(process.env["AGENTMATE_DEPTH"] ?? "0", 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/** What the crossreview worker needs to brief its steps: the task, acceptance criteria and context. */
function crossreviewFields(options: StartOptions): RoleFields {
  const { acceptance, context } = options.fields ?? {};
  return {
    task: options.fields?.task || options.prompt || "",
    ...(acceptance ? { acceptance } : {}),
    ...(context ? { context } : {}),
  };
}

/** What the split worker needs to brief its steps: the goal and acceptance criteria. */
function splitFields(options: StartOptions): RoleFields {
  const { acceptance } = options.fields ?? {};
  return {
    goal: options.fields?.goal || options.prompt || "",
    ...(acceptance ? { acceptance } : {}),
  };
}

export function startJob(options: StartOptions): Job {
  const role = options.role ?? "custom";
  const depth = currentDepth();
  if (depth >= MAX_DELEGATION_DEPTH)
    throw new Error(
      `Delegation depth limit reached (${depth} >= ${MAX_DELEGATION_DEPTH}); a delegated worker cannot start more jobs. Report back to your parent instead.`,
    );
  if ((role === "teamlead" || role === "crossreview" || role === "split") && depth > 0)
    throw new Error(
      `Only a top-level session can start a ${role} job. Start it from the host session with \`agentmate jobs start\`.`,
    );
  if (options.maxRounds !== undefined) {
    if (role !== "crossreview") throw new Error("maxRounds applies only to the crossreview role.");
    if (
      !Number.isInteger(options.maxRounds) ||
      options.maxRounds < 1 ||
      options.maxRounds > MAX_ROUNDS_LIMIT
    )
      throw new Error(`maxRounds must be a whole number from 1 to ${MAX_ROUNDS_LIMIT}.`);
  }
  if (role === "crossreview" && options.continueJob)
    throw new Error(
      "A crossreview job cannot continue another job; it continues its own implementer sessions.",
    );
  if (options.maxParts !== undefined) {
    if (role !== "split") throw new Error("maxParts applies only to the split role.");
    if (
      !Number.isInteger(options.maxParts) ||
      options.maxParts < MIN_MAX_PARTS ||
      options.maxParts > MAX_PARTS_LIMIT
    )
      throw new Error(
        `maxParts must be a whole number from ${MIN_MAX_PARTS} to ${MAX_PARTS_LIMIT}.`,
      );
  }
  if (role === "split" && options.continueJob)
    throw new Error("A split job cannot continue another job; it starts its own plan and parts.");
  if (options.partner !== undefined) {
    if (role !== "teamlead" && role !== "crossreview" && role !== "split" && role !== "plan")
      throw new Error("partner applies only to the teamlead, crossreview, split and plan roles.");
    if (options.partner === options.provider)
      throw new Error(
        `partner must differ from the provider (both are ${options.provider}). Pick another agent.`,
      );
  }
  // Validated up front so an unknown session never leaves a half-started job behind.
  if (options.sessionId) getSession(options.sessionId);
  const parentJob = process.env["AGENTMATE_JOB_ID"] || undefined;

  let provider = options.provider;
  let sessionNote: string | undefined;
  // A continued job keeps the effort it ran with unless the caller names another.
  let effort = options.effort;
  let model = options.model;
  if (options.continueJob) {
    if (!getAgent(provider).capabilities.resume)
      throw new Error(
        `Continuing a job is not available for ${provider} yet (its --resume is unverified). Start a new job with the full context instead.`,
      );
    const prior = readJob(options.continueJob);
    if (!prior)
      throw new Error(
        `Cannot continue unknown job: ${options.continueJob}. Run \`agentmate jobs list\`.`,
      );
    if (!isTerminal(prior))
      throw new Error(
        `Job ${prior.id} is still ${prior.status}; wait for it before continuing. Run \`agentmate jobs wait ${prior.id}\`.`,
      );
    if (!prior.sessionId)
      throw new Error(
        `Job ${prior.id} has no session to continue. Run \`agentmate jobs result ${prior.id}\`.`,
      );
    if (prior.provider !== provider)
      throw new Error(
        `Job ${prior.id} ran on ${prior.provider}, not ${provider}. Start the follow-up with \`agentmate jobs start ${prior.provider}\`.`,
      );
    provider = prior.provider;
    sessionNote = prior.id;
    effort ??= prior.effort;
    model ??= prior.model;
  }
  const cwd = options.cwd ?? process.cwd();
  assertAgentAvailable(provider, cwd);
  if (effort) {
    const adapter = getAgent(provider);
    const refusal = adapter.effortError
      ? adapter.effortError({ effort, model })
      : `${provider} cannot apply a reasoning effort. Drop effort.`;
    if (refusal) throw new Error(refusal);
  }

  if (model && process.env["AGENTMATE_SKIP_MODEL_CHECK"] !== "1") {
    const catalog = listModels(provider);
    if (catalog.available) {
      if (provider === "codex") {
        const m = catalog.models.find((x) => x.id === model);
        if (!m) {
          const closest = getClosestModels(
            model,
            catalog.models.map((x) => x.id),
            3,
          );
          throw new Error(
            `Unknown codex model "${model}". Closest: ${closest.join(", ")}. Run mate_models to see all.`,
          );
        }
        if (effort && m.efforts && !m.efforts.includes(effort)) {
          throw new Error(
            `Model ${model} does not support effort "${effort}". Supported efforts: ${m.efforts.join(", ")}.`,
          );
        }
      } else if (provider === "agy") {
        const finalId = agyModelId(model, effort);
        const validIds = new Set<string>();
        for (const m of catalog.models) {
          validIds.add(m.id);
          if (m.efforts) {
            for (const e of m.efforts) validIds.add(`${m.id}-${e}`);
          }
        }
        if (!validIds.has(finalId)) {
          const closest = getClosestModels(finalId, Array.from(validIds), 3);
          throw new Error(
            `Unknown agy model "${finalId}". Closest: ${closest.join(", ")}. Run mate_models to see all.`,
          );
        }
      }
    }
  }
  // The partner is settled before anything is spawned: a default pointing at an agent that is not
  // installed would otherwise fail only after the implementer had already edited files.
  const needsPartner = role === "teamlead" || role === "crossreview" || role === "split";
  const partner = needsPartner
    ? (options.partner ?? firstAvailableOther(provider, cwd))
    : options.partner;
  if (partner) assertAgentAvailable(partner, cwd);

  const timeoutMs = Math.min(
    (options.timeoutMinutes ?? DEFAULT_TIMEOUT_MS / 60_000) * 60_000,
    MAX_TIMEOUT_MS,
  );
  const writes = role === "implement" || role === "crossreview";
  if (writes && options.mode === "read-only")
    throw new Error(`Role ${role} needs mode write. Drop --mode or pass --mode write.`);
  const mode = options.mode ?? (writes ? "write" : "read-only");
  const leadAdapter = getAgent(provider);
  if (role === "teamlead" && leadAdapter.teamleadNeedsWrite && mode !== "write")
    throw new Error(
      leadAdapter.teamleadWriteReason ??
        `A ${provider} team lead needs mode write: delegation requires the shell, which ${provider} only allows in write mode.`,
    );
  if (mode === "write" && process.env["AGENTMATE_PARENT_MODE"] === "read-only")
    throw new Error(
      "The parent job is read-only, so this job cannot use mode write. Start it read-only or from the host session.",
    );
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxParts = options.maxParts ?? DEFAULT_MAX_PARTS;
  const rendered = renderPrompt(options, role, provider, mode, maxRounds, maxParts, partner);
  const prompt = options.sessionId ? withSessionNotes(options.sessionId, rendered) : rendered;
  const job: Job = {
    id: newJobId(),
    provider,
    mode,
    role,
    depth,
    ...(parentJob ? { parentJob } : {}),
    prompt,
    cwd,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    timeoutMs,
    status: "queued",
    createdAt: new Date().toISOString(),
    ...(sessionNote ? { continuesJob: sessionNote } : {}),
    ...(partner ? { partner } : {}),
    ...(options.sessionId ? { session: options.sessionId } : {}),
    ...(role === "crossreview"
      ? {
          fields: crossreviewFields(options),
          workflow: { maxRounds, rounds: [] },
        }
      : {}),
    ...(role === "split" ? { fields: splitFields(options), split: { maxParts, parts: [] } } : {}),
  };
  writeJob(job);

  const { command, args } = workerCommand(job.id);
  const child = spawn(command, args, {
    cwd: job.cwd,
    env: {
      ...process.env,
      AGENTMATE_DEPTH: String(depth + 1),
      AGENTMATE_JOB_ID: job.id,
      AGENTMATE_PARENT_MODE: job.mode,
    },
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
  if (!job) throw new Error(`Job not found: ${id}. Run \`agentmate jobs list\`.`);
  if (isTerminal(job)) return job;
  const age = Date.now() - Date.parse(job.createdAt);
  const workerGone = job.workerPid ? !isAlive(job.workerPid) : age > SPAWN_GRACE_MS * 2;
  if (workerGone && age > SPAWN_GRACE_MS) {
    return updateJob(id, {
      status: "error",
      error:
        "Worker process exited without recording a result. Run `agentmate doctor` and retry the job.",
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
  events: JobEvent[];
  stdoutTail: string;
  stderrTail: string;
}

export interface ObserveOptions {
  /** Include the raw stdout/stderr tails (empty strings otherwise). */
  raw?: boolean | undefined;
  /** Event levels to show; defaults to important + status. */
  levels?: EventLevel[] | undefined;
  /** Newest N events, default 30. */
  limit?: number | undefined;
}

const DEFAULT_OBSERVE_LEVELS: EventLevel[] = ["important", "status"];
const DEFAULT_OBSERVE_EVENTS = 30;
const RAW_TAIL_CHARS = 3_000;

/** Snapshot of recent activity; a running job is left running. Raw output is opt-in. */
export function observeJob(id: string, options: ObserveOptions = {}): Observation {
  const job = getJob(id);
  return {
    job,
    children: childJobs(id),
    events: readEvents(id, {
      levels: options.levels ?? DEFAULT_OBSERVE_LEVELS,
      limit: options.limit ?? DEFAULT_OBSERVE_EVENTS,
    }),
    stdoutTail: options.raw ? tail(stdoutFile(id), RAW_TAIL_CHARS) : "",
    stderrTail: options.raw ? tail(stderrFile(id), RAW_TAIL_CHARS) : "",
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

/** The worker leads its own process group (spawned detached), so signalling the group reaches its agent CLI too. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    try {
      process.kill(pid, signal);
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code !== "ESRCH") throw fallback;
    }
  }
}

/**
 * Cancels the job. It is first marked `cancelRequested`, so a workflow worker can tell a cancel of
 * the whole job from a child that was canceled on its own. Its non-terminal children (recursively)
 * are canceled next, in parallel, so a workflow worker that dies from SIGKILL cannot leave orphans
 * running; then the job's own worker gets SIGTERM. The returned job is `id` itself.
 */
export function cancelJob(id: string): Promise<Job> {
  return cancelTree(id, new Set());
}

async function cancelTree(id: string, visited: Set<string>): Promise<Job> {
  visited.add(id);
  const job = getJob(id);
  if (isTerminal(job)) return job;
  updateJob(id, { cancelRequested: true });
  await Promise.all(
    childJobs(id)
      .filter((child) => !visited.has(child.id) && !isTerminal(child))
      .map((child) => cancelTree(child.id, visited)),
  );
  return cancelOne(id);
}

async function cancelOne(id: string): Promise<Job> {
  const job = getJob(id);
  if (isTerminal(job)) return job;
  if (job.workerPid && isAlive(job.workerPid)) {
    signalGroup(job.workerPid, "SIGTERM");
    const settled = await waitJob(id, 8_000);
    if (isTerminal(settled)) return settled;
    signalGroup(job.workerPid, "SIGKILL");
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
    ...(job.model || job.effort
      ? [[job.model ?? "default model", job.effort].filter(Boolean).join(" · ")]
      : []),
    job.status,
    `${elapsedSeconds(job)}s`,
  ];
  if (job.parentJob) parts.push(`parent ${job.parentJob}`);
  if (job.session) parts.push(`session ${job.session}`);
  if (job.error) parts.push(`error: ${job.error}`);
  return parts.join(" · ");
}
