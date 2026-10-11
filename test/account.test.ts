import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeAdapter } from "../src/agents/claude.js";
import { codexAdapter } from "../src/agents/codex.js";
import { startJob, summarize } from "../src/jobs/api.js";
import { writeJob, type Job } from "../src/jobs/store.js";
import { execCommand } from "../src/lib/exec-runner.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "codex",
  mode: "read-only",
  role: "custom",
  depth: 0,
  prompt: "the prompt",
  cwd: "/tmp",
  timeoutMs: 60_000,
  status: "queued",
  createdAt: new Date().toISOString(),
  ...extra,
});

describe("codex account env hook", () => {
  const saved = process.env["AGENTMATE_CODEX_PROFILES"];

  afterAll(() => {
    if (saved === undefined) delete process.env["AGENTMATE_CODEX_PROFILES"];
    else process.env["AGENTMATE_CODEX_PROFILES"] = saved;
  });

  it("returns undefined for principal or absent account", () => {
    expect(codexAdapter.env?.(job())).toBeUndefined();
    expect(codexAdapter.env?.(job({ account: "principal" }))).toBeUndefined();
  });

  it("returns CODEX_HOME for a named profile", () => {
    process.env["AGENTMATE_CODEX_PROFILES"] = "/fake/profiles";
    expect(codexAdapter.env?.(job({ account: "zeus" }))).toEqual({
      CODEX_HOME: path.join("/fake/profiles", "zeus"),
    });
  });
});

describe("execCommand env passthrough", () => {
  it("passes env to the child process", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: ["-e", "console.log(process.env.TEST_ACCOUNT_X)"],
      env: { TEST_ACCOUNT_X: "it-works" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("it-works");
  });

  it("removes an explicitly unset variable from the child process", async () => {
    process.env["TEST_ACCOUNT_UNSET_X"] = "inherited";
    const result = await execCommand({
      command: process.execPath,
      args: ["-e", "console.log(process.env.TEST_ACCOUNT_UNSET_X ?? 'missing')"],
      env: { TEST_ACCOUNT_UNSET_X: undefined },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("missing");
    delete process.env["TEST_ACCOUNT_UNSET_X"];
  });
});

describe("startJob account validation", () => {
  let home: string;
  let profiles: string;
  let binDir: string;
  const saved = { ...process.env };

  beforeAll(() => {
    const tmp = os.tmpdir();
    home = fs.mkdtempSync(path.join(tmp, "amw-account-"));
    profiles = path.join(home, "profiles");
    binDir = path.join(home, "bin");
    fs.mkdirSync(profiles, { mode: 0o700 });
    fs.mkdirSync(path.join(profiles, "zeus"), { mode: 0o700 });
    fs.writeFileSync(path.join(profiles, "zeus", "config.toml"), "");
    // Not profiles: a hidden directory and one without auth.json or config.toml.
    fs.mkdirSync(path.join(profiles, ".meta"), { mode: 0o700 });
    fs.mkdirSync(path.join(profiles, "bin"), { mode: 0o700 });
    fs.mkdirSync(path.join(home, ".claude-hades"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".claude-hades", ".claude.json"), "{}");
    fs.mkdirSync(binDir, { mode: 0o700 });

    const fake = path.join(binDir, "fake");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    process.env["AGENTMATE_HOME"] = home;
    process.env["AGENTMATE_CODEX_PROFILES"] = profiles;
    process.env["AGENTMATE_CODEX_BIN"] = fake;
    process.env["AGENTMATE_CLAUDE_BIN"] = fake;
    process.env["AGENTMATE_GEMINI_BIN"] = fake;
    process.env["AGENTMATE_AGY_BIN"] = fake;
    process.env["AGENTMATE_COPILOT_BIN"] = fake;
    delete process.env["AGENTMATE_DEPTH"];
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("unsets CLAUDE_CONFIG_DIR for the principal account", async () => {
    process.env["CLAUDE_CONFIG_DIR"] = path.join(home, ".claude-hades");
    const env = claudeAdapter.env?.(job({ provider: "claude", account: "principal" }));
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: undefined,
    });
    const result = await execCommand({
      command: process.execPath,
      args: ["-e", "console.log(process.env.CLAUDE_CONFIG_DIR ?? 'missing')"],
      env,
    });
    expect(result.stdout.trim()).toBe("missing");
  });

  it("leaves Claude environment untouched when account is omitted", async () => {
    const inherited = path.join(home, ".claude-hades");
    process.env["CLAUDE_CONFIG_DIR"] = inherited;
    const env = claudeAdapter.env?.(job({ provider: "claude" }));
    expect(env).toBeUndefined();
    const result = await execCommand({
      command: process.execPath,
      args: ["-e", "console.log(process.env.CLAUDE_CONFIG_DIR ?? 'missing')"],
      env,
    });
    expect(result.stdout.trim()).toBe(inherited);
  });

  it("sets the exact conventional Claude config directory for a named account", () => {
    expect(claudeAdapter.env?.(job({ provider: "claude", account: "hades" }))).toEqual({
      CLAUDE_CONFIG_DIR: path.join(home, ".claude-hades"),
    });
  });

  it("prefers an explicit Claude account map over the conventional directory", () => {
    const mapped = path.join(home, "mapped-hades");
    fs.mkdirSync(mapped, { mode: 0o700 });
    fs.writeFileSync(path.join(mapped, "settings.json"), "{}");
    process.env["AGENTMATE_CLAUDE_ACCOUNTS"] = `hades=${mapped}`;

    expect(startJob({ provider: "claude", prompt: "q", account: "hades", cwd: home }).account).toBe(
      "hades",
    );
    expect(claudeAdapter.env?.(job({ provider: "claude", account: "hades" }))).toEqual({
      CLAUDE_CONFIG_DIR: mapped,
    });
    delete process.env["AGENTMATE_CLAUDE_ACCOUNTS"];
  });

  it("refuses invalid, missing and auto Claude accounts", () => {
    expect(() =>
      startJob({ provider: "claude", prompt: "q", account: "had/es", cwd: home }),
    ).toThrow(/Invalid Claude account name/);
    expect(() =>
      startJob({ provider: "claude", prompt: "q", account: "kratos", cwd: home }),
    ).toThrow(/Claude account "kratos" is not a config directory.*Available: principal, hades\./);
    expect(() => startJob({ provider: "claude", prompt: "q", account: "auto", cwd: home })).toThrow(
      /auto applies only to codex/,
    );
    process.env["AGENTMATE_CLAUDE_ACCOUNTS"] = "kratos=relative-dir";
    expect(() =>
      startJob({ provider: "claude", prompt: "q", account: "kratos", cwd: home }),
    ).toThrow(/must use an absolute directory/);
    delete process.env["AGENTMATE_CLAUDE_ACCOUNTS"];
  });

  it.each(["gemini", "agy", "copilot"] as const)("refuses account for %s", (provider) => {
    expect(() => startJob({ provider, prompt: "q", account: "zeus", cwd: home })).toThrow(
      /account applies only to codex and claude/,
    );
  });

  it("refuses an unknown profile and lists available ones", () => {
    expect(() =>
      startJob({ provider: "codex", prompt: "q", account: "kratos", cwd: home }),
    ).toThrow(/Codex account "kratos" is not a profile.*Available: principal, zeus\.$/);
  });

  it("resolves auto with limites script", () => {
    const limitesBin = path.join(binDir, "limites-ok");
    fs.writeFileSync(limitesBin, '#!/bin/sh\necho \'{"suggestion": {"name": "zeus"}}\'\n', {
      mode: 0o755,
    });
    process.env["AGENTMATE_LIMITES_BIN"] = limitesBin;

    const j = startJob({ provider: "codex", prompt: "q", account: "auto", cwd: home });
    expect(j.account).toBe("zeus");
    expect(j.accountNote).toBeUndefined();
  });

  it("falls back to principal when limites fails", () => {
    const limitesBin = path.join(binDir, "limites-fail");
    fs.writeFileSync(limitesBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env["AGENTMATE_LIMITES_BIN"] = limitesBin;

    const j = startJob({ provider: "codex", prompt: "q", account: "auto", cwd: home });
    expect(j.account).toBe("principal");
    expect(j.accountNote).toMatch(/failed/);
  });

  it("inherits account on continueJob", () => {
    const prior = job({
      id: "prior-2",
      status: "done",
      sessionId: "s-2",
      account: "zeus",
      cwd: home,
    });
    writeJob(prior);

    const j = startJob({ provider: "codex", prompt: "go", continueJob: "prior-2", cwd: home });
    expect(j.account).toBe("zeus");
  });

  it("refuses to override account on continueJob", () => {
    const prior = job({
      id: "prior-3",
      status: "done",
      sessionId: "s-3",
      account: "principal",
      cwd: home,
    });
    writeJob(prior);

    expect(() =>
      startJob({
        provider: "codex",
        prompt: "go",
        continueJob: "prior-3",
        account: "zeus",
        cwd: home,
      }),
    ).toThrow(/ran on Codex account .*its thread lives there/);
  });

  it("refuses to continue a Claude session on another account", () => {
    const prior = job({
      id: "prior-claude",
      provider: "claude",
      status: "done",
      sessionId: "claude-session",
      account: "principal",
      cwd: home,
    });
    writeJob(prior);

    expect(() =>
      startJob({
        provider: "claude",
        prompt: "go",
        continueJob: "prior-claude",
        account: "hades",
        cwd: home,
      }),
    ).toThrow(/ran on Claude account .*its session lives there/);
  });

  it("refuses to assume that an inherited Claude account is principal on continueJob", () => {
    process.env["CLAUDE_CONFIG_DIR"] = path.join(home, ".claude-hades");
    const prior = job({
      id: "prior-claude-inherited",
      provider: "claude",
      status: "done",
      sessionId: "claude-inherited-session",
      cwd: home,
    });
    writeJob(prior);

    expect(() =>
      startJob({
        provider: "claude",
        prompt: "go",
        continueJob: "prior-claude-inherited",
        account: "principal",
        cwd: home,
      }),
    ).toThrow(/ran on Claude account .*its session lives there/);
  });

  it("validates a requested Claude account before comparing a continued session", () => {
    const prior = job({
      id: "prior-claude-auto",
      provider: "claude",
      status: "done",
      sessionId: "claude-auto-session",
      account: "principal",
      cwd: home,
    });
    writeJob(prior);

    expect(() =>
      startJob({
        provider: "claude",
        prompt: "go",
        continueJob: "prior-claude-auto",
        account: "auto",
        cwd: home,
      }),
    ).toThrow(/auto applies only to codex/);
  });
});

describe("summarize", () => {
  it("shows account when set and not principal", () => {
    expect(summarize(job({ account: "zeus" }))).toContain("account zeus");
    expect(summarize(job({ account: "principal" }))).not.toContain("account");
    expect(summarize(job())).not.toContain("account");
  });
});
