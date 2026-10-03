import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelJob, childJobs, getJob, readResult, startJob, waitJob } from "../src/jobs/api.js";
import { parseVerdict } from "../src/jobs/crossreview.js";
import { readEvents } from "../src/jobs/events.js";
import { renderList } from "../src/jobs/render.js";
import { readJob, type Job } from "../src/jobs/store.js";

// A stand-in for the codex CLI (the implementer). It echoes its whole prompt and arguments into the
// agent message, so the task text travels to the reviewer through the review `context`.
const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const emit = (e) => console.log(JSON.stringify(e));
if (prompt.includes("FAIL-IMPLEMENT")) { console.error("implementer boom"); process.exit(1); }
if (prompt.includes("QUOTA-IMPLEMENT")) { console.error("You've hit your usage limit. Try again at 6pm."); process.exit(1); }
emit({ type: "thread.started", thread_id: "t-impl" });
if (prompt.includes("SLEEP-IMPLEMENT")) setInterval(() => {}, 1000);
else {
  const env = " depth=" + process.env.AGENTMATE_DEPTH + " parentMode=" + process.env.AGENTMATE_PARENT_MODE;
  emit({ type: "item.completed", item: { id: "i", type: "agent_message", text: "IMPL args=" + args.slice(0, -1).join(" ") + env + "\\n" + prompt } });
}
`;

// A stand-in for the claude CLI (the reviewer). The whole prompt selects the verdict.
const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
if (prompt.includes("FAIL-REVIEW")) { console.error("reviewer boom"); process.exit(1); }
if (prompt.includes("QUOTA-REVIEW")) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached|1759500000", session_id: "s-q" }));
  process.exit(1);
}
let verdict = null;
if (prompt.includes("NO-VERDICT")) verdict = null;
else if (prompt.includes("ALWAYS-REQUEST")) verdict = "request-changes";
else if (prompt.includes("FIXED-NOW")) verdict = "approve";
else if (prompt.includes("REQUEST-ONCE")) verdict = "request-changes";
else if (prompt.includes("ROUND1-APPROVE")) verdict = "approve";
let text = "Findings: src/a.ts:1 needs work.\\n";
if (verdict === "request-changes") text += "Please fix src/a.ts and say FIXED-NOW.\\n";
text += verdict ? "Verdict: " + verdict : "I could not decide.";
console.log(JSON.stringify({ type: "result", result: text, session_id: "s-1" }));
`;

// A stand-in for the gemini CLI (stream-json). It echoes its prompt as the answer, so a reviewer's
// briefing can be inspected; the prompt selects the verdict like the claude stand-in does.
const FAKE_GEMINI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const emit = (e) => console.log(JSON.stringify(e));
emit({ type: "init", session_id: "gem-1" });
const review = prompt.includes("Review the following change");
let text = review ? "Looks fine.\\nVerdict: approve" : "GEMINI-IMPL args=" + args.slice(2).join(" ") + "\\n" + prompt;
emit({ type: "message", role: "assistant", content: text, delta: true });
emit({ type: "result", status: "success" });
`;

let home: string;
const saved = { ...process.env };

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-crossreview-"));
  const codex = path.join(home, "fake-codex");
  const claude = path.join(home, "fake-claude");
  fs.writeFileSync(codex, FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(home, "fake-gemini"), FAKE_GEMINI, { mode: 0o755 });
  process.env["AGENTMATE_HOME"] = path.join(home, "state");
  process.env["AGENTMATE_CODEX_BIN"] = codex;
  process.env["AGENTMATE_CLAUDE_BIN"] = claude;
  process.env["AGENTMATE_GEMINI_BIN"] = path.join(home, "fake-gemini");
  process.env["AGENTMATE_CLI"] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  delete process.env["AGENTMATE_DEPTH"];
  delete process.env["AGENTMATE_JOB_ID"];
  delete process.env["AGENTMATE_PARENT_MODE"];
});

afterAll(() => {
  process.env = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

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

const startCrossreview = (task: string, extra: Partial<Parameters<typeof startJob>[0]> = {}) =>
  startJob({ provider: "codex", role: "crossreview", prompt: task, cwd: home, ...extra });

async function runCrossreview(
  task: string,
  extra: Partial<Parameters<typeof startJob>[0]> = {},
): Promise<{ job: Job; report: string; children: Job[] }> {
  const started = startCrossreview(task, extra);
  const job = await waitJob(started.id, 80_000);
  return { job, report: readResult(started.id).text ?? "", children: childJobs(started.id) };
}

/** True while the process exists (a signal-0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until the process is gone; a worker writes its final status just before it exits. */
async function pidGone(pid: number, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; pidAlive(pid) && Date.now() < end; )
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !pidAlive(pid);
}

const eventTexts = (id: string) => readEvents(id).map((event) => event.text);

describe("parseVerdict", () => {
  it("reads the last verdict line in its accepted spellings", () => {
    expect(parseVerdict("ok\nVerdict: approve")).toBe("approve");
    expect(parseVerdict("**Verdict:** request-changes\n")).toBe("request-changes");
    expect(parseVerdict("  verdict: APPROVE.")).toBe("approve");
    expect(parseVerdict("**Verdict: approve**")).toBe("approve");
    expect(parseVerdict("Verdict: request-changes\nmore\nVerdict: approve")).toBe("approve");
  });

  it("reports none when there is no clear verdict line", () => {
    expect(parseVerdict("")).toBe("none");
    expect(parseVerdict("I would approve this")).toBe("none");
    expect(parseVerdict("3. **Verdict** - approve")).toBe("none");
    expect(parseVerdict("Verdict: maybe")).toBe("none");
    expect(parseVerdict("Verdict: approve-with-nits")).toBe("none");
  });
});

describe("crossreview start rules", () => {
  it("is a write workflow job that records its settings and the rendered task", () => {
    const job = startCrossreview("add a flag", { maxRounds: 3 });
    expect(job.role).toBe("crossreview");
    expect(job.mode).toBe("write");
    expect(job.depth).toBe(0);
    expect(job.workflow).toEqual({ maxRounds: 3, rounds: [] });
    expect(job.fields).toMatchObject({ task: "add a flag" });
    expect(job.prompt).toContain("add a flag");
    expect(startCrossreview("x").workflow?.maxRounds).toBe(2);
  });

  it("resolves the default reviewer up front and stores it on the job", () => {
    expect(startCrossreview("x").partner).toBe("claude");
    expect(startCrossreview("x", { partner: "gemini" }).partner).toBe("gemini");
    // codex is the only other installed agent for claude here, and claude for codex: gemini is skipped
    expect(startCrossreview("x", { provider: "claude" }).partner).toBe("codex");
    withEnv(
      {
        AGENTMATE_CLAUDE_BIN: path.join(home, "missing"),
        AGENTMATE_GEMINI_BIN: path.join(home, "missing"),
      },
      () => {
        expect(() => startCrossreview("x")).toThrow(/Agent claude is not installed/);
      },
    );
    withEnv({ AGENTMATE_CLAUDE_BIN: path.join(home, "missing") }, () => {
      // claude is gone: gemini becomes the reviewer of codex
      expect(startCrossreview("x").partner).toBe("gemini");
    });
  });

  it("refuses a crossreview below the top level, like a team lead", () => {
    withEnv({ AGENTMATE_DEPTH: "1", AGENTMATE_JOB_ID: "x" }, () => {
      expect(() => startCrossreview("x")).toThrow(
        "Only a top-level session can start a crossreview job.",
      );
    });
  });

  it("refuses read-only mode, a missing task, bad round counts and rounds on other roles", () => {
    expect(() => startCrossreview("x", { mode: "read-only" })).toThrow(
      "Role crossreview needs mode write.",
    );
    expect(() => startJob({ provider: "codex", role: "crossreview", cwd: home })).toThrow(/task/);
    for (const maxRounds of [0, 6, 1.5, Number.NaN])
      expect(() => startCrossreview("x", { maxRounds })).toThrow(/maxRounds/);
    expect(() => startJob({ provider: "codex", role: "ask", prompt: "q", maxRounds: 2 })).toThrow(
      /only to the crossreview role/,
    );
    expect(() => startCrossreview("x", { continueJob: "nope" })).toThrow(/cannot continue/i);
  });
});

describe("crossreview workflow", () => {
  it("ends in one round when the reviewer approves", async () => {
    const { job, report, children } = await runCrossreview("ship it ROUND1-APPROVE", {
      fields: { acceptance: "tests pass" },
    });
    expect(job.status).toBe("done");
    expect(job.workflow?.rounds).toHaveLength(1);
    expect(job.workflow?.rounds[0]).toMatchObject({ verdict: "approve" });

    expect(children.map((c) => c.role)).toEqual(["implement", "review"]);
    expect(children.map((c) => c.provider)).toEqual(["codex", "claude"]);
    expect(children.map((c) => c.mode)).toEqual(["write", "read-only"]);
    expect(children.every((c) => c.parentJob === job.id && c.depth === 1)).toBe(true);
    expect(children.every((c) => c.cwd === home && c.status === "done")).toBe(true);
    expect(job.workflow?.rounds[0]).toMatchObject({
      implementJob: children[0]!.id,
      reviewJob: children[1]!.id,
    });
    // acceptance reaches the implementer; the review sees the diff target, the task and the report
    expect(children[0]!.prompt).toContain("tests pass");
    expect(children[1]!.prompt).toContain("git diff");
    expect(children[1]!.prompt).toContain("git status");
    expect(children[1]!.prompt).toContain("ship it ROUND1-APPROVE");
    expect(children[1]!.prompt).toContain("IMPL args=");
    expect(children[1]!.prompt).toContain("depth=2");

    for (const section of [
      "## Task",
      "## Rounds",
      "## Final review",
      "## Changes",
      "## Next steps",
    ])
      expect(report).toContain(section);
    expect(report).not.toContain("## Needs human");
    expect(report).toContain("ship it ROUND1-APPROVE");
    expect(report).toMatch(/\| 1 \| `[a-z0-9-]+` \| `[a-z0-9-]+` \| approve \|/);
    expect(report).toContain(`jobs result ${children[0]!.id}`);
    expect(report).toContain(`jobs result ${children[1]!.id}`);
    expect(report).toContain("Verdict: approve");

    const texts = eventTexts(job.id);
    expect(texts).toContain(`round 1: implement started ${children[0]!.id}`);
    expect(texts).toContain(`round 1: review started ${children[1]!.id}`);
    expect(texts).toContain("round 1: review verdict approve");
    const events = readEvents(job.id);
    expect(events.every((e) => e.job === job.id && e.level === "important")).toBe(true);
    expect(events.at(-1)?.kind).toBe("finished");
    expect(renderList([job, ...children])).toContain("crossreview");
  }, 100_000);

  it("revises after request-changes by continuing the implementer's session", async () => {
    const { job, report, children } = await runCrossreview("tidy it REQUEST-ONCE");
    expect(job.status).toBe("done");
    expect(job.workflow?.rounds.map((r) => r.verdict)).toEqual(["request-changes", "approve"]);
    expect(children.map((c) => c.role)).toEqual(["implement", "review", "implement", "review"]);

    const [firstImplement, , secondImplement] = children;
    expect(firstImplement!.continuesJob).toBeUndefined();
    expect(secondImplement!.continuesJob).toBe(firstImplement!.id);
    expect(secondImplement!.mode).toBe("write");
    expect(secondImplement!.prompt).toContain(
      "Address these review findings, then summarize what changed",
    );
    expect(secondImplement!.prompt).toContain("Please fix src/a.ts");
    const secondText = readResult(secondImplement!.id).text ?? "";
    expect(secondText).toContain("exec resume t-impl");

    expect(report).toMatch(/\| 1 \|.*\| request-changes \|/);
    expect(report).toMatch(/\| 2 \|.*\| approve \|/);
    const texts = eventTexts(job.id);
    expect(texts).toContain("round 1: review verdict request-changes");
    expect(texts).toContain("round 2: review verdict approve");
    expect(texts.some((t) => t.startsWith("round 2: implement started"))).toBe(true);
  }, 100_000);

  it("stops with the round budget exhausted when changes are still requested", async () => {
    const { job, report, children } = await runCrossreview("never good ALWAYS-REQUEST", {
      maxRounds: 2,
    });
    expect(job.status).toBe("done");
    expect(job.workflow?.rounds.map((r) => r.verdict)).toEqual([
      "request-changes",
      "request-changes",
    ]);
    expect(children).toHaveLength(4);
    expect(report).toMatch(/round budget exhausted/i);
    expect(report).toContain("## Final review");
  }, 100_000);

  it("stops at once for a human when the reviewer gives no verdict", async () => {
    const { job, report, children } = await runCrossreview("vague NO-VERDICT");
    expect(job.status).toBe("done");
    expect(job.workflow?.rounds).toHaveLength(1);
    expect(job.workflow?.rounds[0]?.verdict).toBe("none");
    expect(children).toHaveLength(2); // no second round
    expect(report).toContain("## Needs human");
    expect(report).toMatch(/no (clear )?verdict/i);
    expect(eventTexts(job.id).some((t) => t.startsWith("round 1: review verdict none"))).toBe(true);
  }, 100_000);

  it("fails the workflow with the child's id and error when the implementer fails", async () => {
    const { job, report, children } = await runCrossreview("broken FAIL-IMPLEMENT");
    expect(job.status).toBe("error");
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe("error");
    expect(job.error).toContain(children[0]!.id);
    expect(job.error).toContain("implementer boom");
    expect(report).toContain(children[0]!.id);
    expect(report).toContain("implementer boom");
    expect(report).toContain("## Rounds");
    expect(eventTexts(job.id).some((t) => t.includes("implementer boom"))).toBe(true);
  }, 100_000);

  it("fails the workflow when the reviewer fails, keeping the round", async () => {
    const { job, children } = await runCrossreview("broken FAIL-REVIEW");
    expect(job.status).toBe("error");
    expect(children.map((c) => c.status)).toEqual(["done", "error"]);
    expect(job.error).toContain(children[1]!.id);
    expect(job.error).toContain("reviewer boom");
    expect(job.workflow?.rounds).toEqual([
      { implementJob: children[0]!.id, reviewJob: children[1]!.id, verdict: "none" },
    ]);
  }, 100_000);

  it("ends in error with the child's hand-off hint when the implementer hits its quota", async () => {
    const { job, report, children } = await runCrossreview("work QUOTA-IMPLEMENT");
    expect(job.status).toBe("error");
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe("quota_exhausted");
    expect(job.error).toBe(children[0]!.error);
    expect(job.error).toContain("codex quota exhausted");
    expect(job.error).toContain("start the job on claude.");
    expect(report).toContain(`round 1: implement (job ${children[0]!.id}) hit the codex quota`);
  }, 100_000);

  it("ends in error when the reviewer hits its quota, keeping the round", async () => {
    const { job, report, children } = await runCrossreview("work QUOTA-REVIEW");
    expect(job.status).toBe("error");
    expect(children.map((c) => c.status)).toEqual(["done", "quota_exhausted"]);
    expect(job.error).toBe(children[1]!.error);
    expect(job.error).toContain("claude quota exhausted: Claude usage limit reached|1759500000");
    expect(job.error).toContain("start the job on codex.");
    expect(report).toContain("round 1: review");
    expect(report).toContain("hit the claude quota");
    expect(job.workflow?.rounds).toHaveLength(1);
  }, 100_000);

  it("gives a gemini reviewer the diff inline, since it cannot run git", async () => {
    const repo = path.join(home, "repo-inline");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 2; // changed\n");
    fs.writeFileSync(path.join(repo, "new-file.ts"), "x\n");

    const { job, children } = await runCrossreview("tweak a ROUND1-APPROVE", {
      partner: "gemini",
      cwd: repo,
    });
    expect(job.status).toBe("done");
    expect(job.partner).toBe("gemini");
    const review = children.find((c) => c.role === "review")!;
    expect(review.provider).toBe("gemini");
    expect(review.prompt).toContain("may not run shell commands");
    expect(review.prompt).toContain("+export const a = 2; // changed");
    expect(review.prompt).toContain("Untracked files (not in the diff): new-file.ts");
    expect(review.prompt).toContain("You cannot run shell commands");
    expect(review.prompt).not.toContain("plus `git status` for untracked files");
    // the claude reviewer keeps the git instructions
    const plain = await runCrossreview("tweak a ROUND1-APPROVE", { cwd: repo });
    expect(plain.children.find((c) => c.role === "review")!.prompt).toContain(
      "plus `git status` for untracked files",
    );
    expect(plain.children.find((c) => c.role === "review")!.prompt).not.toContain(
      "may not run shell commands",
    );
  }, 100_000);

  it("starts a fresh implement job for round 2 when the implementer cannot resume", async () => {
    const { job, children } = await runCrossreview("tidy it REQUEST-ONCE", {
      provider: "gemini",
      partner: "claude",
    });
    expect(job.status).toBe("done");
    expect(children.map((c) => `${c.role}:${c.provider}`)).toEqual([
      "implement:gemini",
      "review:claude",
      "implement:gemini",
      "review:claude",
    ]);
    const secondImplement = children[2]!;
    expect(secondImplement.continuesJob).toBeUndefined();
    expect(secondImplement.prompt).toContain("tidy it REQUEST-ONCE");
    expect(secondImplement.prompt).toContain("A previous attempt is already in the working tree");
    expect(secondImplement.prompt).toContain("Please fix src/a.ts");
    expect(readResult(secondImplement.id).text).not.toContain("--resume");
  }, 100_000);

  it("cancels its running child when the workflow is canceled", async () => {
    const started = startCrossreview("long SLEEP-IMPLEMENT");
    let child: Job | undefined;
    for (let i = 0; i < 200 && !child; i++) {
      child = childJobs(started.id)[0];
      if (!child) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(child).toBeDefined();
    // let the implementer's worker actually start
    for (let i = 0; i < 100 && getJob(child!.id).status !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 200));

    const childPid = getJob(child!.id).workerPid;
    expect(childPid).toBeDefined();
    expect(pidAlive(childPid!)).toBe(true);

    const canceled = await cancelJob(started.id);
    expect(canceled.id).toBe(started.id);
    expect(canceled.status).toBe("canceled");
    expect(getJob(child!.id).status).toBe("canceled");
    expect(await pidGone(childPid!)).toBe(true);
    expect(readResult(started.id).text).toContain("## Rounds");
    expect(readJob(started.id)?.cancelRequested).toBe(true);
  }, 100_000);

  it("treats a child canceled on its own as a failure, not as a canceled workflow", async () => {
    const started = startCrossreview("long SLEEP-IMPLEMENT");
    let child: Job | undefined;
    for (let i = 0; i < 200 && !child; i++) {
      child = childJobs(started.id)[0];
      if (!child) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (let i = 0; i < 100 && getJob(child!.id).status !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 200));

    await cancelJob(child!.id); // only the child; the workflow was not asked to cancel
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("error");
    expect(done.cancelRequested).toBeUndefined();
    expect(done.error).toContain(`job ${child!.id} ended canceled`);
  }, 100_000);

  it("cancels the child first, so a workflow worker killed with SIGKILL leaves no orphan", async () => {
    const started = startCrossreview("long SLEEP-IMPLEMENT");
    let child: Job | undefined;
    for (let i = 0; i < 200 && !child; i++) {
      child = childJobs(started.id)[0];
      if (!child) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (let i = 0; i < 100 && getJob(child!.id).status !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 200));
    const childPid = getJob(child!.id).workerPid!;
    const workflowPid = getJob(started.id).workerPid!;

    process.kill(-workflowPid, "SIGKILL"); // the workflow's worker is gone; its child is still running
    expect(pidAlive(childPid)).toBe(true);

    const canceled = await cancelJob(started.id);
    expect(canceled.status).toBe("canceled");
    expect(getJob(child!.id).status).toBe("canceled");
    expect(await pidGone(childPid)).toBe(true);
  }, 100_000);

  it("ends as timeout at its own deadline and cancels the running child", async () => {
    const { job, children } = await runCrossreview("long SLEEP-IMPLEMENT", {
      timeoutMinutes: 0.1,
    });
    expect(job.status).toBe("timeout");
    expect(job.error).toMatch(/deadline/);
    expect(children).toHaveLength(1);
    expect(["canceled", "timeout"]).toContain(children[0]!.status);
    expect(readJob(job.id)?.finishedAt).toBeDefined();
  }, 100_000);
});
