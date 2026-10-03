import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Provider = "codex" | "claude";
export type JobMode = "read-only" | "write";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled" | "timeout";

export type JobRole = "custom" | "ask" | "review" | "research" | "plan" | "implement" | "teamlead";

export const JOB_ROLES = [
  "custom",
  "ask",
  "review",
  "research",
  "plan",
  "implement",
  "teamlead",
] as const satisfies readonly JobRole[];

export const TERMINAL: readonly JobStatus[] = ["done", "error", "canceled", "timeout"];

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
  sessionId?: string;
  continuesJob?: string;
  error?: string;
}

/** Jobs live outside any repo so ids resolve from any session or cwd. */
export function homeDir(): string {
  return process.env["AGENTMATE_HOME"] ?? path.join(os.homedir(), ".agentmate");
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
  const tmp = `${jobFile(job.id)}.${process.pid}.tmp`;
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

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
