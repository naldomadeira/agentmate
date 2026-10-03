import { describe, it, expect } from "vitest";
import { execCommand } from "../src/lib/exec-runner.js";
import { LEGACY_DEPRECATION_NOTICE } from "../src/lib/deprecation.js";
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
    expect(output).toContain("setup");
    expect(output).toContain("install");
  });

  it("exits with error for unknown subcommand", async () => {
    const result = await runCli(["unknown"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown command");
  });

  it("starts codex server on 'serve codex'", async () => {
    const result = await runCli(["serve", "codex"]);
    // The server starts on stdio and blocks waiting for input,
    // so it will be killed by timeout. Check that it started successfully.
    expect(result.stderr).toContain("agentmate MCP server started");
    expect(result.stderr).toContain(LEGACY_DEPRECATION_NOTICE);
  });

  it("starts claude server on 'serve claude'", async () => {
    const result = await runCli(["serve", "claude"]);
    expect(result.stderr).toContain("agentmate-claude MCP server started");
    expect(result.stderr).toContain(LEGACY_DEPRECATION_NOTICE);
  });

  it("prints the deprecation notice to stderr only, and exactly as specified", async () => {
    expect(LEGACY_DEPRECATION_NOTICE).toBe(
      "Deprecated: the synchronous servers (serve codex, serve claude) and setup are removed in 0.6.0; install the plugin (mate@agentmate) and use the mate_* job tools instead.",
    );
    const result = await runCli(["serve", "codex"]);
    expect(result.stdout).not.toContain("Deprecated");
    expect(result.stderr.match(/^Deprecated: /gm)).toHaveLength(1);
  });

  it("does not warn about the deprecation for the jobs server", async () => {
    const result = await runCli(["serve", "jobs"]);
    expect(result.stderr).toContain("agentmate jobs server started");
    expect(result.stderr).not.toContain("Deprecated");
  });

  it("shows serve help with codex and claude subcommands", async () => {
    const result = await runCli(["serve", "--help"]);
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain("claude");
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
