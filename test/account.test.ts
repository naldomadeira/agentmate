import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    fs.mkdirSync(binDir, { mode: 0o700 });

    const fake = path.join(binDir, "fake");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    process.env["AGENTMATE_HOME"] = home;
    process.env["AGENTMATE_CODEX_PROFILES"] = profiles;
    process.env["AGENTMATE_CODEX_BIN"] = fake;
    process.env["AGENTMATE_CLAUDE_BIN"] = fake;
    delete process.env["AGENTMATE_DEPTH"];
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses account for non-codex providers", () => {
    expect(() => startJob({ provider: "claude", prompt: "q", account: "zeus", cwd: home })).toThrow(
      /account applies only to codex/,
    );
  });

  it("refuses an unknown profile and lists available ones", () => {
    expect(() =>
      startJob({ provider: "codex", prompt: "q", account: "kratos", cwd: home }),
    ).toThrow(/Codex account "kratos" not found.*Available: principal, zeus/);
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
});

describe("summarize", () => {
  it("shows account when set and not principal", () => {
    expect(summarize(job({ account: "zeus" }))).toContain("account zeus");
    expect(summarize(job({ account: "principal" }))).not.toContain("account");
    expect(summarize(job())).not.toContain("account");
  });
});
