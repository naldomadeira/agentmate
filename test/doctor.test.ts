import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectChecks, exitCodeFor, renderChecks, type Check } from "../src/commands/doctor.js";
import { writeJob, type Job } from "../src/jobs/store.js";

// A stand-in `claude`: prints a version and a legacy MCP registration for `mcp list`.
const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("9.9.9 (Claude Code)");
else if (args[0] === "mcp") console.log("codex: npx -y agentmate serve codex - connected");
`;

let home: string;
const saved = { ...process.env };

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-doctor-"));
  const bin = path.join(home, "fake-claude");
  fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  process.env["AGENTMATE_HOME"] = path.join(home, "state");
  process.env["AGENTMATE_CLAUDE_BIN"] = bin;
  process.env["AGENTMATE_CODEX_BIN"] = path.join(home, "missing-codex");
  process.env["CODEX_HOME"] = path.join(home, "codex-home");
});

afterAll(() => {
  process.env = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;

describe("doctor", () => {
  it("reports missing CLIs as warnings and found ones with their version", async () => {
    const checks = await collectChecks();
    expect(find(checks, "node").status).toBe("ok");
    expect(find(checks, "codex").status).toBe("warn");
    expect(find(checks, "codex").hint).toBeTruthy();
    expect(find(checks, "claude").status).toBe("ok");
    expect(find(checks, "claude").detail).toContain("9.9.9");
    expect(exitCodeFor(checks)).toBe(0);
  });

  it("flags legacy registrations in claude and codex", async () => {
    fs.mkdirSync(process.env["CODEX_HOME"]!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env["CODEX_HOME"]!, "config.toml"),
      '[mcp_servers.claude]\nargs = ["-y", "agentmate", "serve", "claude"]\n',
    );
    const checks = await collectChecks();
    expect(find(checks, "legacy claude registration").status).toBe("warn");
    expect(find(checks, "legacy codex registration").status).toBe("warn");
  });

  it("counts jobs and warns about running jobs whose worker died", async () => {
    const job: Job = {
      id: "stale-1",
      provider: "codex",
      mode: "read-only",
      role: "custom",
      depth: 0,
      prompt: "x",
      cwd: home,
      timeoutMs: 1000,
      status: "running",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      workerPid: 2 ** 22 - 1,
    };
    writeJob(job);
    const checks = await collectChecks();
    const jobs = find(checks, "jobs");
    expect(jobs.status).toBe("warn");
    expect(jobs.detail).toContain("1 job");
    expect(jobs.detail).toContain("1 stale: stale-1");
  });

  it("fails when the state directory is not writable and exits 1", async () => {
    const blocker = path.join(home, "blocker");
    fs.writeFileSync(blocker, "");
    process.env["AGENTMATE_HOME"] = path.join(blocker, "state");
    const checks = await collectChecks();
    expect(find(checks, "state directory").status).toBe("fail");
    expect(exitCodeFor(checks)).toBe(1);
    expect(renderChecks(checks)).toMatch(/fail\s+state directory/);
  });
});
