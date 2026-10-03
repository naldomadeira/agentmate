import { describe, it, expect } from "vitest";
import { execCommand } from "../src/lib/exec-runner.js";
import { VERSION } from "../src/lib/version.js";

const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;

function runCli(args: string[], env?: Record<string, string>) {
  return execCommand({
    command: "npx",
    args: ["tsx", CLI_PATH, ...args],
    timeoutMs: 5000,
    env,
  });
}

describe("cli", () => {
  it("shows help with available commands when no subcommand given", async () => {
    const result = await runCli([]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("serve");
    expect(output).toContain("install");
    expect(output).not.toMatch(/^\s*setup\b/m);
  });

  it("exits with error for unknown subcommand", async () => {
    const result = await runCli(["unknown"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown command");
  });

  it("starts the jobs server on 'serve jobs'", async () => {
    const result = await runCli(["serve", "jobs"]);
    expect(result.stderr).toContain("agentmate jobs server started");
    expect(result.stderr).not.toContain("Deprecated");
  });

  it("lists only the jobs subcommand in serve help", async () => {
    const result = await runCli(["serve", "--help"]);
    expect(result.stdout).toContain("jobs");
    expect(result.stdout).not.toMatch(/^\s*codex\b/m);
    expect(result.stdout).not.toMatch(/^\s*claude\b/m);
  });

  it("no longer offers the synchronous servers or setup", async () => {
    for (const args of [["serve", "codex"], ["serve", "claude"], ["setup"]]) {
      const result = await runCli(args);
      expect(result.exitCode, args.join(" ")).not.toBe(0);
      expect(result.stderr + result.stdout, args.join(" ")).not.toContain("MCP server started");
    }
  });

  it("shows install help with skill and agent subcommands", async () => {
    const result = await runCli(["install", "--help"]);
    expect(result.stdout).toContain("skill");
    expect(result.stdout).toContain("agent");
    expect(result.stdout).toContain("commands");
  });

  it("lists ask among the jobs subcommands", async () => {
    const result = await runCli(["jobs", "--help"]);
    expect(result.stdout).toContain("ask");
    expect(result.stdout).toContain("events");
  });

  it("lists max-rounds among the jobs start options and validates it", async () => {
    const help = await runCli(["jobs", "start", "--help"]);
    expect(help.stdout).toContain("max-rounds");
    expect(help.stdout).toContain("crossreview");

    const bad = await runCli([
      "jobs",
      "start",
      "claude",
      "x",
      "--role",
      "crossreview",
      "--max-rounds=9",
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("max-rounds must be a whole number from 1 to 5");
    const wrongRole = await runCli(["jobs", "start", "claude", "x", "--max-rounds=2"]);
    expect(wrongRole.exitCode).not.toBe(0);
    expect(wrongRole.stderr).toContain("max-rounds applies only with --role crossreview");
    expect(wrongRole.stderr).not.toContain("    at ");
  });

  it("refuses crossreview below the top level without a stack trace", async () => {
    const result = await runCli(["jobs", "start", "claude", "x", "--role", "crossreview"], {
      AGENTMATE_DEPTH: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Only a top-level session can start a crossreview job.");
    expect(result.stderr).not.toContain("    at ");
  });

  it("shows doctor help", async () => {
    const result = await runCli(["doctor", "--help"]);
    expect(result.stdout).toContain("doctor");
  });

  it("runs doctor without throwing even when CLIs are missing", async () => {
    const result = await execCommand({
      command: "npx",
      args: ["tsx", CLI_PATH, "doctor"],
      timeoutMs: 60_000,
    });
    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain("claude");
    expect(result.stderr).not.toContain("Error:");
  }, 70_000);

  it("prints user errors as one line without a stack trace", async () => {
    const result = await runCli(["jobs", "start", "bogus", "x"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("provider must be codex or claude");
    expect(result.stderr).not.toContain("    at ");
  });

  it("reports the delegation depth limit without a stack trace", async () => {
    const result = await runCli(["jobs", "start", "claude", "x"], { AGENTMATE_DEPTH: "2" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Delegation depth limit reached");
    expect(result.stderr).not.toContain("    at ");
  });

  it("prints the package version with --version", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it.each(["abc", "0", "-5", "Infinity"])("rejects jobs start --timeout %s", async (timeout) => {
    const result = await runCli(["jobs", "start", "claude", "x", `--timeout=${timeout}`]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timeout must be a positive number of minutes");
    expect(result.stderr).not.toContain("    at ");
  });
});
