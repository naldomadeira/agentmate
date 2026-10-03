import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { EventLevel, JobEvent } from "../agents/types.js";
import { getAgent } from "../agents/registry.js";
import { execCommand } from "../lib/exec-runner.js";
import { runCrossreview } from "./crossreview.js";
import { appendEvent } from "./events.js";
import { runSplit } from "./split.js";
import { buildInvocation, parseOutcome } from "./providers.js";
import {
  readJob,
  stderrFile,
  stdoutFile,
  updateJob,
  writeResult,
  type JobStatus,
} from "./store.js";

const MAX_MESSAGE_CHARS = 500;

/** Runs one job to completion. Invoked in a detached process so the job outlives the caller. */
export async function runWorker(id: string): Promise<void> {
  const job = readJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  // A workflow job runs no agent CLI itself; its steps are child jobs.
  if (job.role === "crossreview") return runCrossreview(id);
  if (job.role === "split") return runSplit(id);

  const startedAt = Date.now();
  updateJob(id, {
    status: "running",
    workerPid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
  });

  /** Events are a progress aid; failing to record one must never fail the job. */
  const record = (event: Omit<JobEvent, "ts" | "job">): void => {
    try {
      appendEvent(id, { ts: new Date().toISOString(), job: id, ...event });
    } catch {
      // ignored on purpose
    }
  };
  const emit = (level: EventLevel, kind: JobEvent["kind"], text: string) =>
    record({ level, kind, text });
  emit("important", "started", `${job.provider}/${job.mode}`);

  const adapter = getAgent(job.provider);
  const streaming = adapter.capabilities.streaming === "jsonl" && !!adapter.parseStreamLine;
  /** Parsed events keep their own timestamps and levels; `job` is always this job. */
  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      for (const event of adapter.parseStreamLine?.(line) ?? [])
        record({ ...event, job: id } as JobEvent);
    } catch {
      // A line the adapter cannot parse is skipped.
    }
  };
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const feed = (chunk: Buffer | string): void => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
  };

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());

  const out = fs.createWriteStream(stdoutFile(id), { flags: "a", mode: 0o600 });
  const err = fs.createWriteStream(stderrFile(id), { flags: "a", mode: 0o600 });
  const closed = (s: fs.WriteStream) => new Promise<void>((resolve) => s.end(resolve));

  let status: JobStatus = "error";
  const fields: Parameters<typeof updateJob>[1] = {};
  try {
    const prior = job.continuesJob ? readJob(job.continuesJob) : null;
    const { command, args } = buildInvocation(job, prior?.sessionId);
    const result = await execCommand({
      command,
      args,
      cwd: job.cwd,
      timeoutMs: job.timeoutMs,
      signal: controller.signal,
      onStdout: (chunk) => {
        out.write(chunk);
        if (streaming) feed(chunk);
      },
      onStderr: (chunk) => err.write(chunk),
    });
    if (streaming && pending) {
      parseLine(pending + decoder.end());
      pending = "";
    }
    const outcome = parseOutcome(job.provider, result.stdout, result.stderr, result.exitCode);
    fields.exitCode = result.exitCode;
    if (outcome.sessionId) fields.sessionId = outcome.sessionId;
    if (outcome.text) writeResult(id, outcome.text);
    if (!streaming && outcome.text)
      emit("important", "message", outcome.text.slice(0, MAX_MESSAGE_CHARS));

    if (result.aborted) status = "canceled";
    else if (result.timedOut) {
      status = "timeout";
      fields.error = `Exceeded the ${Math.round(job.timeoutMs / 60_000)} minute job deadline.`;
    } else if (!outcome.text) {
      status = "error";
      fields.error =
        outcome.errors.join("; ") || `${job.provider} exited ${result.exitCode} with no output.`;
    } else status = "done";
  } catch (error) {
    fields.error = error instanceof Error ? error.message : String(error);
  } finally {
    await Promise.all([closed(out), closed(err)]);
    if (status === "error" && fields.error) emit("important", "error", fields.error);
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    emit(
      "important",
      "finished",
      status === "done" ? `done · ${seconds}s` : (fields.error ?? `${status} · ${seconds}s`),
    );
    updateJob(id, { ...fields, status, finishedAt: new Date().toISOString() });
  }
}
