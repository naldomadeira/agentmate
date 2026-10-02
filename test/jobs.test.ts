import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelJob,
  getJob,
  listJobs,
  observeJob,
  readResult,
  startJob,
  waitJob,
} from "../src/jobs/api.js";
import { updateJob } from "../src/jobs/store.js";

// A stand-in for the codex CLI. The prompt (last argument) selects the behavior.
const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const emit = (e) => console.log(JSON.stringify(e));
if (prompt === "sleep") { emit({ type: "thread.started", thread_id: "t-sleep" }); setInterval(() => {}, 1000); }
else if (prompt === "fail") { console.error("boom"); process.exit(1); }
else {
  emit({ type: "thread.started", thread_id: "t-1" });
  emit({ type: "item.completed", item: { id: "i", type: "agent_message", text: "args=" + args.join(" ") } });
}
`;

let home: string;
const saved = { ...process.env };

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-test-"));
  const bin = path.join(home, "fake-codex");
  fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  process.env["AGENTS_BRIDGE_HOME"] = path.join(home, "state");
  process.env["AGENTS_BRIDGE_CODEX_BIN"] = bin;
  process.env["AGENTS_BRIDGE_CLI"] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
});

afterAll(() => {
  process.env = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

const start = (prompt: string, extra: Partial<Parameters<typeof startJob>[0]> = {}) =>
  startJob({ provider: "codex", prompt, cwd: home, ...extra });

describe("jobs", () => {
  it("runs a job in the background and stores its result and session", async () => {
    const job = start("hello");
    expect(job.status).toBe("queued");
    const done = await waitJob(job.id, 20_000);
    expect(done.status).toBe("done");
    expect(done.sessionId).toBe("t-1");
    const { text } = readResult(job.id);
    expect(text).toContain("exec --json --sandbox read-only hello");
  }, 30_000);

  it("maps write mode and model onto the provider flags", async () => {
    const job = start("hello", { mode: "write", model: "m-x" });
    await waitJob(job.id, 20_000);
    expect(readResult(job.id).text).toContain("--model m-x --sandbox workspace-write");
  }, 30_000);

  it("resumes the prior session when continuing a job", async () => {
    const first = start("hello");
    await waitJob(first.id, 20_000);
    const next = start("again", { continueJob: first.id });
    await waitJob(next.id, 20_000);
    expect(readResult(next.id).text).toContain("exec resume t-1 --json");
    expect(getJob(next.id).continuesJob).toBe(first.id);
  }, 40_000);

  it("refuses to continue a job that is still running", async () => {
    const running = start("sleep");
    expect(() => start("x", { continueJob: running.id })).toThrow(/still/);
    await cancelJob(running.id);
  }, 30_000);

  it("reports an error with the provider's stderr when it fails", async () => {
    const job = start("fail");
    const done = await waitJob(job.id, 20_000);
    expect(done.status).toBe("error");
    expect(done.error).toContain("boom");
  }, 30_000);

  it("expires a wait without stopping the job, then cancels it", async () => {
    const job = start("sleep");
    const waiting = await waitJob(job.id, 1_500);
    expect(["queued", "running"]).toContain(waiting.status);
    expect(observeJob(job.id).job.id).toBe(job.id);
    const canceled = await cancelJob(job.id);
    expect(canceled.status).toBe("canceled");
  }, 30_000);

  it("ends a job at its deadline as timeout", async () => {
    const job = start("sleep", { timeoutMinutes: 0.02 });
    const done = await waitJob(job.id, 20_000);
    expect(done.status).toBe("timeout");
    expect(done.error).toMatch(/deadline/);
  }, 30_000);

  it("marks a job whose worker died as an error", async () => {
    const job = start("hello");
    await waitJob(job.id, 20_000);
    // Simulate a crash: running, with a pid that no longer exists, created long ago.
    updateJob(job.id, {
      status: "running",
      workerPid: 2 ** 22 - 1,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(getJob(job.id).status).toBe("error");
  }, 30_000);

  it("lists jobs newest first and filters by directory", async () => {
    const jobs = listJobs({ cwd: home });
    expect(jobs.length).toBeGreaterThan(3);
    expect(jobs[0]!.createdAt >= jobs[1]!.createdAt).toBe(true);
    expect(listJobs({ cwd: "/nowhere" })).toEqual([]);
  });

  it("rejects ids that could escape the state directory", () => {
    expect(() => getJob("../../etc")).toThrow(/Invalid job id/);
  });
});
