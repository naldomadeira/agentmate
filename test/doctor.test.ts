import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/agents/registry.js";
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
  process.env["AGENTMATE_GEMINI_BIN"] = path.join(home, "missing-gemini");
  process.env["AGENTMATE_AGY_BIN"] = path.join(home, "missing-agy");
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

  it("reports one line per agent, and a missing Gemini CLI as optional rather than a warning", async () => {
    const checks = await collectChecks();
    for (const id of AGENT_IDS) expect(find(checks, id)).toBeDefined();
    const gemini = find(checks, "gemini");
    expect(gemini.status).toBe("ok");
    expect(gemini.detail).toBe("not installed (optional)");
    expect(renderChecks(checks)).toMatch(/ok\s+gemini\s+not installed \(optional\)/);
  });

  it("shows the version of an installed Gemini CLI and warns when it does not respond", async () => {
    const bin = path.join(home, "fake-gemini");
    fs.writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("0.9.1");\n', { mode: 0o755 });
    process.env["AGENTMATE_GEMINI_BIN"] = bin;
    expect(find(await collectChecks(), "gemini")).toMatchObject({ status: "ok", detail: "0.9.1" });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(find(await collectChecks(), "gemini").status).toBe("warn");
    process.env["AGENTMATE_GEMINI_BIN"] = path.join(home, "missing-gemini");
  });

  it("reports a missing Antigravity CLI as optional, shows its version and warns when it does not respond", async () => {
    const missing = find(await collectChecks(), "agy");
    expect(missing).toMatchObject({ status: "ok", detail: "not installed (optional)" });
    expect(renderChecks(await collectChecks())).toMatch(/ok\s+agy\s+not installed \(optional\)/);
    const bin = path.join(home, "fake-agy");
    fs.writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("agy 1.2.6");\n', { mode: 0o755 });
    process.env["AGENTMATE_AGY_BIN"] = bin;
    expect(find(await collectChecks(), "agy")).toMatchObject({ status: "ok", detail: "agy 1.2.6" });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const broken = find(await collectChecks(), "agy");
    expect(broken.status).toBe("warn");
    expect(broken.detail).toContain("Antigravity CLI (agy)");
    expect(broken.hint).toContain("https://antigravity.google/cli/install.sh");
    process.env["AGENTMATE_AGY_BIN"] = path.join(home, "missing-agy");
  });

  it("flags legacy registrations in claude and codex", async () => {
    fs.mkdirSync(process.env["CODEX_HOME"]!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env["CODEX_HOME"]!, "config.toml"),
      '[mcp_servers.claude]\nargs = ["-y", "agentmate", "serve", "claude"]\n',
    );
    const checks = await collectChecks();
    const claude = find(checks, "legacy claude registration");
    const codex = find(checks, "legacy codex registration");
    expect(claude.status).toBe("warn");
    expect(claude.detail).toContain("serve codex");
    expect(claude.hint).toContain("remove it; the synchronous servers were removed in 0.6.0");
    expect(codex.status).toBe("warn");
    expect(codex.detail).toContain("serve claude");
    expect(codex.hint).toContain("remove it; the synchronous servers were removed in 0.6.0");
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
