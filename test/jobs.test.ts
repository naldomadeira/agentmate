import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  askJob,
  cancelJob,
  childJobs,
  getJob,
  listJobs,
  observeJob,
  readResult,
  startJob,
  waitJob,
} from "../src/jobs/api.js";
import { buildInvocation } from "../src/jobs/providers.js";
import { updateJob, type Job } from "../src/jobs/store.js";

// A stand-in for the codex CLI. The prompt (last argument) selects the behavior.
const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const emit = (e) => console.log(JSON.stringify(e));
if (prompt === "sleep") { emit({ type: "thread.started", thread_id: "t-sleep" }); setInterval(() => {}, 1000); }
else if (prompt === "fail") { console.error("boom"); process.exit(1); }
else {
  emit({ type: "thread.started", thread_id: "t-1" });
  const env = " depth=" + process.env.AGENTS_BRIDGE_DEPTH + " job=" + process.env.AGENTS_BRIDGE_JOB_ID;
  emit({ type: "item.completed", item: { id: "i", type: "agent_message", text: "args=" + args.join(" ") + env } });
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

/** Sets env vars for the duration of `fn`, then restores them. */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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
    expect(text).toContain("exec --json --skip-git-repo-check --sandbox read-only hello");
  }, 30_000);

  it("maps write mode and model onto the provider flags", async () => {
    const job = start("hello", { mode: "write", model: "m-x" });
    await waitJob(job.id, 20_000);
    expect(readResult(job.id).text).toContain("--model m-x --sandbox workspace-write");
  }, 30_000);

  it("maps roles onto sandbox and records role, depth and rendered prompt", async () => {
    const review = start("src/a.ts", { role: "review", fields: { focus: "races" } });
    expect(review.role).toBe("review");
    expect(review.depth).toBe(0);
    expect(review.parentJob).toBeUndefined();
    expect(review.prompt).toContain("src/a.ts");
    expect(review.prompt).toContain("races");
    await waitJob(review.id, 20_000);
    expect(readResult(review.id).text).toContain("--sandbox read-only");

    const lead = start("", {
      role: "teamlead",
      fields: { objective: "ship the thing" },
      mode: "write",
    });
    await waitJob(lead.id, 20_000);
    expect(readResult(lead.id).text).toContain("--sandbox danger-full-access");
    expect(lead.prompt).toContain("ship the thing");
    expect(lead.prompt).toContain("claude"); // other provider
  }, 40_000);

  it("keeps role custom for raw prompts and requires a prompt or fields otherwise", () => {
    expect(start("hello").role).toBe("custom");
    expect(() => startJob({ provider: "codex", cwd: home, role: "ask" })).toThrow(/question/);
    expect(() => startJob({ provider: "codex", cwd: home })).toThrow(/prompt/);
  });

  it("uses the prompt as the primary field of a role when no fields are given", () => {
    const job = start("what is X?", { role: "ask" });
    expect(job.prompt).toContain("what is X?");
    expect(job.prompt).not.toBe("what is X?");
  });

  it("hands depth and job id to the worker environment", async () => {
    const job = start("env");
    await waitJob(job.id, 20_000);
    expect(readResult(job.id).text).toContain(`depth=1 job=${job.id}`);
  }, 30_000);

  it("links jobs started from a worker to their parent and lists children", async () => {
    const parent = start("hello");
    withEnv({ AGENTS_BRIDGE_DEPTH: "1", AGENTS_BRIDGE_JOB_ID: parent.id }, () => {
      const child = start("hello");
      expect(child.depth).toBe(1);
      expect(child.parentJob).toBe(parent.id);
    });
    await waitJob(parent.id, 20_000);
    expect(childJobs(parent.id)).toHaveLength(1);
    expect(listJobs({ parent: parent.id })).toHaveLength(1);
    expect(listJobs({ parent: "nope" })).toEqual([]);
    const observed = observeJob(parent.id);
    expect(observed.children.map((c) => c.parentJob)).toEqual([parent.id]);
    await waitJob(observed.children[0]!.id, 20_000);
  }, 40_000);

  it("refuses to start at the delegation depth limit", () => {
    withEnv({ AGENTS_BRIDGE_DEPTH: "2" }, () => {
      expect(() => start("hello")).toThrow(/Delegation depth limit reached/);
    });
  });

  it("refuses a teamlead below the top level", () => {
    withEnv({ AGENTS_BRIDGE_DEPTH: "1", AGENTS_BRIDGE_JOB_ID: "x" }, () => {
      expect(() => start("", { role: "teamlead", fields: { objective: "o" } })).toThrow(
        /Only a top-level session can start a teamlead job/,
      );
    });
  });

  it("answers a question synchronously with askJob", async () => {
    const { job, text } = await askJob(
      { provider: "codex", role: "ask", fields: { question: "why?" }, cwd: home },
      20_000,
    );
    expect(job.status).toBe("done");
    expect(job.role).toBe("ask");
    expect(text).toContain("args=exec");
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

describe("provider flags", () => {
  const job = (extra: Partial<Job>): Job => ({
    id: "j",
    provider: "claude",
    mode: "read-only",
    role: "custom",
    depth: 0,
    prompt: "p",
    cwd: "/",
    timeoutMs: 1,
    status: "queued",
    createdAt: "",
    ...extra,
  });
  const tools = (args: string[]) => args.filter((_, i) => args[i - 1] === "--allowedTools");

  it("limits read-only claude to inspection tools, plus web for research", () => {
    const base = tools(buildInvocation(job({})).args);
    expect(base).toContain("Bash(git status *)");
    expect(base).not.toContain("WebSearch");
    const research = tools(buildInvocation(job({ role: "research" })).args);
    expect(research).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
  });

  it("lets a claude team lead run the bridge CLI, in either mode", () => {
    const patterns = [
      "Bash(npx -y agents-bridge-mcp *)",
      "Bash(npx agents-bridge-mcp *)",
      "Bash(agents-bridge-mcp *)",
    ];
    const readOnly = buildInvocation(job({ role: "teamlead" })).args;
    expect(tools(readOnly)).toEqual(expect.arrayContaining(patterns));
    const write = buildInvocation(job({ role: "teamlead", mode: "write" })).args;
    expect(write).toContain("acceptEdits");
    expect(tools(write)).toEqual(patterns);
    expect(tools(buildInvocation(job({ mode: "write" })).args)).toEqual([]);
  });

  it("does not pass --skip-git-repo-check or --sandbox when resuming codex", () => {
    const { args } = buildInvocation(job({ provider: "codex" }), "t-9");
    expect(args).not.toContain("--skip-git-repo-check");
    expect(args).not.toContain("--sandbox");
  });
});
