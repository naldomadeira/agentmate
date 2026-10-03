import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_IDS, AGENTS, getAgent, isAgentId, otherAgent } from "../src/agents/registry.js";
import { buildInvocation, binary, parseOutcome } from "../src/jobs/providers.js";
import { cancelJob, startJob } from "../src/jobs/api.js";
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
  });

  it("recognises agent ids", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("gemini")).toBe(false);
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
      streaming: "none",
    });
    expect(AGENTS.claude.parseStreamLine).toBeUndefined();
  });

  it("honors the binary override", () => {
    withEnv({ AGENTMATE_CODEX_BIN: "/x/codex", AGENTMATE_CLAUDE_BIN: undefined }, () => {
      expect(AGENTS.codex.binary()).toBe("/x/codex");
      expect(binary("codex")).toBe("/x/codex");
      expect(AGENTS.claude.binary()).toBe("claude");
    });
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
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
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
    expect(args.slice(0, 7)).toEqual([
      "-p",
      "--output-format",
      "json",
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
