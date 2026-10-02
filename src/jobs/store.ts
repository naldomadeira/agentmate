import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Provider = "codex" | "claude";
export type JobMode = "read-only" | "write";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled" | "timeout";

export const TERMINAL: readonly JobStatus[] = ["done", "error", "canceled", "timeout"];

export interface Job {
  id: string;
  provider: Provider;
  mode: JobMode;
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
  return process.env["AGENTS_BRIDGE_HOME"] ?? path.join(os.homedir(), ".agents-bridge");
}

export function jobDir(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
  return path.join(homeDir(), "jobs", id);
}

export const jobFile = (id: string) => path.join(jobDir(id), "job.json");
export const stdoutFile = (id: string) => path.join(jobDir(id), "stdout.log");
export const stderrFile = (id: string) => path.join(jobDir(id), "stderr.log");
export const resultFile = (id: string) => path.join(jobDir(id), "result.md");

export function newJobId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Atomic replace: readers never observe a half-written job.json. */
export function writeJob(job: Job): void {
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  const tmp = `${jobFile(job.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobFile(job.id));
}

export function readJob(id: string): Job | null {
  const file = jobFile(id); // validates the id; must stay outside the try so a bad id throws
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Job;
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
