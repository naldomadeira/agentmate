import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENTS,
  availableAgents,
  getAgent,
  isAgentAvailable,
  isAgentId,
  otherAgent,
} from "../src/agents/registry.js";
import { buildInvocation, binary, parseOutcome } from "../src/jobs/providers.js";
import { cancelJob, listJobs, readResult, startJob, waitJob } from "../src/jobs/api.js";
import { readEvents } from "../src/jobs/events.js";
import { parseSplitPlan } from "../src/jobs/split.js";
import { homeDir, isAlive, workerCommandLine, type Job } from "../src/jobs/store.js";
import { VERSION } from "../src/lib/version.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "codex",
  mode: "read-only",
  role: "custom",
  depth: 0,
  prompt: "the prompt",
  cwd: "/tmp",
  timeoutMs: 1000,
  status: "queued",
  createdAt: new Date().toISOString(),
  ...extra,
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("agent registry", () => {
  it("lists every registered agent", () => {
    expect([...AGENT_IDS].sort()).toEqual(Object.keys(AGENTS).sort());
    for (const id of AGENT_IDS) {
      expect(getAgent(id).id).toBe(id);
      expect(getAgent(id).displayName).toBeTruthy();
      expect(getAgent(id).versionArgs).toEqual(["--version"]);
    }
  });

  it("picks the other agent", () => {
    expect(otherAgent("codex")).toBe("claude");
    expect(otherAgent("claude")).toBe("codex");
    expect(otherAgent("gemini")).toBe("claude");
  });

  it("registers gemini as the third agent", () => {
    expect([...AGENT_IDS]).toEqual(["codex", "claude", "gemini"]);
    expect(AGENTS.gemini.displayName).toBe("Gemini CLI");
  });

  it("recognises agent ids", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("gemini")).toBe(true);
    expect(isAgentId("gpt")).toBe(false);
    expect(isAgentId("toString")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });

  it("declares capabilities", () => {
    expect(AGENTS.codex.capabilities).toEqual({
      write: true,
      web: false,
      resume: true,
      streaming: "jsonl",
    });
    expect(AGENTS.claude.capabilities).toEqual({
      write: true,
      web: true,
      resume: true,
      streaming: "jsonl",
    });
    expect(AGENTS.gemini.capabilities).toEqual({
      write: true,
      web: true,
      resume: true,
      streaming: "jsonl",
    });
    expect(AGENTS.claude.parseStreamLine).toBeDefined();
    expect(AGENTS.gemini.parseStreamLine).toBeDefined();
  });

  it("honors the binary override", () => {
    withEnv({ AGENTMATE_CODEX_BIN: "/x/codex", AGENTMATE_CLAUDE_BIN: undefined }, () => {
      expect(AGENTS.codex.binary()).toBe("/x/codex");
      expect(binary("codex")).toBe("/x/codex");
      expect(AGENTS.claude.binary()).toBe("claude");
    });
    withEnv({ AGENTMATE_GEMINI_BIN: "/x/gemini" }, () => {
      expect(AGENTS.gemini.binary()).toBe("/x/gemini");
      expect(binary("gemini")).toBe("/x/gemini");
    });
    withEnv({ AGENTMATE_GEMINI_BIN: undefined }, () => {
      expect(AGENTS.gemini.binary()).toBe("gemini");
    });
  });
});

describe("agent availability", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-avail-"));
    fs.writeFileSync(path.join(dir, "fake-gemini"), "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "a-directory"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts an absolute path to a file and rejects a missing path or a directory", () => {
    withEnv({ AGENTMATE_GEMINI_BIN: path.join(dir, "fake-gemini") }, () => {
      expect(isAgentAvailable("gemini")).toBe(true);
    });
    withEnv({ AGENTMATE_GEMINI_BIN: path.join(dir, "missing") }, () => {
      expect(isAgentAvailable("gemini")).toBe(false);
    });
    withEnv({ AGENTMATE_GEMINI_BIN: path.join(dir, "a-directory") }, () => {
      expect(isAgentAvailable("gemini")).toBe(false);
    });
  });

  it("finds a bare name in a PATH directory", () => {
    withEnv({ AGENTMATE_GEMINI_BIN: "fake-gemini", PATH: `/nonexistent:${dir}` }, () => {
      expect(isAgentAvailable("gemini")).toBe(true);
    });
    withEnv({ AGENTMATE_GEMINI_BIN: "fake-gemini", PATH: "/nonexistent" }, () => {
      expect(isAgentAvailable("gemini")).toBe(false);
    });
  });

  it("lists the installed agents in registry order", () => {
    withEnv(
      {
        AGENTMATE_CODEX_BIN: path.join(dir, "missing"),
        AGENTMATE_CLAUDE_BIN: path.join(dir, "fake-gemini"),
        AGENTMATE_GEMINI_BIN: path.join(dir, "fake-gemini"),
      },
      () => {
        expect(availableAgents()).toEqual(["claude", "gemini"]);
      },
    );
  });
});

describe("gemini buildInvocation", () => {
  const gemini = AGENTS.gemini;
  const base = ["-p", "the prompt", "--output-format", "stream-json"];
  it.each([
    [{}, [...base, "--approval-mode", "default"]],
    [{ role: "research" as const }, [...base, "--approval-mode", "default"]],
    [{ role: "review" as const }, [...base, "--approval-mode", "default"]],
    [{ mode: "write" as const }, [...base, "--approval-mode", "auto_edit"]],
    [
      { role: "implement" as const, mode: "write" as const },
      [...base, "--approval-mode", "auto_edit"],
    ],
    [{ role: "teamlead" as const }, [...base, "--approval-mode", "yolo"]],
    [{ role: "teamlead" as const, mode: "write" as const }, [...base, "--approval-mode", "yolo"]],
    [{ model: "gem-x" }, [...base, "--model", "gem-x", "--approval-mode", "default"]],
  ])("builds flags for %j", (extra, args) => {
    withEnv({ AGENTMATE_GEMINI_BIN: undefined }, () => {
      expect(gemini.buildInvocation(job({ provider: "gemini", ...extra }))).toEqual({
        command: "gemini",
        args,
      });
    });
  });

  it("resumes a session and keeps the model", () => {
    const { args } = gemini.buildInvocation(job({ provider: "gemini", model: "m" }), "sess-1");
    expect(args).toEqual([
      ...base,
      "--model",
      "m",
      "--resume",
      "sess-1",
      "--approval-mode",
      "default",
    ]);
  });

  it("never asks for the container sandbox or the legacy yolo flag", () => {
    for (const role of ["ask", "teamlead", "implement"] as const) {
      const { args } = gemini.buildInvocation(job({ provider: "gemini", role, mode: "write" }));
      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("--yolo");
    }
  });
});

describe("gemini parseStreamLine", () => {
  const parse = (value: unknown) => AGENTS.gemini.parseStreamLine!(JSON.stringify(value));
  const toolUse = (name: string, args: Record<string, unknown>) => ({
    type: "tool_use",
    name,
    args,
  });
  const reset = () => parse({ type: "init", session_id: "s", model: "m" });

  it("buffers assistant chunks and emits one message when the result arrives", () => {
    reset();
    expect(parse({ type: "message", role: "assistant", content: "Hello, " })).toEqual([]);
    expect(parse({ type: "message", role: "user", content: "ignored" })).toEqual([]);
    expect(parse({ type: "message", role: "assistant", text: "wor" })).toEqual([]);
    expect(parse({ type: "message", role: "assistant", delta: "ld" })).toEqual([]);
    const events = parse({ type: "result", stats: {} });
    expect(events).toEqual([
      expect.objectContaining({
        level: "important",
        kind: "message",
        text: "Hello, world",
        job: "",
      }),
    ]);
    // The buffer is spent: a second result adds nothing.
    expect(parse({ type: "result" })).toEqual([]);
  });

  it("prefers the result response and clips messages to 500 characters", () => {
    reset();
    parse({ type: "message", role: "assistant", content: "chunk" });
    const [event] = parse({ type: "result", response: "r".repeat(600) });
    expect(event!.text).toBe("r".repeat(500));
  });

  it("emits nothing for a stream that never reaches a result, and init clears the buffer", () => {
    reset();
    parse({ type: "message", role: "assistant", content: "stale" });
    reset();
    expect(parse({ type: "result" })).toEqual([]);
  });

  it("maps file tools to status file events", () => {
    for (const [name, key] of [
      ["write_file", "file_path"],
      ["replace", "path"],
      ["edit_file", "absolute_path"],
    ] as const) {
      expect(parse(toolUse(name, { [key]: "src/a.ts" }))).toEqual([
        expect.objectContaining({
          level: "status",
          kind: "file",
          text: `${name} src/a.ts`,
          data: { path: "src/a.ts", kind: name },
        }),
      ]);
    }
  });

  it("maps run_shell_command to a fyi command and other tools to their name", () => {
    expect(parse(toolUse("run_shell_command", { command: "ls -la" }))).toEqual([
      expect.objectContaining({
        level: "fyi",
        kind: "command",
        text: "ls -la",
        data: { command: "ls -la" },
      }),
    ]);
    expect(parse(toolUse("read_file", { absolute_path: "/x" }))).toEqual([
      expect.objectContaining({ level: "fyi", kind: "command", text: "read_file" }),
    ]);
    expect(parse({ type: "tool_use", tool_name: "glob", parameters: { pattern: "*" } })).toEqual([
      expect.objectContaining({ kind: "command", text: "glob" }),
    ]);
    expect(parse({ type: "tool_use", name: "write_file", input: {} })).toEqual([
      expect.objectContaining({ kind: "command", text: "write_file" }),
    ]);
  });

  it("maps errors to important error events", () => {
    expect(parse({ type: "error", message: "bad key" })).toEqual([
      expect.objectContaining({ level: "important", kind: "error", text: "bad key" }),
    ]);
    reset();
    const events = parse({ type: "result", error: { type: "ApiError", message: "quota" } });
    expect(events).toEqual([
      expect.objectContaining({ level: "important", kind: "error", text: "ApiError: quota" }),
    ]);
  });

  it("ignores tool results, junk and non-objects", () => {
    expect(parse({ type: "tool_result", output: "x" })).toEqual([]);
    expect(parse({ type: "wat" })).toEqual([]);
    expect(AGENTS.gemini.parseStreamLine!("not json")).toEqual([]);
    expect(AGENTS.gemini.parseStreamLine!("[1]")).toEqual([]);
  });
});

describe("gemini parseOutcome", () => {
  it("extracts text and session, and appends stderr to a failed empty run", () => {
    const stream = [
      JSON.stringify({ type: "init", session_id: "g-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hi" }),
      JSON.stringify({ type: "result" }),
    ].join("\n");
    expect(parseOutcome("gemini", stream, "", 0)).toMatchObject({ text: "hi", sessionId: "g-1" });
    const failed = parseOutcome("gemini", "", "boom", 1);
    expect(failed.text).toBe("");
    expect(failed.errors).toContain("boom");
  });
});

describe("codex buildInvocation", () => {
  const codex = AGENTS.codex;
  it.each([
    [{}, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "the prompt"]],
    [
      { mode: "write" as const },
      ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "the prompt"],
    ],
    [
      { role: "teamlead" as const },
      ["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "the prompt"],
    ],
    [
      { role: "teamlead" as const, mode: "write" as const },
      ["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "the prompt"],
    ],
    [
      { model: "m-x", mode: "write" as const },
      [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--model",
        "m-x",
        "--sandbox",
        "workspace-write",
        "the prompt",
      ],
    ],
  ])("builds flags for %j", (extra, args) => {
    expect(codex.buildInvocation(job(extra)).args).toEqual(args);
  });

  it("resumes without a sandbox flag", () => {
    const { args } = codex.buildInvocation(job({ model: "m" }), "t-9");
    expect(args).toEqual(["exec", "resume", "t-9", "--json", "--model", "m", "the prompt"]);
  });

  it("is reachable through the providers facade", () => {
    expect(buildInvocation(job())).toEqual(codex.buildInvocation(job()));
  });
});

describe("claude buildInvocation", () => {
  const claude = AGENTS.claude;
  const build = (extra: Partial<Job> = {}, resume?: string) =>
    claude.buildInvocation(job({ provider: "claude", ...extra }), resume).args;
  const flag = (args: string[], name: string) =>
    args.filter((a) => a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1));

  it("read-only denies edits and allows git inspection", () => {
    const args = build();
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args.at(-1)).toBe("the prompt");
    expect(args).not.toContain("--permission-mode");
    expect(flag(args, "--allowedTools")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git status *)",
    ]);
    expect(flag(args, "--disallowedTools")).toEqual(["Edit", "Write", "NotebookEdit"]);
  });

  it("write mode accepts edits and adds build tools", () => {
    const args = build({ mode: "write" });
    expect(args).toContain("acceptEdits");
    expect(flag(args, "--allowedTools")).toContain("Bash(pnpm *)");
    expect(flag(args, "--disallowedTools")).toEqual([]);
  });

  it("research adds web tools; teamlead adds the CLI patterns", () => {
    expect(flag(build({ role: "research" }), "--allowedTools")).toEqual(
      expect.arrayContaining(["WebSearch", "WebFetch"]),
    );
    expect(flag(build({ role: "teamlead" }), "--allowedTools")).toEqual(
      expect.arrayContaining([
        `Bash(npx -y agentmate@${VERSION} jobs *)`,
        "Bash(agentmate jobs *)",
      ]),
    );
  });

  it("resumes and passes the model", () => {
    const args = build({ model: "m" }, "s-1");
    expect(args.slice(0, 8)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "s-1",
      "--model",
      "m",
    ]);
  });
});

describe("parseOutcome", () => {
  it("appends stderr when a failed run has no text", () => {
    expect(parseOutcome("codex", "", "boom", 1).errors).toContain("boom");
    expect(parseOutcome("claude", "", "boom", 1).errors).toContain("boom");
  });

  it("extracts text and session", () => {
    const out = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    ].join("\n");
    expect(parseOutcome("codex", out, "", 0)).toMatchObject({ text: "hi", sessionId: "t-1" });
  });
});

describe("codex parseStreamLine", () => {
  const parse = (value: unknown) => AGENTS.codex.parseStreamLine!(JSON.stringify(value));

  it("maps agent messages to important events, truncated", () => {
    const [event] = parse({
      type: "item.completed",
      item: { type: "agent_message", text: "x".repeat(900) },
    });
    expect(event).toMatchObject({ level: "important", kind: "message", job: "" });
    expect(event!.text).toHaveLength(500);
    expect(Number.isNaN(Date.parse(event!.ts))).toBe(false);
  });

  it("maps file changes to status events", () => {
    expect(
      parse({ type: "item.completed", item: { type: "file_change", path: "a.ts", kind: "add" } }),
    ).toEqual([
      expect.objectContaining({
        level: "status",
        kind: "file",
        text: "add a.ts",
        data: { path: "a.ts", kind: "add" },
      }),
    ]);
  });

  it("maps commands to fyi events with the exit code", () => {
    expect(
      parse({
        type: "item.completed",
        item: { type: "command_execution", command: "ls -la", exit_code: 2 },
      }),
    ).toEqual([
      expect.objectContaining({
        level: "fyi",
        kind: "command",
        text: "ls -la (exit 2)",
        data: { command: "ls -la", exitCode: 2 },
      }),
    ]);
  });

  it("maps failures and errors to important error events", () => {
    expect(parse({ type: "turn.failed", error: { message: "nope" } })[0]).toMatchObject({
      level: "important",
      kind: "error",
      text: "nope",
    });
    expect(parse({ type: "error", message: "bad" })[0]).toMatchObject({
      kind: "error",
      text: "bad",
    });
  });

  it("ignores everything else", () => {
    expect(parse({ type: "thread.started", thread_id: "t" })).toEqual([]);
    expect(parse({ type: "turn.completed" })).toEqual([]);
    expect(parse({ type: "item.completed", item: { type: "reasoning", text: "hm" } })).toEqual([]);
    expect(AGENTS.codex.parseStreamLine!("not json")).toEqual([]);
    expect(AGENTS.codex.parseStreamLine!("")).toEqual([]);
    expect(AGENTS.codex.parseStreamLine!("42")).toEqual([]);
  });
});

describe("claude parseStreamLine", () => {
  const parse = (value: unknown) => AGENTS.claude.parseStreamLine!(JSON.stringify(value));
  const toolUse = (name: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name, input }] },
  });

  it("maps assistant text to an important message, clipped to 500 characters", () => {
    const events = parse({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(600) }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "important", kind: "message", job: "" });
    expect(events[0]!.text).toHaveLength(500);
    expect(
      parse({ type: "assistant", message: { content: [{ type: "text", text: "" }] } }),
    ).toEqual([]);
  });

  it("maps edit tools to status file events", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(parse(toolUse(name, { file_path: "src/a.ts" }))).toEqual([
        expect.objectContaining({
          level: "status",
          kind: "file",
          text: `${name} src/a.ts`,
          data: { path: "src/a.ts", kind: name },
        }),
      ]);
    }
  });

  it("maps Bash to a fyi command event with the first 200 characters", () => {
    expect(parse(toolUse("Bash", { command: "git status" }))).toEqual([
      expect.objectContaining({
        level: "fyi",
        kind: "command",
        text: "git status",
        data: { command: "git status" },
      }),
    ]);
    expect(parse(toolUse("Bash", { command: "y".repeat(300) }))[0]!.text).toHaveLength(200);
  });

  it("maps other tools to fyi commands with a short argument", () => {
    expect(parse(toolUse("Grep", { pattern: "TODO" }))[0]).toMatchObject({
      level: "fyi",
      kind: "command",
      text: "Grep TODO",
    });
    expect(parse(toolUse("Read", { file_path: "a.md" }))[0]!.text).toBe("Read a.md");
    expect(parse(toolUse("WebSearch", { query: "vitest" }))[0]!.text).toBe("WebSearch vitest");
    expect(parse(toolUse("Glob", {}))[0]!.text).toBe("Glob");
  });

  it("emits one event per content block, in order", () => {
    const events = parse({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", name: "Read", input: { file_path: "a" } },
        ],
      },
    });
    expect(events.map((e) => e.kind)).toEqual(["message", "command"]);
  });

  it("reports an error result and ignores the rest", () => {
    expect(
      parse({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }),
    ).toEqual([expect.objectContaining({ level: "important", kind: "error", text: "boom" })]);
    expect(parse({ type: "result", subtype: "error_max_turns", is_error: true })[0]!.text).toBe(
      "error_max_turns",
    );
    expect(parse({ type: "result", subtype: "success", is_error: false, result: "ok" })).toEqual(
      [],
    );
    for (const type of ["system", "user", "rate_limit_event", "active_goal"])
      expect(parse({ type })).toEqual([]);
    expect(AGENTS.claude.parseStreamLine!("not json")).toEqual([]);
    expect(AGENTS.claude.parseStreamLine!("")).toEqual([]);
    expect(AGENTS.claude.parseStreamLine!("42")).toEqual([]);
  });
});

describe("homeDir", () => {
  it("treats an empty or blank AGENTMATE_HOME as unset", () => {
    withEnv({ AGENTMATE_HOME: undefined }, () => {
      const fallback = homeDir();
      expect(fallback).toBe(path.join(os.homedir(), ".agentmate"));
      withEnv({ AGENTMATE_HOME: "" }, () => expect(homeDir()).toBe(fallback));
      withEnv({ AGENTMATE_HOME: "  " }, () => expect(homeDir()).toBe(fallback));
      withEnv({ AGENTMATE_HOME: "/custom" }, () => expect(homeDir()).toBe("/custom"));
    });
  });
});

describe("isAlive", () => {
  it("rejects missing and dead pids, and live pids that are not workers", () => {
    expect(isAlive(undefined)).toBe(false);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("requires a live pid to be a worker where the command line is readable", () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const cmdline = workerCommandLine(child.pid!);
      if (cmdline === null) return; // no /proc on this platform: isAlive keeps trusting the pid
      expect(cmdline).toContain("sleep");
      expect(isAlive(child.pid)).toBe(false);
    } finally {
      child.kill();
    }
  });
});

// A fake codex that leaves a grandchild running, to prove cancel signals the whole process group.
const FAKE_CODEX = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync("grandchild.pid", String(child.pid));
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-gc" }));
setInterval(() => {}, 1000);
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dead = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("cancel", () => {
  let home: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-agents-"));
    const bin = path.join(home, "fake-codex");
    fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = path.join(home, "state");
    process.env["AGENTMATE_CODEX_BIN"] = bin;
    process.env["AGENTMATE_CLI"] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("kills the whole process group, grandchildren included", async () => {
    const cwd = path.join(home, "work");
    fs.mkdirSync(cwd);
    const started = startJob({ provider: "codex", prompt: "go", cwd });
    const pidFile = path.join(cwd, "grandchild.pid");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8")) {
      if (Date.now() > deadline) throw new Error("grandchild never started");
      await sleep(100);
    }
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    expect(dead(grandchild)).toBe(false);

    const canceled = await cancelJob(started.id);
    expect(canceled.status).toBe("canceled");

    const until = Date.now() + 5_000;
    while (!dead(grandchild) && Date.now() < until) await sleep(100);
    expect(dead(grandchild)).toBe(true);
  }, 45_000);
});

// A stand-in for the Gemini CLI that speaks the documented stream-json format. The prompt (the value
// of `-p`) selects the behavior; the default answer echoes the arguments it received.
const FAKE_GEMINI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const emit = (e) => console.log(JSON.stringify(e));
if (prompt.includes("FAIL")) { console.error("gemini boom"); process.exit(1); }
emit({ type: "init", session_id: "g-1", model: "gemini-test" });
emit({ type: "message", role: "user", content: prompt });
if (prompt.includes("VERDICT")) {
  emit({ type: "message", role: "assistant", content: "Looks fine.\\nVerdict: approve", delta: true });
  emit({ type: "result", status: "success", stats: { total_tokens: 1 } });
  process.exit(0);
}
emit({ type: "tool_use", name: "run_shell_command", args: { command: "ls" } });
emit({ type: "tool_result", status: "success", output: "a" });
emit({ type: "tool_use", name: "write_file", args: { file_path: "a.ts", content: "x" } });
emit({ type: "message", role: "assistant", content: "pong from ", delta: true });
emit({ type: "message", role: "assistant", content: "gemini args=" + args.join(" "), delta: true });
emit({ type: "result", status: "success", stats: { total_tokens: 3 } });
`;

// A minimal codex stand-in for workflows whose partner is gemini.
const FAKE_CODEX_IMPLEMENTER = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "IMPLEMENTED " + prompt.slice(0, 40) } }));
`;

describe("gemini jobs", () => {
  let home: string;
  let geminiBin: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-gemini-"));
    geminiBin = path.join(home, "fake-gemini");
    fs.writeFileSync(geminiBin, FAKE_GEMINI, { mode: 0o755 });
    fs.writeFileSync(path.join(home, "fake-codex"), FAKE_CODEX_IMPLEMENTER, { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = path.join(home, "state");
    process.env["AGENTMATE_GEMINI_BIN"] = geminiBin;
    process.env["AGENTMATE_CODEX_BIN"] = path.join(home, "fake-codex");
    process.env["AGENTMATE_CLI"] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    delete process.env["AGENTMATE_DEPTH"];
    delete process.env["AGENTMATE_JOB_ID"];
    delete process.env["AGENTMATE_PARENT_MODE"];
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("runs a gemini job to done with events, a session and the streamed answer", async () => {
    const started = startJob({ provider: "gemini", prompt: "hello", cwd: home });
    expect(started.provider).toBe("gemini");
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("done");
    expect(done.sessionId).toBe("g-1");
    const { text } = readResult(started.id);
    expect(text).toContain("pong from gemini");
    expect(text).toContain("-p hello --output-format stream-json --approval-mode default");

    const events = readEvents(started.id);
    expect(events.map((e) => e.kind)).toEqual([
      "started",
      "command",
      "file",
      "message",
      "finished",
    ]);
    expect(events.find((e) => e.kind === "file")).toMatchObject({
      level: "status",
      data: { path: "a.ts" },
    });
    expect(events.filter((e) => e.kind === "message")).toHaveLength(1);
  }, 45_000);

  it("uses auto_edit for write jobs and resumes the previous session", async () => {
    const first = startJob({ provider: "gemini", prompt: "first", cwd: home });
    await waitJob(first.id, 30_000);
    const next = startJob({
      provider: "gemini",
      prompt: "second",
      cwd: home,
      mode: "write",
      continueJob: first.id,
    });
    const done = await waitJob(next.id, 30_000);
    expect(done.status).toBe("done");
    expect(readResult(next.id).text).toContain("--resume g-1 --approval-mode auto_edit");
  }, 60_000);

  it("ends a failing gemini job as an error with its stderr", async () => {
    const started = startJob({ provider: "gemini", prompt: "FAIL", cwd: home });
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("error");
    expect(done.error).toContain("gemini boom");
  }, 45_000);

  it("refuses an agent whose binary is missing, with the actionable message", () => {
    const missing = path.join(home, "missing-gemini");
    withEnv({ AGENTMATE_GEMINI_BIN: missing }, () => {
      expect(() => startJob({ provider: "gemini", prompt: "x", cwd: home })).toThrow(
        `Agent gemini is not installed (binary "${missing}" not found on PATH). Install it or set AGENTMATE_GEMINI_BIN.`,
      );
    });
    withEnv({ AGENTMATE_GEMINI_BIN: undefined, PATH: "/nonexistent" }, () => {
      expect(() => startJob({ provider: "gemini", prompt: "x", cwd: home })).toThrow(
        'Agent gemini is not installed (binary "gemini" not found on PATH). Install it or set AGENTMATE_GEMINI_BIN.',
      );
    });
  });

  it("validates partner: different from the provider, installed, and only for workflow roles", () => {
    expect(() =>
      startJob({
        provider: "codex",
        role: "crossreview",
        partner: "codex",
        prompt: "t",
        cwd: home,
      }),
    ).toThrow("partner must differ from the provider");
    withEnv({ AGENTMATE_GEMINI_BIN: path.join(home, "missing-gemini") }, () => {
      expect(() =>
        startJob({
          provider: "codex",
          role: "teamlead",
          partner: "gemini",
          prompt: "t",
          cwd: home,
        }),
      ).toThrow("Agent gemini is not installed");
    });
    expect(() =>
      startJob({ provider: "codex", role: "ask", partner: "gemini", prompt: "t", cwd: home }),
    ).toThrow("partner applies only to the teamlead, crossreview and split roles");
  });

  it("briefs a team lead to delegate to its partner", async () => {
    const started = startJob({
      provider: "codex",
      role: "teamlead",
      partner: "gemini",
      prompt: "ship it",
      cwd: home,
    });
    expect(started.partner).toBe("gemini");
    expect(started.prompt).toContain("jobs start gemini");
    expect(started.prompt).toContain("delegate only to gemini");
    await cancelJob(started.id);
  }, 30_000);

  it("pairs a gemini provider with claude by default", () => {
    const claudeBin = path.join(home, "fake-claude");
    fs.writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
    withEnv({ AGENTMATE_CLAUDE_BIN: claudeBin }, () => {
      const started = startJob({ provider: "gemini", role: "teamlead", prompt: "x", cwd: home });
      expect(started.prompt).toContain("jobs start claude");
      expect(started.partner).toBeUndefined();
    });
  });

  it("runs a crossreview whose reviewer is the gemini partner", async () => {
    const started = startJob({
      provider: "codex",
      role: "crossreview",
      partner: "gemini",
      prompt: "add a flag VERDICT",
      cwd: home,
    });
    const done = await waitJob(started.id, 80_000);
    expect(done.status).toBe("done");
    const children = listJobs({ parent: started.id, limit: 10 });
    expect(children.map((c) => `${c.role}:${c.provider}`).sort()).toEqual([
      "implement:codex",
      "review:gemini",
    ]);
    expect(readResult(started.id).text).toContain("approve");
  }, 100_000);
});

describe("split plans with a partner", () => {
  const plan = (agents: (string | undefined)[]) =>
    "```json\n" +
    JSON.stringify({
      parts: agents.map((agent, i) => ({
        id: `p${i}`,
        title: "t",
        briefing: "b",
        files: [],
        agent,
      })),
    }) +
    "\n```";

  it("alternates between the planner and its partner when agents are missing", () => {
    const parsed = parseSplitPlan(plan([undefined, undefined, undefined]), {
      maxParts: 3,
      planner: "codex",
      partner: "gemini",
    });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.parts.map((p) => p.agent)).toEqual(["gemini", "codex", "gemini"]);
  });

  it("replaces an agent that is not allowed with the next one in turn", () => {
    const parsed = parseSplitPlan(plan(["gemini", "claude"]), {
      maxParts: 3,
      planner: "codex",
      allowed: ["codex", "claude"],
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.parts.map((p) => p.agent)).toEqual(["claude", "claude"]);
  });

  it("accepts gemini by default as a registered agent", () => {
    const parsed = parseSplitPlan(plan(["gemini"]), { maxParts: 3, planner: "claude" });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.parts[0]!.agent).toBe("gemini");
  });
});
