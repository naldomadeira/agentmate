import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelJob, childJobs, getJob, readResult, startJob, waitJob } from "../src/jobs/api.js";
import { readEvents } from "../src/jobs/events.js";
import { parseSplitPlan } from "../src/jobs/split.js";
import {
  appendNotes,
  createSession,
  getSession,
  readNotes,
  sessionJobs,
} from "../src/jobs/sessions.js";
import { homeDir, readJob, type Job } from "../src/jobs/store.js";
import { buildSplitPlanPrompt } from "../src/lib/prompt-builder.js";

// One script plays both agents. The prompt (last argument) selects the behavior:
//  - the split planner answers with a parts block chosen by a marker in the goal
//  - reviewers answer with a verdict chosen by a marker carried in the part briefing
//  - parts echo where they ran; implementers also write a file in their cwd
const fakeAgent = (agent: "codex" | "claude") => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const agent = ${JSON.stringify(agent)};
const reply = (text) => {
  if (agent === "codex") {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } }));
  } else console.log(JSON.stringify({ type: "result", result: text, session_id: "s-1" }));
};
const isPlan = prompt.includes("Split the goal below");
const isReview = prompt.includes("Review the following change");
if (isPlan && prompt.includes("SLEEP-PLAN")) { setInterval(() => {}, 1000); return; }
if (!isPlan && !isReview && prompt.includes("FAIL-PART")) { console.error("part boom"); process.exit(1); }
if (!isPlan && !isReview && prompt.includes("QUOTA-PART")) { console.error("You've hit your usage limit. Try again at 6pm."); process.exit(1); }
if (isPlan && prompt.includes("QUOTA-PLAN")) { console.error("You've hit your usage limit. Try again at 6pm."); process.exit(1); }
if (!isPlan && !isReview && prompt.includes("SLEEP-PART")) { setInterval(() => {}, 1000); return; }

if (isPlan) {
  const goal = prompt;
  const block = (parts) => "Here is the split.\\n\`\`\`json\\n{ \\"parts\\": [] }\\n\`\`\`\\nFinal answer:\\n\`\`\`json\\n" + JSON.stringify({ parts }) + "\\n\`\`\`\\n";
  if (goal.includes("PLAN-BAD")) reply("I would split it in two.\\n\`\`\`json\\n{ not valid json\\n\`\`\`");
  else if (goal.includes("PLAN-NOAGENT")) reply(block([
    { id: "a", title: "Part A", briefing: "Do A", files: ["src/a.ts"] },
    { id: "b", title: "Part B", briefing: "Do B", files: ["src/b.ts"], agent: "gemini" },
  ]));
  else if (goal.includes("PLAN-2")) reply(block([
    { id: "a", title: "Part A", briefing: "Do A in src/a.ts." + (goal.includes("MARK-A-NOVERDICT") ? " NO-VERDICT" : "") + (goal.includes("MARK-A-SWITCH") ? " SWITCH-BRANCH" : ""), files: ["src/a.ts"], agent: "codex" },
    { id: "b", title: "Part B", briefing: "Do B in src/b.ts." + (goal.includes("MARK-B-FAIL") ? " FAIL-PART" : "") + (goal.includes("MARK-B-QUOTA") ? " QUOTA-PART" : "") + (goal.includes("MARK-B-REQUEST") ? " ALWAYS-REQUEST" : "") + (goal.includes("MARK-B-LOCK") ? " LOCK-INDEX" : "") + (goal.includes("MARK-B-SLEEP") ? " SLEEP-PART" : ""), files: ["src/b.ts"], agent: "claude" },
  ]));
  else reply("no parts");
} else if (isReview) {
  let verdict = "approve";
  if (prompt.includes("NO-VERDICT")) verdict = null;
  else if (prompt.includes("ALWAYS-REQUEST")) verdict = "request-changes";
  reply("Reviewed in " + process.cwd() + "\\n" + (verdict ? "Verdict: " + verdict : "I could not decide."));
} else {
  const implement = prompt.includes("Implement the following task");
  if (implement && prompt.includes("SWITCH-BRANCH")) require("node:child_process").execFileSync("git", ["checkout", "-q", "-b", "rogue"]);
  if (implement && prompt.includes("LOCK-INDEX")) {
    const gitdir = fs.readFileSync(".git", "utf8").replace("gitdir:", "").trim();
    fs.writeFileSync(path.join(gitdir, "index.lock"), "");
  }
  if (implement) fs.writeFileSync(path.join(process.cwd(), "part-" + path.basename(process.cwd()) + ".txt"), "work\\n");
  reply((implement ? "IMPL" : "RESEARCH") + " by " + agent + " cwd=" + process.cwd() + "\\n" + prompt);
}
`;

let home: string;
let repo: string;
const saved = { ...process.env };

/** A fixed identity, so commits and merges work on machines (CI) without a git user configured. */
const gitIdentity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ...gitIdentity };
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  run("init", "-q");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
}

let repoCount = 0;
/** A new repository with one commit, so write-mode tests do not see each other's merges. */
function freshRepo(): string {
  const dir = path.join(home, `repo-${++repoCount}`);
  makeRepo(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...gitIdentity },
  }).trim();

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-split-"));
  const codex = path.join(home, "fake-codex");
  const claude = path.join(home, "fake-claude");
  fs.writeFileSync(codex, fakeAgent("codex"), { mode: 0o755 });
  fs.writeFileSync(claude, fakeAgent("claude"), { mode: 0o755 });
  repo = path.join(home, "repo");
  makeRepo(repo);
  process.env["AGENTMATE_HOME"] = path.join(home, "state");
  process.env["AGENTMATE_CODEX_BIN"] = codex;
  process.env["AGENTMATE_CLAUDE_BIN"] = claude;
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

const startSplit = (goal: string, extra: Partial<Parameters<typeof startJob>[0]> = {}) =>
  startJob({ provider: "codex", role: "split", prompt: goal, cwd: home, ...extra });

async function runSplit(
  goal: string,
  extra: Partial<Parameters<typeof startJob>[0]> = {},
): Promise<{ job: Job; report: string; children: Job[] }> {
  const started = startSplit(goal, extra);
  const job = await waitJob(started.id, 90_000);
  return { job, report: readResult(started.id).text ?? "", children: childJobs(started.id) };
}

const eventTexts = (id: string) => readEvents(id).map((event) => event.text);
const byRole = (children: Job[], role: string) => children.filter((c) => c.role === role);

describe("buildSplitPlanPrompt", () => {
  it("asks for independent parts, closed interfaces, no shared files and one json block", () => {
    const prompt = buildSplitPlanPrompt({
      goal: "Add export",
      acceptance: "tests pass",
      maxParts: 3,
      agents: ["codex", "claude"],
    });
    expect(prompt).toContain("Goal: Add export");
    expect(prompt).toContain("tests pass");
    expect(prompt).toContain("between 1 and 3 parts");
    expect(prompt).toMatch(/No overlapping files/);
    expect(prompt).toMatch(/interfaces/i);
    expect(prompt).toContain("codex, claude");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"parts"');
    expect(prompt).toContain("Do not modify any files");
  });
});

describe("parseSplitPlan", () => {
  const block = (value: unknown) => `text\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
  const part = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Part ${id}`,
    briefing: `Do ${id}`,
    files: [`${id}.ts`],
    ...extra,
  });
  const parse = (text: string, maxParts = 3) =>
    parseSplitPlan(text, { maxParts, planner: "codex" });

  it("reads the last json block", () => {
    const text = `${block({ parts: [part("old", { agent: "codex" })] })}${block({ parts: [part("a", { agent: "claude" }), part("b", { agent: "codex" })] })}`;
    const plan = parse(text);
    expect(plan.ok).toBe(true);
    if (plan.ok)
      expect(plan.parts.map((p) => [p.id, p.agent, p.files])).toEqual([
        ["a", "claude", ["a.ts"]],
        ["b", "codex", ["b.ts"]],
      ]);
  });

  it("alternates agents for missing or unknown ones, starting with the other agent", () => {
    const plan = parse(
      block({
        parts: [
          part("a"),
          part("b", { agent: "gemini" }),
          part("c", { agent: "codex" }),
          part("d"),
        ],
      }),
      4,
    );
    expect(plan.ok && plan.parts.map((p) => p.agent)).toEqual([
      "claude",
      "codex",
      "codex",
      "claude",
    ]);
  });

  it.each([
    ["no block", "just prose"],
    ["unparsable json", "```json\n{ nope\n```"],
    ["no parts array", block({ parts: "x" })],
    ["empty parts", block({ parts: [] })],
    ["too many parts", block({ parts: [part("a"), part("b"), part("c"), part("d")] })],
    ["duplicate ids", block({ parts: [part("a"), part("a")] })],
    ["bad id", block({ parts: [part("Bad Id")] })],
    ["no briefing", block({ parts: [{ id: "a", title: "A" }] })],
  ])("rejects %s", (_name, text) => {
    expect(parse(text).ok).toBe(false);
  });

  it("defaults a missing title to the id and ignores non-string files", () => {
    const plan = parse(block({ parts: [{ id: "a", briefing: "x", files: ["ok.ts", 3] }] }));
    expect(plan.ok && plan.parts[0]).toMatchObject({ title: "a", files: ["ok.ts"] });
  });
});

describe("split start rules", () => {
  it("is a read-only workflow job that records its settings and the rendered goal", () => {
    const job = startSplit("break it up", { maxParts: 4, fields: { acceptance: "green" } });
    expect(job.role).toBe("split");
    expect(job.mode).toBe("read-only");
    expect(job.depth).toBe(0);
    expect(job.split).toEqual({ maxParts: 4, parts: [] });
    expect(job.fields).toMatchObject({ goal: "break it up", acceptance: "green" });
    expect(job.prompt).toContain("break it up");
    expect(job.prompt).toContain("green");
    expect(startSplit("x").split?.maxParts).toBe(3);
    expect(startSplit("x", { mode: "write" }).mode).toBe("write");
  });

  it("refuses a split below the top level, like a team lead", () => {
    withEnv({ AGENTMATE_DEPTH: "1", AGENTMATE_JOB_ID: "x" }, () => {
      expect(() => startSplit("x")).toThrow("Only a top-level session can start a split job.");
    });
  });

  it("validates maxParts, the goal and continue", () => {
    for (const maxParts of [0, 1, 5, 2.5, Number.NaN])
      expect(() => startSplit("x", { maxParts })).toThrow(
        /maxParts must be a whole number from 2 to 4/,
      );
    expect(() => startJob({ provider: "codex", role: "ask", prompt: "q", maxParts: 2 })).toThrow(
      /only to the split role/,
    );
    expect(() => startJob({ provider: "codex", role: "split", cwd: home })).toThrow(/goal/);
    expect(() => startSplit("x", { continueJob: "nope" })).toThrow(/cannot continue/i);
  });
});

describe("split workflow, read-only", () => {
  it("plans two parts, researches them in parallel and cross-reviews them in a session", async () => {
    const { job, report, children } = await runSplit("Ship the export PLAN-2", {
      fields: { acceptance: "tests pass" },
    });
    expect(job.status).toBe("done");

    // children: one plan, two research (one per agent), two reviews (the other agent)
    expect(byRole(children, "plan")).toHaveLength(1);
    const research = byRole(children, "research");
    const reviews = byRole(children, "review");
    expect(research.map((c) => c.provider).sort()).toEqual(["claude", "codex"]);
    expect(reviews).toHaveLength(2);
    const [plan] = byRole(children, "plan");
    expect(plan!.provider).toBe("codex");
    expect(plan!.mode).toBe("read-only");
    expect(plan!.prompt).toContain("Split the goal below");
    expect(plan!.prompt).toContain("tests pass");
    for (const child of children) {
      expect(child.parentJob).toBe(job.id);
      expect(child.depth).toBe(1);
      expect(child.session).toBe(job.session);
      expect(child.status).toBe("done");
    }
    for (const child of [...research, ...reviews]) expect(child.cwd).toBe(home);
    // reviewers are the other agent of the part
    for (const part of job.split!.parts) {
      const ran = children.find((c) => c.id === part.partJob)!;
      const reviewed = children.find((c) => c.id === part.reviewJob)!;
      expect(ran.provider).toBe(part.agent);
      expect(reviewed.provider).not.toBe(part.agent);
      expect(part.planJob).toBe(plan!.id);
      expect(part.verdict).toBe("approve");
    }
    // part briefing: the part, its files, the goal and the session notes with the plan
    const partA = children.find((c) => c.id === job.split!.parts[0]!.partJob)!;
    expect(partA.prompt).toContain("Do A in src/a.ts.");
    expect(partA.prompt).toContain("src/a.ts");
    expect(partA.prompt).toContain("Ship the export PLAN-2");
    expect(partA.prompt).toContain("Shared session notes");
    expect(partA.prompt).toContain("Split plan for");

    // the session was created for the workflow and holds every job and the plan
    expect(job.session).toBeDefined();
    const session = getSession(job.session!);
    expect(session.title).toContain("Ship the export");
    expect(session.cwd).toBe(home);
    expect(sessionJobs(session.id).map((j) => j.id)).toEqual(
      expect.arrayContaining([job.id, ...children.map((c) => c.id)]),
    );
    const notes = readNotes(session.id);
    expect(notes).toMatch(
      /· split\nSplit plan for: Ship the export PLAN-2\n- a \(codex\): Part A \[src\/a\.ts\]\n- b \(claude\): Part B/,
    );
    expect(notes).toMatch(/Split .* done: a approve, b approve/);

    for (const section of ["## Goal", "## Parts", "## Integration", "## Next steps"])
      expect(report).toContain(section);
    expect(report).not.toContain("## Needs human");
    expect(report).toContain("tests pass");
    const [a, b] = job.split!.parts;
    expect(report).toContain(
      `| a | Part A | codex | \`${a!.partJob}\` | \`${a!.reviewJob}\` | approve | - |`,
    );
    expect(report).toContain(
      `| b | Part B | claude | \`${b!.partJob}\` | \`${b!.reviewJob}\` | approve | - |`,
    );
    expect(report).toContain("RESEARCH by codex");
    expect(report).toContain("RESEARCH by claude");
    for (const child of children) expect(report).toContain(`jobs result ${child.id}`);

    const texts = eventTexts(job.id);
    expect(texts).toContain(`plan started ${plan!.id}`);
    expect(texts.some((t) => t.startsWith("plan: 2 part(s): a (codex), b (claude)"))).toBe(true);
    expect(texts).toContain("part a: review verdict approve");
    const events = readEvents(job.id);
    expect(events.every((e) => e.job === job.id && e.level === "important")).toBe(true);
    expect(events.at(-1)?.kind).toBe("finished");
  }, 120_000);

  it("uses the given session and keeps its notes", async () => {
    const session = createSession({ title: "Mine", cwd: home });
    appendNotes(session.id, "Keep the CLI flags stable.", "host");
    const { job, children } = await runSplit("Do it PLAN-2", { sessionId: session.id });
    expect(job.status).toBe("done");
    expect(job.session).toBe(session.id);
    expect(children.every((c) => c.session === session.id)).toBe(true);
    expect(children[0]!.prompt).toContain("Keep the CLI flags stable.");
    expect(readNotes(session.id)).toContain("Keep the CLI flags stable.");
    expect(readNotes(session.id)).toContain("Split plan for: Do it PLAN-2");
  }, 120_000);

  it("assigns agents to a plan that leaves them out", async () => {
    const { job, children } = await runSplit("Do it PLAN-2 PLAN-NOAGENT");
    // PLAN-2 is checked after PLAN-NOAGENT in the fake, so this plan has no valid agents
    expect(job.status).toBe("done");
    expect(job.split!.parts.map((p) => p.agent)).toEqual(["claude", "codex"]);
    expect(byRole(children, "research").map((c) => c.provider)).toEqual(["claude", "codex"]);
  }, 120_000);

  it("lists parts a human has to look at", async () => {
    const { job, report } = await runSplit("Do it PLAN-2 MARK-B-REQUEST MARK-A-NOVERDICT");
    expect(job.status).toBe("done");
    expect(job.split!.parts.map((p) => p.verdict)).toEqual(["none", "request-changes"]);
    expect(report).toContain("## Needs human");
    expect(report).toMatch(/part a: claude gave no clear verdict/);
    expect(report).toMatch(/part b: codex requested changes/);
    expect(report).toMatch(/\| a \|.*\| none \|/);
    expect(report).toMatch(/\| b \|.*\| request-changes \|/);
  }, 120_000);

  it("ends in error when the planner returns no valid parts block", async () => {
    const { job, report, children } = await runSplit("Break PLAN-BAD");
    expect(job.status).toBe("error");
    expect(children).toHaveLength(1);
    expect(job.error).toBe(
      `the planner did not return a valid parts block; run \`jobs result ${children[0]!.id}\``,
    );
    expect(report).toContain("planner did not return a valid parts block");
    expect(report).toContain(`jobs result ${children[0]!.id}`);
    expect(job.split!.parts).toEqual([]);
    expect(readNotes(job.session!)).toMatch(/Split .* error/);
  }, 120_000);

  it("fails naming the part, after the other parts have run to completion", async () => {
    const { job, report, children } = await runSplit("Do it PLAN-2 MARK-B-FAIL");
    expect(job.status).toBe("error");
    const [a, b] = job.split!.parts;
    expect(job.error).toContain("part b failed");
    expect(job.error).toContain(b!.partJob!);
    expect(job.error).toContain("part boom");
    const failed = children.find((c) => c.id === b!.partJob)!;
    expect(failed.status).toBe("error");
    // part a finished and was still reviewed
    expect(children.find((c) => c.id === a!.partJob)!.status).toBe("done");
    expect(children.find((c) => c.id === a!.reviewJob)!.status).toBe("done");
    expect(a!.verdict).toBe("approve");
    expect(b!.reviewJob).toBeUndefined();
    expect(report).toContain("## Needs human");
    expect(report).toMatch(/part b \(claude\) failed/);
    expect(report).toContain("RESEARCH by codex");
  }, 120_000);

  it("ends in error with the child's hand-off hint when a part hits its quota", async () => {
    const { job, report, children } = await runSplit("Do it PLAN-2 MARK-B-QUOTA");
    expect(job.status).toBe("error");
    const [a, b] = job.split!.parts;
    const hit = children.find((c) => c.id === b!.partJob)!;
    expect(hit.status).toBe("quota_exhausted");
    expect(hit.error).toContain("quota exhausted");
    expect(job.error).toBe(hit.error);
    expect(job.error).toContain("start the job on");
    expect(report).toContain(`part b (job ${hit.id}) hit the claude quota`);
    // the other part still ran to completion
    expect(children.find((c) => c.id === a!.partJob)!.status).toBe("done");
  }, 120_000);

  it("ends in error with the planner's hint when the planner hits its quota", async () => {
    const { job, report, children } = await runSplit("Do it PLAN-2 QUOTA-PLAN");
    expect(job.status).toBe("error");
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe("quota_exhausted");
    expect(job.error).toBe(children[0]!.error);
    expect(report).toContain(`plan (job ${children[0]!.id}) hit the codex quota`);
  }, 120_000);

  it("cancels its running children when the workflow is canceled", async () => {
    const started = startSplit("Long PLAN-2 SLEEP-PLAN");
    let child: Job | undefined;
    for (let i = 0; i < 200 && !child; i++) {
      child = childJobs(started.id)[0];
      if (!child) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(child).toBeDefined();
    for (let i = 0; i < 100 && getJob(child!.id).status !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 200));

    const canceled = await cancelJob(started.id);
    expect(canceled.status).toBe("canceled");
    expect(getJob(child!.id).status).toBe("canceled");
    expect(readResult(started.id).text).toContain("## Parts");
    expect(readJob(started.id)?.cancelRequested).toBe(true);
  }, 100_000);

  it("treats a child canceled on its own as a failure, not as a canceled workflow", async () => {
    const started = startSplit("Long PLAN-2 SLEEP-PLAN");
    let child: Job | undefined;
    for (let i = 0; i < 200 && !child; i++) {
      child = childJobs(started.id)[0];
      if (!child) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (let i = 0; i < 100 && getJob(child!.id).status !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 200));

    await cancelJob(child!.id);
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("error");
    expect(done.error).toContain(`ended canceled`);
  }, 100_000);
});

describe("split workflow, write", () => {
  it("implements each part in its own worktree and branch, then reviews the diffs", async () => {
    const { job, report, children } = await runSplit("Ship it PLAN-2", {
      mode: "write",
      cwd: repo,
    });
    expect(job.status).toBe("done");
    const base = git(repo, "rev-parse", "HEAD");
    const worktreeRoot = path.join(homeDir(), "worktrees", job.id);

    const implement = byRole(children, "implement");
    expect(implement).toHaveLength(2);
    const reviews = byRole(children, "review");
    for (const part of job.split!.parts) {
      const dir = path.join(worktreeRoot, part.id);
      const branch = `agentmate/${job.id}/${part.id}`;
      expect(part.worktree).toBe(dir);
      expect(part.branch).toBe(branch);
      expect(part.base).toBe(base);
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
      expect(git(repo, "branch", "--list", branch)).toContain(branch);

      const ran = children.find((c) => c.id === part.partJob)!;
      expect(ran.role).toBe("implement");
      expect(ran.mode).toBe("write");
      expect(ran.cwd).toBe(dir);
      expect(ran.provider).toBe(part.agent);
      expect(ran.prompt).toContain(branch);

      const reviewed = children.find((c) => c.id === part.reviewJob)!;
      expect(reviewed.cwd).toBe(dir);
      expect(reviewed.mode).toBe("read-only");
      expect(reviewed.provider).not.toBe(part.agent);
      expect(reviewed.prompt).toContain(`git diff ${base}`);
      expect(reviewed.prompt).toContain(branch);
      expect(reviews).toContain(reviewed);

      // the implementer's file was committed on the part branch, not in the main tree
      expect(git(repo, "show", "--stat", "--format=%s", branch)).toContain(`part-${part.id}.txt`);
      expect(git(repo, "rev-list", "--count", `${base}..${branch}`)).toBe("1");
    }
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);

    expect(report).toContain("## Integration");
    expect(report).toContain(`git merge agentmate/${job.id}/a`);
    expect(report).toContain(`git merge agentmate/${job.id}/b`);
    expect(report.indexOf(`git merge agentmate/${job.id}/a`)).toBeLessThan(
      report.indexOf(`git merge agentmate/${job.id}/b`),
    );
    expect(report).toMatch(/conflicts are not resolved automatically/i);
    expect(report).toContain(`git worktree remove "${path.join(worktreeRoot, "a")}"`);
    expect(report).toContain(`\`agentmate/${job.id}/a\``);
    expect(report).not.toContain("## Needs human");
    expect(eventTexts(job.id).some((t) => t.startsWith("part a: worktree "))).toBe(true);

    // the branches merge cleanly, as the report says
    git(repo, "merge", "-q", "--no-edit", `agentmate/${job.id}/a`);
    git(repo, "merge", "-q", "--no-edit", `agentmate/${job.id}/b`);
    expect(fs.existsSync(path.join(repo, "part-" + "a" + ".txt"))).toBe(true);
  }, 120_000);

  it("fails with the git error when the working directory is not a repository", async () => {
    const { job, report, children } = await runSplit("Ship it PLAN-2", { mode: "write" });
    expect(job.status).toBe("error");
    expect(job.error).toBe(
      `${home} is not a git repository; task splitting in write mode needs one. Run \`agentmate jobs result ${job.id}\``,
    );
    // checked before the planner: no child, no session, no worktree
    expect(children).toHaveLength(0);
    expect(job.session).toBeUndefined();
    expect(report).toContain("## Parts");
  }, 120_000);

  it("refuses a repository without commits", async () => {
    const empty = path.join(home, "repo-empty");
    fs.mkdirSync(empty);
    execFileSync("git", ["init", "-q"], { cwd: empty });
    const { job, children } = await runSplit("Ship it PLAN-2", { mode: "write", cwd: empty });
    expect(job.status).toBe("error");
    expect(job.error).toMatch(/has no commits/);
    expect(children).toHaveLength(0);
  }, 120_000);

  it("refuses a dirty working tree before the planner starts", async () => {
    const dirty = freshRepo();
    fs.writeFileSync(path.join(dirty, "scratch.txt"), "wip\n");
    const { job, children } = await runSplit("Ship it PLAN-2", { mode: "write", cwd: dirty });
    expect(job.status).toBe("error");
    expect(job.error).toBe(
      "the working tree has uncommitted changes; commit or stash them first, because each part starts from HEAD in its own worktree",
    );
    expect(children).toHaveLength(0);
    expect(fs.existsSync(path.join(homeDir(), "worktrees", job.id))).toBe(false);
    expect(git(dirty, "branch", "--list", "agentmate/*")).toBe("");
  }, 120_000);

  it("creates the worktrees from the recorded base commit", async () => {
    const dir = freshRepo();
    const { job } = await runSplit("Ship it PLAN-2", { mode: "write", cwd: dir });
    const base = git(dir, "rev-parse", "HEAD");
    expect(job.status).toBe("done");
    for (const part of job.split!.parts) {
      expect(part.base).toBe(base);
      expect(git(dir, "rev-parse", `${part.branch}~1`)).toBe(base);
    }
  }, 120_000);

  it("commits under a failing pre-commit hook and a forced gpg signature", async () => {
    const dir = freshRepo();
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho hook says no >&2\nexit 1\n", { mode: 0o755 });
    git(dir, "config", "commit.gpgsign", "true");
    git(dir, "config", "gpg.program", "false");
    const { job, report } = await runSplit("Ship it PLAN-2", { mode: "write", cwd: dir });
    expect(job.status).toBe("done");
    const base = git(dir, "rev-parse", "HEAD");
    for (const part of job.split!.parts)
      expect(git(dir, "rev-list", "--count", `${base}..${part.branch}`)).toBe("1");
    expect(report).not.toContain("could not commit");
  }, 120_000);

  it("notes an implementer that switched branches and does not commit for it", async () => {
    const dir = freshRepo();
    const { job, report } = await runSplit("Ship it PLAN-2 MARK-A-SWITCH", {
      mode: "write",
      cwd: dir,
    });
    expect(job.status).toBe("done");
    const a = job.split!.parts.find((p) => p.id === "a")!;
    const base = git(dir, "rev-parse", "HEAD");
    expect(git(dir, "rev-list", "--count", `${base}..${a.branch}`)).toBe("0");
    expect(report).toContain("## Needs human");
    expect(report).toMatch(new RegExp(`part a: .*switched .*rogue.*not commit`));
    expect(report).toContain(`# part a: the worktree is on branch rogue, not ${a.branch}`);
    expect(report).not.toMatch(/^git merge \S+\/a$/m);
    expect(report).toMatch(new RegExp(`^git merge ${"agentmate/" + job.id}/b$`, "m"));
    // the switched worktree may hold uncommitted work, so no cleanup line is printed for it
    expect(report).not.toContain(`worktree remove --force "${a.worktree}"`);
    expect(report).not.toContain(`worktree remove "${a.worktree}"`);
  }, 120_000);

  it("keeps a worktree whose commit failed out of the cleanup list", async () => {
    const dir = freshRepo();
    const { job, report } = await runSplit("Ship it PLAN-2 MARK-B-LOCK", {
      mode: "write",
      cwd: dir,
    });
    expect(job.status).toBe("done");
    const b = job.split!.parts.find((p) => p.id === "b")!;
    expect(report).toContain(`# part b: commit failed, work is uncommitted in ${b.worktree}`);
    expect(report).toMatch(/- part b: AgentMate could not commit/);
    expect(report).not.toMatch(/^git merge \S+\/b$/m);
    expect(report).not.toContain(`worktree remove --force "${b.worktree}"`);
    expect(report).not.toContain(`worktree remove "${b.worktree}"`);
    expect(fs.existsSync(path.join(b.worktree!, "part-b.txt"))).toBe(true);
    // the approved part is still merge-ready and has its cleanup
    const a = job.split!.parts.find((p) => p.id === "a")!;
    expect(report).toMatch(new RegExp(`^git merge ${"agentmate/" + job.id}/a$`, "m"));
    expect(report).toContain(`git worktree remove "${a.worktree}"`);
  }, 120_000);

  it("lists every worktree and branch: merge only approved parts, discard the rest", async () => {
    const dir = freshRepo();
    const { job, report } = await runSplit("Ship it PLAN-2 MARK-B-REQUEST", {
      mode: "write",
      cwd: dir,
    });
    expect(job.status).toBe("done");
    const [a, b] = [job.split!.parts[0]!, job.split!.parts[1]!];
    const section = report.slice(report.indexOf("## Integration"));
    expect(section).toMatch(new RegExp(`^git merge ${a.branch}$`, "m"));
    expect(section).toMatch(new RegExp(`^# git merge ${b.branch}  # .*request`, "m"));
    expect(section).not.toMatch(new RegExp(`^git merge ${b.branch}`, "m"));
    // merged part: ordinary cleanup; unmerged part: forced removal and branch -D
    expect(section).toContain(`git worktree remove "${a.worktree}"`);
    expect(section).toContain(`git branch -d ${a.branch}`);
    expect(section).toContain(`git worktree remove --force "${b.worktree}"`);
    expect(section).toContain(`git branch -D ${b.branch}`);
    expect(section).not.toContain(`worktree remove --force "${a.worktree}"`);
  }, 120_000);

  it("keeps a failed part's worktree and branch in the report", async () => {
    const dir = freshRepo();
    const { job, report } = await runSplit("Ship it PLAN-2 MARK-B-FAIL", {
      mode: "write",
      cwd: dir,
    });
    expect(job.status).toBe("error");
    const b = job.split!.parts.find((p) => p.id === "b")!;
    expect(report).toContain(`git worktree remove --force "${b.worktree}"`);
    expect(report).toContain(`git branch -D ${b.branch}`);
    expect(report).not.toMatch(new RegExp(`^git merge ${b.branch}`, "m"));
    expect(report).toContain("## Needs human");
  }, 120_000);

  it("lists the worktrees of a canceled split", async () => {
    const dir = freshRepo();
    const started = startSplit("Ship it PLAN-2 MARK-B-SLEEP", { mode: "write", cwd: dir });
    let sleeping: Job | undefined;
    for (let i = 0; i < 300 && !sleeping; i++) {
      sleeping = childJobs(started.id).find(
        (c) => c.role === "implement" && c.provider === "claude",
      );
      if (!sleeping || getJob(sleeping.id).status !== "running") {
        sleeping = undefined;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    expect(sleeping).toBeDefined();
    const canceled = await cancelJob(started.id);
    expect(canceled.status).toBe("canceled");
    const report = readResult(started.id).text ?? "";
    const parts = readJob(started.id)!.split!.parts;
    expect(parts.every((p) => p.worktree)).toBe(true);
    for (const part of parts) {
      expect(report).toContain(`git worktree remove --force "${part.worktree}"`);
      expect(report).toContain(`git branch -D ${part.branch}`);
    }
    expect(report).not.toMatch(/^git merge /m);
  }, 120_000);

  it("continues with the other parts when one worktree cannot be created", async () => {
    const dir = freshRepo();
    const started = startSplit("Ship it PLAN-2", { mode: "write", cwd: dir });
    // the planner takes a while; occupy part b's worktree path before the worker gets there
    const blocked = path.join(homeDir(), "worktrees", started.id, "b");
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, "squatter.txt"), "x");
    const job = await waitJob(started.id, 90_000);
    const report = readResult(started.id).text ?? "";
    const parts = job.split!.parts;
    expect(job.status).toBe("error");
    expect(parts[0]!.verdict).toBe("approve");
    expect(parts[1]!.worktree).toBeUndefined();
    expect(parts[1]!.error).toMatch(/git worktree add failed/);
    expect(childJobs(started.id).filter((c) => c.role === "implement")).toHaveLength(1);
    expect(report).toMatch(/## Needs human[\s\S]*part b[\s\S]*git worktree add failed/);
    expect(report).toContain(`git merge ${parts[0]!.branch}`);
    expect(report).not.toContain(`worktree remove --force`);
    // no orphan: the branch `worktree add -b` may have created is gone again
    expect(git(dir, "branch", "--list", `agentmate/${job.id}/b`)).toBe("");
  }, 120_000);
});
