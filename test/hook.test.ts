import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hook = resolve(import.meta.dirname, "..", "hooks", "session-start.mjs");

let home: string;
let cwd: string;
let other: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "abm-hook-"));
  home = join(base, "state");
  cwd = join(base, "repo");
  other = join(base, "elsewhere");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(other, { recursive: true });
});

afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function writeJob(id: string, fields: Record<string, unknown>): void {
  const dir = join(home, "jobs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "job.json"),
    JSON.stringify({
      id,
      provider: "codex",
      mode: "read-only",
      role: "ask",
      depth: 0,
      prompt: "p",
      timeoutMs: 1000,
      createdAt: ago(3_600_000),
      ...fields,
    }),
  );
}

function runHook(env: Record<string, string> = {}, input: unknown = { cwd }) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, AGENTMATE_HOME: home, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function deadPid(): number {
  // A pid that is not alive: spawn a process that exits and reuse its pid.
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid ?? 2 ** 22 - 3;
}

function seed(): void {
  writeJob("musn0r25", {
    status: "done",
    role: "crossreview",
    cwd,
    finishedAt: ago(12 * 60_000),
  });
  writeJob("musn27mj", {
    status: "error",
    provider: "claude",
    cwd,
    finishedAt: ago(3 * 60_000),
  });
  writeJob("stale001", { status: "running", cwd, workerPid: deadPid(), startedAt: ago(600_000) });
  writeJob("alive001", { status: "running", cwd, workerPid: process.pid });
  writeJob("foreign01", { status: "done", cwd: other, finishedAt: ago(60_000) });
}

describe("SessionStart hook", () => {
  it("reports finished, running and stale jobs of this cwd as additionalContext", () => {
    seed();
    const { status, stdout } = runHook();

    expect(status).toBe(0);
    const out = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const text = out.hookSpecificOutput.additionalContext;
    expect(text.startsWith("AgentMate:")).toBe(true);
    expect(text).toContain("musn0r25 done (crossreview, codex, 12m ago)");
    expect(text).toContain("musn27mj error (ask, claude, 3m ago)");
    expect(text).toContain("1 stale");
    expect(text).toContain("1 running");
    expect(text).toContain("agentmate jobs list");
    expect(text).not.toContain("foreign01");
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it("stays silent on a second run inside the cooldown", () => {
    seed();
    expect(runHook().stdout).not.toBe("");
    expect(runHook().stdout).toBe("");
    const stamp = join(home, "hooks", `${createHash("sha1").update(cwd).digest("hex")}.stamp`);
    expect(existsSync(stamp)).toBe(true);
    expect(Number.isNaN(Date.parse(readFileSync(stamp, "utf8").trim()))).toBe(false);
  });

  it("only reports jobs finished after the previous stamp once the cooldown expired", () => {
    seed();
    const stampDir = join(home, "hooks");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(
      join(stampDir, `${createHash("sha1").update(cwd).digest("hex")}.stamp`),
      ago(5 * 60_000),
    );
    const text = (JSON.parse(runHook().stdout) as any).hookSpecificOutput.additionalContext;

    expect(text).toContain("musn27mj");
    expect(text).not.toContain("musn0r25");
  });

  it("prints nothing when there is nothing to report", () => {
    writeJob("old00001", { status: "done", cwd, finishedAt: ago(3 * 24 * 3_600_000) });
    writeJob("foreign01", { status: "done", cwd: other, finishedAt: ago(60_000) });

    expect(runHook()).toMatchObject({ status: 0, stdout: "" });
  });

  it("prints nothing with AGENTMATE_HOOK_QUIET=1", () => {
    seed();

    expect(runHook({ AGENTMATE_HOOK_QUIET: "1" })).toMatchObject({ status: 0, stdout: "" });
  });

  it("falls back to process.cwd() when stdin has no cwd", () => {
    seed();
    const result = spawnSync(process.execPath, [hook], {
      input: "",
      cwd,
      encoding: "utf8",
      env: { ...process.env, AGENTMATE_HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("musn0r25");
  });

  it("ignores a corrupt job.json", () => {
    seed();
    mkdirSync(join(home, "jobs", "corrupt1"), { recursive: true });
    writeFileSync(join(home, "jobs", "corrupt1", "job.json"), "{not json");

    const { status, stdout } = runHook();

    expect(status).toBe(0);
    expect(stdout).toContain("musn0r25");
  });

  it("exits 0 without output when the state directory is missing or stdin is garbage", () => {
    expect(runHook({ AGENTMATE_HOME: join(home, "missing") })).toMatchObject({
      status: 0,
      stdout: "",
    });
    const result = spawnSync(process.execPath, [hook], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, AGENTMATE_HOME: home },
    });
    expect(result.status).toBe(0);
  });

  it("truncates the job list to stay under 400 characters", () => {
    for (let i = 0; i < 12; i++) {
      writeJob(`job-long-${i}`, { status: "done", cwd, finishedAt: ago((i + 1) * 60_000) });
    }
    const text = (JSON.parse(runHook().stdout) as any).hookSpecificOutput.additionalContext;

    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toMatch(/… and \d+ more/);
  });
});
