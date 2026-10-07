import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claudeAdapter,
  claudeAllowedTools,
  READ_ONLY_DENIED_CLAUDE_TOOLS,
} from "../src/agents/claude.js";
import { codexAdapter, codexSandbox } from "../src/agents/codex.js";
import { startJob, summarize } from "../src/jobs/api.js";
import type { Job } from "../src/jobs/store.js";
import { buildReviewPrompt } from "../src/lib/prompt-builder.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "codex",
  mode: "read-only",
  role: "review",
  depth: 0,
  prompt: "the prompt",
  cwd: "/tmp",
  timeoutMs: 60_000,
  status: "queued",
  createdAt: new Date().toISOString(),
  ...extra,
});

const flag = (args: string[], name: string) =>
  args.filter((a) => a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1));

describe("codex argv for review sandbox", () => {
  it("uses read-only sandbox for review without allowCommands", () => {
    const inv = codexAdapter.buildInvocation(job({ role: "review", mode: "read-only" }));
    const idx = inv.args.indexOf("--sandbox");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(inv.args[idx + 1]).toBe("read-only");
    expect(codexSandbox(job({ role: "review", mode: "read-only" }))).toBe("read-only");
  });

  it("uses workspace-write sandbox for review with allowCommands", () => {
    const inv = codexAdapter.buildInvocation(
      job({ role: "review", mode: "read-only", allowCommands: true }),
    );
    const idx = inv.args.indexOf("--sandbox");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(inv.args[idx + 1]).toBe("workspace-write");
    expect(codexSandbox(job({ role: "review", mode: "read-only", allowCommands: true }))).toBe(
      "workspace-write",
    );
  });

  it("keeps read-only sandbox when allowCommands is false", () => {
    const inv = codexAdapter.buildInvocation(
      job({ role: "review", mode: "read-only", allowCommands: false }),
    );
    const idx = inv.args.indexOf("--sandbox");
    expect(inv.args[idx + 1]).toBe("read-only");
  });
});

describe("claude tool lists for review sandbox", () => {
  it("restricts bash to read-only git commands when allowCommands is not set", () => {
    const inv = claudeAdapter.buildInvocation(
      job({ provider: "claude", role: "review", mode: "read-only" }),
    );
    const allowed = flag(inv.args, "--allowedTools");
    const disallowed = flag(inv.args, "--disallowedTools");

    expect(allowed).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git status *)",
    ]);
    expect(allowed).not.toContain("Bash");
    expect(disallowed).toEqual(["Edit", "Write", "NotebookEdit"]);
  });

  it("allows general Bash for review with allowCommands while keeping Edit/Write denied", () => {
    const inv = claudeAdapter.buildInvocation(
      job({ provider: "claude", role: "review", mode: "read-only", allowCommands: true }),
    );
    const allowed = flag(inv.args, "--allowedTools");
    const disallowed = flag(inv.args, "--disallowedTools");

    expect(allowed).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(allowed).toContain("Bash");
    expect(disallowed).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(READ_ONLY_DENIED_CLAUDE_TOOLS).toContain("Edit");
    expect(READ_ONLY_DENIED_CLAUDE_TOOLS).toContain("Write");
  });

  it("claudeAllowedTools helper returns general Bash only when allowCommands is true on review", () => {
    expect(
      claudeAllowedTools(
        job({ provider: "claude", role: "review", mode: "read-only", allowCommands: true }),
      ),
    ).toEqual(["Read", "Grep", "Glob", "Bash"]);

    expect(
      claudeAllowedTools(job({ provider: "claude", role: "review", mode: "read-only" })),
    ).not.toContain("Bash");
  });
});

describe("review prompt in both modes", () => {
  it("warns about read-only sandbox and asks for 'Not verified' heading when commands are not allowed", () => {
    const prompt = buildReviewPrompt({ target: "main..HEAD", commandsAllowed: false });
    expect(prompt).toContain("The sandbox is read-only");
    expect(prompt).toContain(
      "commands that need to write (tests with caches, DB sockets) may fail because of the sandbox",
    );
    expect(prompt).toContain("Not verified");
    expect(prompt).toContain("sandbox vs. other");
    expect(prompt).not.toContain("verified: <cmd> passed/failed");
    expect(prompt).not.toContain("You may run tests and commands to verify claims");

    // Default (undefined commandsAllowed) behaves identically
    const defaultPrompt = buildReviewPrompt({ target: "main..HEAD" });
    expect(defaultPrompt).toBe(prompt);
  });

  it("permits command verification, forbids editing, and requires verified commands reporting when commands are allowed", () => {
    const prompt = buildReviewPrompt({ target: "main..HEAD", commandsAllowed: true });
    expect(prompt).toContain("You may run tests and commands to verify claims");
    expect(prompt).toContain("you must not: no edits");
    expect(prompt).toContain("Verified");
    expect(prompt).toContain("verified: <cmd> passed/failed");
    expect(prompt).toContain("Not verified");
    expect(prompt).not.toContain("The sandbox is read-only");
  });
});

describe("startJob allowCommands refusals and acceptance", () => {
  let home: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-review-sandbox-"));
    const fake = path.join(home, "fake");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = home;
    process.env["AGENTMATE_GEMINI_BIN"] = fake;
    process.env["AGENTMATE_AGY_BIN"] = fake;
    process.env["AGENTMATE_CODEX_BIN"] = fake;
    process.env["AGENTMATE_CLAUDE_BIN"] = fake;
    delete process.env["AGENTMATE_DEPTH"];
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses allowCommands for non-review roles", () => {
    expect(() =>
      startJob({
        provider: "codex",
        role: "ask",
        prompt: "question",
        allowCommands: true,
        cwd: home,
      }),
    ).toThrow(/allowCommands applies only to the review role/);

    expect(() =>
      startJob({
        provider: "codex",
        role: "custom",
        prompt: "custom task",
        allowCommands: true,
        cwd: home,
      }),
    ).toThrow(/allowCommands applies only to the review role/);

    expect(() =>
      startJob({
        provider: "codex",
        role: "implement",
        prompt: "implement task",
        allowCommands: true,
        cwd: home,
      }),
    ).toThrow(/allowCommands applies only to the review role/);
  });

  it("refuses allowCommands for gemini because it has no shell capability", () => {
    expect(() =>
      startJob({
        provider: "gemini",
        role: "review",
        fields: { target: "the diff" },
        allowCommands: true,
        cwd: home,
      }),
    ).toThrow(/gemini has no shell capability/);
  });

  it("refuses allowCommands for agy because it has no shell capability", () => {
    expect(() =>
      startJob({
        provider: "agy",
        role: "review",
        fields: { target: "the diff" },
        allowCommands: true,
        cwd: home,
      }),
    ).toThrow(/agy has no shell capability/);
  });

  it("accepts allowCommands for codex review and threads it to job and prompt", () => {
    const j = startJob({
      provider: "codex",
      role: "review",
      fields: { target: "the diff" },
      allowCommands: true,
      cwd: home,
    });
    expect(j.allowCommands).toBe(true);
    expect(j.role).toBe("review");
    expect(j.prompt).toContain("verified: <cmd> passed/failed");
  });

  it("accepts allowCommands for claude review and threads it to job and prompt", () => {
    const j = startJob({
      provider: "claude",
      role: "review",
      fields: { target: "the diff" },
      allowCommands: true,
      cwd: home,
    });
    expect(j.allowCommands).toBe(true);
    expect(j.role).toBe("review");
    expect(j.prompt).toContain("verified: <cmd> passed/failed");
  });
});

describe("summarize with allowCommands", () => {
  it("shows 'commands allowed' when set on the job", () => {
    const j = job({ role: "review", allowCommands: true });
    expect(summarize(j)).toContain("commands allowed");
  });

  it("does not show 'commands allowed' when unset or false", () => {
    expect(summarize(job({ role: "review" }))).not.toContain("commands allowed");
    expect(summarize(job({ role: "review", allowCommands: false }))).not.toContain(
      "commands allowed",
    );
  });
});
