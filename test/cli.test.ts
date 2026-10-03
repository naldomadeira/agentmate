import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(output).toContain("sessions");
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

  it("lists max-parts and session among the jobs start options and validates them", async () => {
    const help = await runCli(["jobs", "start", "--help"]);
    expect(help.stdout).toContain("max-parts");
    expect(help.stdout).toContain("session");
    expect(help.stdout).toContain("split");

    const bad = await runCli(["jobs", "start", "claude", "x", "--role", "split", "--max-parts=9"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("max-parts must be a whole number from 2 to 4");
    const wrongRole = await runCli(["jobs", "start", "claude", "x", "--max-parts=3"]);
    expect(wrongRole.exitCode).not.toBe(0);
    expect(wrongRole.stderr).toContain("max-parts applies only with --role split");
    const below = await runCli(["jobs", "start", "claude", "x", "--role", "split"], {
      AGENTMATE_DEPTH: "1",
    });
    expect(below.exitCode).not.toBe(0);
    expect(below.stderr).toContain("Only a top-level session can start a split job.");
    expect(below.stderr).not.toContain("    at ");
  });

  it("starts, annotates, shows and lists a session", async () => {
    const home = mkdtempSync(join(tmpdir(), "abm-cli-sessions-"));
    const env = { AGENTMATE_HOME: home };
    try {
      const help = await runCli(["sessions", "--help"]);
      for (const verb of ["start", "show", "notes", "list"]) expect(help.stdout).toContain(verb);

      const started = await runCli(
        ["sessions", "start", "Auth rewrite", "--cwd", "/work/app"],
        env,
      );
      expect(started.exitCode).toBe(0);
      const id = started.stdout.trim();
      expect(id).toMatch(/^[a-z0-9-]+$/);

      const noted = await runCli(
        ["sessions", "notes", id, "Keep the cookie.", "--author", "codex"],
        env,
      );
      expect(noted.exitCode).toBe(0);
      const shown = await runCli(["sessions", "show", id], env);
      expect(shown.stdout).toContain("Auth rewrite");
      expect(shown.stdout).toContain("· codex");
      expect(shown.stdout).toContain("Keep the cookie.");
      expect((await runCli(["sessions", "list", "--cwd", "/work/app"], env)).stdout).toContain(id);
      expect((await runCli(["sessions", "list", "--cwd", "/elsewhere"], env)).stdout).toContain(
        "No sessions.",
      );

      const missing = await runCli(["sessions", "show", "nope"], env);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("Session not found: nope");
      expect(missing.stderr).not.toContain("    at ");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("shows inbox help and lists init among the commands", async () => {
    const help = await runCli(["inbox", "--help"]);
    expect(help.exitCode).toBe(0);
    for (const flag of ["--cwd", "--all", "--no-ack", "--follow"])
      expect(help.stdout).toContain(flag);
    const root = await runCli([]);
    expect(root.stdout + root.stderr).toContain("init");
  }, 30_000);

  it("prints the unread inbox of a directory once, then reports it empty", async () => {
    const base = mkdtempSync(join(tmpdir(), "abm-cli-inbox-"));
    const home = join(base, "state");
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    // Recent timestamps: with no cursor only the last 24 hours count as unread.
    const t0 = Math.floor((Date.now() - 600_000) / 1000) * 1000;
    const at = (n: number) => new Date(t0 + n * 1000);
    const line = (job: string, cwd: string, n = 5) =>
      `${JSON.stringify({ ts: at(n).toISOString(), job, cwd, provider: "codex", role: "review", kind: "finished", text: "done" })}\n`;
    appendFileSync(join(home, "inbox.jsonl"), line("mine", repo) + line("theirs", base + "-x"));
    const env = { AGENTMATE_HOME: home };
    try {
      const peek = await runCli(["inbox", "--cwd", repo, "--no-ack"], env);
      expect(peek.stdout).toContain(
        `${at(5).toISOString().slice(11, 19)}  mine  review/codex  finished  done`,
      );
      expect(peek.stdout).not.toContain("theirs");
      const first = await runCli(["inbox", "--cwd", repo], env);
      expect(first.stdout).toContain("mine");
      const second = await runCli(["inbox", "--cwd", repo], env);
      expect(second.stdout).toContain("No new inbox entries.");
      const all = await runCli(["inbox", "--all"], env);
      expect(all.stdout).toContain("mine");
      expect(all.stdout).toContain("theirs");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it("prints the oldest 20 unread entries first and says how many more remain", async () => {
    const base = mkdtempSync(join(tmpdir(), "abm-cli-inbox-more-"));
    const home = join(base, "state");
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    const start = Math.floor((Date.now() - 600_000) / 1000) * 1000;
    for (let n = 1; n <= 23; n++)
      appendFileSync(
        join(home, "inbox.jsonl"),
        `${JSON.stringify({ ts: new Date(start + n * 1000).toISOString(), job: `job-${String(n).padStart(2, "0")}`, cwd: repo, provider: "codex", role: "ask", kind: "finished", text: "done" })}\n`,
      );
    const env = { AGENTMATE_HOME: home };
    try {
      const first = await runCli(["inbox", "--cwd", repo], env);
      expect(first.stdout).toContain("job-01");
      expect(first.stdout).toContain("job-20");
      expect(first.stdout).not.toContain("job-21");
      expect(first.stdout).toContain("… 3 more unread (run again)");
      const second = await runCli(["inbox", "--cwd", repo], env);
      expect(second.stdout).toContain("job-21");
      expect(second.stdout).toContain("job-23");
      expect(second.stdout).not.toContain("job-20");
      expect(second.stdout).not.toContain("more unread");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(["result", "wait"])(
    "jobs %s on a finished job acknowledges its inbox entries for the job's directory",
    async (sub) => {
      const base = mkdtempSync(join(tmpdir(), "abm-cli-ackjob-"));
      const home = join(base, "state");
      const repo = join(base, "repo");
      mkdirSync(repo, { recursive: true });
      mkdirSync(join(home, "jobs", "jobdone1"), { recursive: true });
      const ts = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        join(home, "jobs", "jobdone1", "job.json"),
        JSON.stringify({
          id: "jobdone1",
          provider: "codex",
          mode: "read-only",
          role: "ask",
          depth: 0,
          prompt: "p",
          cwd: repo,
          timeoutMs: 1000,
          status: "done",
          createdAt: ts,
          finishedAt: ts,
        }),
      );
      writeFileSync(join(home, "jobs", "jobdone1", "result.md"), "the answer");
      const entry = (job: string) =>
        `${JSON.stringify({ ts, job, cwd: repo, provider: "codex", role: "ask", kind: "finished", text: "done" })}\n`;
      appendFileSync(join(home, "inbox.jsonl"), entry("jobdone1") + entry("other-job"));
      const env = { AGENTMATE_HOME: home };
      try {
        const out = await runCli(["jobs", sub, "jobdone1"], env);
        expect(out.stdout).toContain("the answer");
        const inbox = await runCli(["inbox", "--cwd", repo, "--no-ack"], env);
        expect(inbox.stdout).toContain("other-job");
        expect(inbox.stdout).not.toContain("jobdone1");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
    60_000,
  );

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
    expect(result.stderr).toContain("(or gemini/agy, experimental)");
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
