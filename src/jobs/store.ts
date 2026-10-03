import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentId } from "../agents/types.js";

export type Provider = AgentId;
export type JobMode = "read-only" | "write";
export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "canceled"
  | "timeout"
  /** The provider refused to continue because its usage allowance is spent; see `quota.ts`. */
  | "quota_exhausted";

export type JobRole =
  | "custom"
  | "ask"
  | "review"
  | "research"
  | "plan"
  | "implement"
  | "teamlead"
  | "crossreview"
  | "split";

export const JOB_ROLES = [
  "custom",
  "ask",
  "review",
  "research",
  "plan",
  "implement",
  "teamlead",
  "crossreview",
  "split",
] as const satisfies readonly JobRole[];

export const TERMINAL: readonly JobStatus[] = [
  "done",
  "error",
  "canceled",
  "timeout",
  "quota_exhausted",
];

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
  /** plan only: asks for the parts block of a split plan instead of an ordinary plan (set by the split workflow). */
  maxParts?: number;
}

/** The reviewer's last word on a round; `none` when it gave no clear verdict or the review failed. */
export type Verdict = "approve" | "request-changes" | "none";

export interface WorkflowRound {
  implementJob: string;
  reviewJob: string;
  verdict: Verdict;
}

/** Progress of a `crossreview` job: a workflow whose steps are child jobs. */
export interface Workflow {
  maxRounds: number;
  rounds: WorkflowRound[];
}

export const DEFAULT_MAX_ROUNDS = 2;
export const MAX_ROUNDS_LIMIT = 5;

/** One part of a `split` job: planned by the planner, run by `agent`, reviewed by the other agent. */
export interface SplitPart {
  id: string;
  title: string;
  agent: Provider;
  /** The plan job that produced this part. */
  planJob?: string;
  /** The research (read-only) or implement (write) job that ran the part. */
  partJob?: string;
  reviewJob?: string;
  verdict: Verdict;
  /** Write mode: the branch and worktree created for the part, and the commit it started from. */
  branch?: string;
  worktree?: string;
  base?: string;
  /** Why the part (or its review) failed. */
  error?: string;
}

/** Settings and per-part progress of a `split` job. */
export interface Split {
  maxParts: number;
  parts: SplitPart[];
}

export const DEFAULT_MAX_PARTS = 3;
export const MIN_MAX_PARTS = 2;
export const MAX_PARTS_LIMIT = 4;

export interface Job {
  id: string;
  provider: Provider;
  mode: JobMode;
  /** "custom" is a raw prompt; other roles record which builder rendered `prompt`. */
  role: JobRole;
  /** 0 = started by a human/host session, 1 = started by a worker, and so on. */
  depth: number;
  /** Id of the job whose worker started this one. */
  parentJob?: string;
  /** The prompt actually sent to the provider. */
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  workerPid?: number;
  exitCode?: number;
  /** The provider's own conversation id, used to continue the job. Not an AgentMate session. */
  sessionId?: string;
  /** Id of the AgentMate session (shared notes) this job belongs to; see `sessions.ts`. */
  session?: string;
  continuesJob?: string;
  error?: string;
  /** What a workflow job (crossreview) needs after it is started; other roles leave it unset. */
  fields?: RoleFields;
  /** Settings and per-round progress of a crossreview job. */
  workflow?: Workflow;
  /** Settings and per-part progress of a split job. */
  split?: Split;
}

/** Jobs live outside any repo so ids resolve from any session or cwd. */
export function homeDir(): string {
  const env = process.env["AGENTMATE_HOME"];
  return env && env.trim() ? env : path.join(os.homedir(), ".agentmate");
}

export function jobDir(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
  return path.join(homeDir(), "jobs", id);
}

export const jobFile = (id: string) => path.join(jobDir(id), "job.json");
export const stdoutFile = (id: string) => path.join(jobDir(id), "stdout.log");
export const stderrFile = (id: string) => path.join(jobDir(id), "stderr.log");
export const resultFile = (id: string) => path.join(jobDir(id), "result.md");

/** Writes a job's result text, readable only by the owner. */
export function writeResult(id: string, text: string): void {
  fs.writeFileSync(resultFile(id), text, { mode: 0o600 });
}

export function newJobId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Job state can hold briefings and repo excerpts, so its directories are owner-only. */
function ensureDirs(id: string): void {
  fs.mkdirSync(path.join(homeDir(), "jobs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(jobDir(id), { recursive: true, mode: 0o700 });
}

/** Atomic replace: readers never observe a half-written job.json. */
export function writeJob(job: Job): void {
  ensureDirs(job.id);
  const tmp = `${jobFile(job.id)}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, jobFile(job.id));
}

export function readJob(id: string): Job | null {
  const file = jobFile(id); // validates the id; must stay outside the try so a bad id throws
  try {
    // Defaults cover job.json files written before roles existed.
    return { role: "custom", depth: 0, ...JSON.parse(fs.readFileSync(file, "utf8")) } as Job;
  } catch {
    return null;
  }
}

/** Only the owning worker writes a job, so a plain read-modify-write is safe. */
export function updateJob(id: string, fields: Partial<Job>): Job {
  const job = readJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  const next = { ...job, ...fields };
  writeJob(next);
  return next;
}

export function listJobIds(): string[] {
  try {
    return fs.readdirSync(path.join(homeDir(), "jobs"));
  } catch {
    return [];
  }
}

/** Command line of a process (NUL separators turned into spaces); null where it cannot be read. */
export function workerCommandLine(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return null;
  }
}

/** A live pid counts only when, where readable, it is still a worker and not a recycled pid. */
export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  const cmdline = workerCommandLine(pid);
  return cmdline === null || cmdline.includes("worker");
}
