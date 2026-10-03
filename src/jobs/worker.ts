import fs from "node:fs";
import { execCommand } from "../lib/exec-runner.js";
import { buildInvocation, parseOutcome } from "./providers.js";
import {
  readJob,
  stderrFile,
  stdoutFile,
  updateJob,
  writeResult,
  type JobStatus,
} from "./store.js";

/** Runs one job to completion. Invoked in a detached process so the job outlives the caller. */
export async function runWorker(id: string): Promise<void> {
  const job = readJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);

  updateJob(id, { status: "running", workerPid: process.pid, startedAt: new Date().toISOString() });

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
      onStdout: (chunk) => out.write(chunk),
      onStderr: (chunk) => err.write(chunk),
    });
    const outcome = parseOutcome(job.provider, result.stdout, result.stderr, result.exitCode);
    fields.exitCode = result.exitCode;
    if (outcome.sessionId) fields.sessionId = outcome.sessionId;
    if (outcome.text) writeResult(id, outcome.text);

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
    updateJob(id, { ...fields, status, finishedAt: new Date().toISOString() });
  }
}
