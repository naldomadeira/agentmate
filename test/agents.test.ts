import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENTS,
  assertAgentAvailable,
  availableAgents,
  firstAvailableOther,
  getAgent,
  installedOther,
  isAgentAvailable,
  isAgentId,
  otherAgent,
  resolveBinary,
} from "../src/agents/registry.js";
import { createAgyAdapter } from "../src/agents/agy.js";
import { createGeminiAdapter } from "../src/agents/gemini.js";
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

  it("registers gemini third, agy fourth and copilot fifth", () => {
    expect([...AGENT_IDS]).toEqual(["codex", "claude", "gemini", "agy", "copilot"]);
    expect(AGENTS.copilot.displayName).toBe("GitHub Copilot CLI");
    expect(otherAgent("copilot")).toBe("claude");
    expect(AGENTS.gemini.displayName).toBe("Gemini CLI");
    expect(AGENTS.agy.displayName).toBe("Antigravity CLI (agy)");
    expect(otherAgent("agy")).toBe("claude");
  });

  it("recognises agent ids", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("gemini")).toBe(true);
    expect(isAgentId("agy")).toBe(true);
    expect(isAgentId("gpt")).toBe(false);
    expect(isAgentId("toString")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });

  it("declares capabilities", () => {
    expect(AGENTS.codex.capabilities).toEqual({
      write: true,
      web: false,
      resume: true,
      shell: true,
      streaming: "jsonl",
    });
    expect(AGENTS.claude.capabilities).toEqual({
      write: true,
      web: true,
      resume: true,
      shell: true,
      streaming: "jsonl",
    });
    // Experimental and untested against the real CLI: headless Gemini denies shell and web tools and
    // `--resume` is unverified, so none of them is claimed.
    expect(AGENTS.gemini.capabilities).toEqual({
      write: true,
      web: false,
      resume: false,
      shell: false,
      streaming: "jsonl",
    });
    // Experimental as well: agy runs shell commands only with --dangerously-skip-permissions, so a
    // reviewer gets the diff inline (shell false), but `--conversation` continues a run (resume).
    expect(AGENTS.agy.capabilities).toEqual({
      write: true,
      web: false,
      resume: true,
      shell: false,
      streaming: "jsonl",
    });
    expect(AGENTS.claude.parseStreamLine).toBeDefined();
    expect(AGENTS.gemini.parseStreamLine).toBeDefined();
    expect(AGENTS.agy.parseStreamLine).toBeDefined();
  });

  it("declares which agents need write mode to lead a team", () => {
    expect(Object.fromEntries(AGENT_IDS.map((id) => [id, AGENTS[id].teamleadNeedsWrite]))).toEqual({
      codex: false,
      claude: false,
      gemini: true,
      agy: true,
      copilot: false,
    });
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
    withEnv({ AGENTMATE_AGY_BIN: "/x/agy" }, () => {
      expect(AGENTS.agy.binary()).toBe("/x/agy");
      expect(binary("agy")).toBe("/x/agy");
    });
    withEnv({ AGENTMATE_AGY_BIN: undefined }, () => {
      expect(AGENTS.agy.binary()).toBe("agy");
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

  it("resolves a relative binary against the given directory, defaulting to the process cwd", () => {
    withEnv({ AGENTMATE_GEMINI_BIN: "./fake-gemini" }, () => {
      expect(isAgentAvailable("gemini", dir)).toBe(true);
      expect(isAgentAvailable("gemini", path.join(dir, "a-directory"))).toBe(false);
      expect(isAgentAvailable("gemini")).toBe(false);
      expect(resolveBinary("./fake-gemini", dir)).toBe(path.join(dir, "fake-gemini"));
    });
    // A bare name is looked up on PATH and passed through untouched.
    expect(resolveBinary("gemini", dir)).toBe("gemini");
    expect(resolveBinary("/abs/gemini", dir)).toBe("/abs/gemini");
  });

  it("on Windows accepts only extensionless files and .exe (spawn runs without a shell)", () => {
    for (const name of ["win-cmd.cmd", "win-bat.bat", "win-exe.exe", "win-bare"])
      fs.writeFileSync(path.join(dir, name), "x", { mode: 0o755 });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const found = (bin: string) => withPath(bin, () => isAgentAvailable("gemini"));
      expect(found("win-cmd")).toBe(false);
      expect(found("win-bat")).toBe(false);
      expect(found("win-exe")).toBe(true);
      expect(found("win-bare")).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    function withPath(bin: string, fn: () => boolean): boolean {
      let result = false;
      withEnv({ AGENTMATE_GEMINI_BIN: bin, PATH: dir, PATHEXT: ".EXE;.CMD;.BAT" }, () => {
        result = fn();
      });
      return result;
    }
  });

  it("picks the first installed agent that differs, in registry order", () => {
    const missing = path.join(dir, "missing");
    const fake = path.join(dir, "fake-gemini");
    withEnv(
      {
        AGENTMATE_CODEX_BIN: missing,
        AGENTMATE_CLAUDE_BIN: fake,
        AGENTMATE_GEMINI_BIN: fake,
        AGENTMATE_AGY_BIN: missing,
      },
      () => {
        expect(installedOther("claude")).toBe("gemini");
        expect(installedOther("gemini")).toBe("claude");
        expect(firstAvailableOther("claude")).toBe("gemini");
        expect(installedOther("codex")).toBe("claude");
      },
    );
    withEnv(
      {
        AGENTMATE_CODEX_BIN: missing,
        AGENTMATE_CLAUDE_BIN: fake,
        AGENTMATE_GEMINI_BIN: missing,
        AGENTMATE_AGY_BIN: missing,
      },
      () => {
        // Nothing else is installed: the default pairing is the fallback, and assertAgentAvailable fails on it.
        expect(installedOther("claude")).toBeUndefined();
        expect(firstAvailableOther("claude")).toBe("codex");
        expect(() => assertAgentAvailable("codex")).toThrow(/not installed/);
      },
    );
    withEnv(
      {
        AGENTMATE_CODEX_BIN: fake,
        AGENTMATE_CLAUDE_BIN: fake,
        AGENTMATE_GEMINI_BIN: fake,
        AGENTMATE_AGY_BIN: missing,
      },
      () => {
        expect(firstAvailableOther("codex")).toBe("claude");
        expect(firstAvailableOther("claude")).toBe("codex");
        expect(firstAvailableOther("gemini")).toBe("codex");
        expect(installedOther("claude", ["gemini", "claude"])).toBe("gemini");
      },
    );
    // agy is the last in registry order: it pairs when it is the only other agent installed.
    withEnv(
      {
        AGENTMATE_CODEX_BIN: missing,
        AGENTMATE_CLAUDE_BIN: fake,
        AGENTMATE_GEMINI_BIN: missing,
        AGENTMATE_AGY_BIN: fake,
      },
      () => {
        expect(installedOther("claude")).toBe("agy");
        expect(firstAvailableOther("claude")).toBe("agy");
        expect(firstAvailableOther("agy")).toBe("claude");
        expect(installedOther("claude", ["codex", "claude"])).toBeUndefined();
      },
    );
  });

  it("lists the installed agents in registry order", () => {
    withEnv(
      {
        AGENTMATE_CODEX_BIN: path.join(dir, "missing"),
        AGENTMATE_CLAUDE_BIN: path.join(dir, "fake-gemini"),
        AGENTMATE_GEMINI_BIN: path.join(dir, "fake-gemini"),
        AGENTMATE_AGY_BIN: path.join(dir, "fake-gemini"),
      },
      () => {
        expect(availableAgents()).toEqual(["claude", "gemini", "agy"]);
      },
    );
  });

  it("finds agy through AGENTMATE_AGY_BIN", () => {
    withEnv({ AGENTMATE_AGY_BIN: path.join(dir, "fake-gemini") }, () => {
      expect(isAgentAvailable("agy")).toBe(true);
    });
    withEnv({ AGENTMATE_AGY_BIN: path.join(dir, "missing") }, () => {
      expect(isAgentAvailable("agy")).toBe(false);
      expect(() => assertAgentAvailable("agy")).toThrow(
        `Agent agy is not installed (binary "${path.join(dir, "missing")}" not found on PATH). Install it or set AGENTMATE_AGY_BIN.`,
      );
    });
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
    // yolo is for the write-mode team lead only; a read-only one never gets it.
    [{ role: "teamlead" as const }, [...base, "--approval-mode", "default"]],
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

  it("keeps a prompt that starts with a dash from being read as a flag", () => {
    const { args } = gemini.buildInvocation(
      job({ provider: "gemini", prompt: "--version please" }),
    );
    expect(args.slice(0, 2)).toEqual(["-p", " --version please"]);
    expect(gemini.buildInvocation(job({ provider: "gemini", prompt: "-x" })).args[1]).toBe(" -x");
    expect(gemini.buildInvocation(job({ provider: "gemini", prompt: "plain" })).args[1]).toBe(
      "plain",
    );
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

  it("maps an error event with severity warning to a status event", () => {
    expect(parse({ type: "error", severity: "warning", message: "slow tool" })).toEqual([
      expect.objectContaining({ level: "status", kind: "error", text: "warning: slow tool" }),
    ]);
    expect(parse({ type: "error", severity: "WARNING", message: "x" })[0]).toMatchObject({
      level: "status",
    });
    expect(parse({ type: "error", severity: "error", message: "bad" })).toEqual([
      expect.objectContaining({ level: "important", kind: "error", text: "bad" }),
    ]);
  });

  it("keeps the pending text per adapter instance and clears it with resetStream", () => {
    const first = createGeminiAdapter();
    const second = createGeminiAdapter();
    const line = (value: unknown) => JSON.stringify(value);
    first.parseStreamLine!(line({ type: "message", role: "assistant", content: "from first" }));
    // Another adapter's result must not flush the first one's text.
    expect(second.parseStreamLine!(line({ type: "result" }))).toEqual([]);
    first.resetStream!();
    expect(first.parseStreamLine!(line({ type: "result" }))).toEqual([]);
    first.parseStreamLine!(line({ type: "message", role: "assistant", content: "again" }));
    expect(first.parseStreamLine!(line({ type: "result" }))[0]).toMatchObject({ text: "again" });
    AGENTS.gemini.resetStream!();
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

  const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

  it("marks a result with an error and text as partial, with the error", () => {
    const out = stream(
      { type: "message", role: "assistant", content: "edited two files" },
      { type: "result", status: "error", error: { message: "boom" } },
    );
    expect(parseOutcome("gemini", out, "", 1)).toMatchObject({
      text: "edited two files",
      partial: true,
      errors: ["boom"],
    });
  });

  it("marks a failed run that never reached a result as partial and names the exit code", () => {
    const out = stream(
      { type: "init", session_id: "g-2" },
      { type: "message", role: "assistant", content: "half" },
    );
    const outcome = parseOutcome("gemini", out, "", 3);
    expect(outcome).toMatchObject({ text: "half", partial: true, sessionId: "g-2" });
    expect(outcome.errors.join(" ")).toMatch(/exited 3 without a final result/);
    // A clean exit without a result stays partial but needs no extra error.
    expect(parseOutcome("gemini", out, "", 0).errors).toEqual([]);
  });

  it("reports a non-zero exit with no output as an error", () => {
    const outcome = parseOutcome("gemini", stream({ type: "init", session_id: "g" }), "", 1);
    expect(outcome.text).toBe("");
    expect(outcome.errors.join(" ")).toMatch(/exited 1/);
  });

  it("accepts plain text as the answer only when the CLI exited cleanly", () => {
    expect(parseOutcome("gemini", "just an answer\n", "", 0)).toMatchObject({
      text: "just an answer",
      errors: [],
    });
    const failed = parseOutcome("gemini", "Error: model not found\n", "", 1);
    expect(failed.text).toBe("");
    expect(failed.errors.join(" ")).toContain("Error: model not found");
  });

  it("does not mark a completed run as partial", () => {
    const out = stream(
      { type: "message", role: "assistant", content: "done" },
      { type: "result", status: "success" },
    );
    expect(parseOutcome("gemini", out, "", 0)).toEqual({
      text: "done",
      sessionId: null,
      errors: [],
    });
  });
});

describe("agy buildInvocation", () => {
  const agy = AGENTS.agy;
  const dirFlags = ["--add-dir", "/tmp"];
  const base = ["-p", "the prompt", "--output-format", "stream-json", ...dirFlags];
  const skip = "--dangerously-skip-permissions";
  it.each([
    // Read-only jobs pass no permission flag and rely on agy's own profile.
    [{}, [...base, "--print-timeout", "1m"]],
    [{ role: "research" as const }, [...base, "--print-timeout", "1m"]],
    [{ role: "review" as const }, [...base, "--print-timeout", "1m"]],
    [{ role: "teamlead" as const }, [...base, "--print-timeout", "1m"]],
    [{ mode: "write" as const }, [...base, "--print-timeout", "1m", skip]],
    [
      { role: "implement" as const, mode: "write" as const },
      [...base, "--print-timeout", "1m", skip],
    ],
    [
      { role: "teamlead" as const, mode: "write" as const },
      [...base, "--print-timeout", "1m", skip],
    ],
    [{ model: "gem-x" }, [...base, "--print-timeout", "1m", "--model", "gem-x"]],
  ])("builds flags for %j", (extra, args) => {
    withEnv({ AGENTMATE_AGY_BIN: undefined }, () => {
      expect(agy.buildInvocation(job({ provider: "agy", ...extra }))).toEqual({
        command: "agy",
        args,
      });
    });
  });

  it("derives --print-timeout from the job deadline, rounded up to whole minutes", () => {
    const timeout = (timeoutMs: number) => {
      const { args } = agy.buildInvocation(job({ provider: "agy", timeoutMs }));
      return args[args.indexOf("--print-timeout") + 1];
    };
    expect(timeout(60_000)).toBe("1m");
    expect(timeout(60_001)).toBe("2m");
    expect(timeout(10 * 60_000)).toBe("10m");
    expect(timeout(30 * 60_000)).toBe("30m");
    expect(timeout(90_000)).toBe("2m");
    // Never "0m", which agy would read as no time at all.
    expect(timeout(1)).toBe("1m");
  });

  it("works in the job's directory and uses the binary override", () => {
    withEnv({ AGENTMATE_AGY_BIN: "/x/agy" }, () => {
      const invocation = agy.buildInvocation(job({ provider: "agy", cwd: "/work/repo" }));
      expect(invocation.command).toBe("/x/agy");
      expect(invocation.args).toContain("/work/repo");
      expect(invocation.args[invocation.args.indexOf("--add-dir") + 1]).toBe("/work/repo");
    });
  });

  it("continues a conversation with --conversation, keeping the model and the permission flag", () => {
    const { args } = agy.buildInvocation(
      job({ provider: "agy", model: "m", mode: "write" }),
      "conv-1",
    );
    expect(args).toEqual([
      ...base,
      "--print-timeout",
      "1m",
      "--model",
      "m",
      "--conversation",
      "conv-1",
      skip,
    ]);
    expect(agy.buildInvocation(job({ provider: "agy" })).args).not.toContain("--conversation");
  });

  it("keeps a prompt that starts with a dash from being read as a flag", () => {
    const { args } = agy.buildInvocation(job({ provider: "agy", prompt: "--version please" }));
    expect(args.slice(0, 2)).toEqual(["-p", " --version please"]);
    expect(agy.buildInvocation(job({ provider: "agy", prompt: "-x" })).args[1]).toBe(" -x");
    expect(agy.buildInvocation(job({ provider: "agy", prompt: "plain" })).args[1]).toBe("plain");
  });

  it("never passes a permission flag to a read-only job", () => {
    for (const role of ["ask", "review", "research", "plan", "teamlead", "custom"] as const) {
      const { args } = agy.buildInvocation(job({ provider: "agy", role, mode: "read-only" }));
      expect(args, role).not.toContain("--dangerously-skip-permissions");
    }
  });
});

describe("agy parseStreamLine", () => {
  const adapter = () => createAgyAdapter();
  const parseWith = (a: ReturnType<typeof createAgyAdapter>) => (value: unknown) =>
    a.parseStreamLine!(typeof value === "string" ? value : JSON.stringify(value));
  const update = (extra: Record<string, unknown>) => ({
    event: "step_update",
    step_update: {
      conversation_id: "c",
      step_index: 0,
      step_type: "tool",
      state: "ACTIVE",
      ...extra,
    },
  });

  it("maps a command tool to a fyi command event with the command line", () => {
    const parse = parseWith(adapter());
    const events = parse(
      update({
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "pnpm typecheck" } },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        level: "fyi",
        kind: "command",
        text: "pnpm typecheck",
        job: "",
        data: { command: "pnpm typecheck" },
      }),
    ]);
  });

  it("clips a command to 200 characters", () => {
    const parse = parseWith(adapter());
    const [event] = parse(
      update({
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "x".repeat(300) } },
      }),
    );
    expect(event!.text).toBe("x".repeat(200));
  });

  it("maps file edits to status file events with the path", () => {
    const parse = parseWith(adapter());
    for (const [index, [name, key]] of [
      ["write_to_file", "TargetFile"],
      ["replace_file_content", "TargetFile"],
      ["multi_replace_file_content", "AbsolutePath"],
      ["edit_file", "FilePath"],
    ].entries()) {
      const events = parse(
        update({
          step_index: index,
          tool_name: name,
          tool_info: { parameters: { [key!]: `/work/src/a${index}.ts` } },
        }),
      );
      expect(events, name).toEqual([
        expect.objectContaining({
          level: "status",
          kind: "file",
          text: `${name} /work/src/a${index}.ts`,
          data: { path: `/work/src/a${index}.ts`, kind: name },
        }),
      ]);
    }
  });

  it("maps reads and other tools to fyi commands with a short hint", () => {
    const parse = parseWith(adapter());
    expect(
      parse(
        update({
          tool_name: "view_file",
          tool_info: { parameters: { AbsolutePath: "/work/src/index.d.mts" } },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ level: "fyi", kind: "command", text: "view_file index.d.mts" }),
    ]);
    expect(parse(update({ step_index: 1, tool_name: "list_dir" }))).toEqual([
      expect.objectContaining({ level: "fyi", kind: "command", text: "list_dir" }),
    ]);
    // A file tool with no path is just a command.
    expect(parse(update({ step_index: 2, tool_name: "write_to_file" }))).toEqual([
      expect.objectContaining({ kind: "command", text: "write_to_file" }),
    ]);
    // The name may sit in tool_info when the step has none.
    expect(
      parse(
        update({ step_index: 3, tool_info: { name: "search_web", parameters: { Query: "q" } } }),
      ),
    ).toEqual([expect.objectContaining({ kind: "command", text: "search_web q" })]);
  });

  it("reports a step once: its DONE update adds nothing after the ACTIVE one", () => {
    const parse = parseWith(adapter());
    const active = update({
      tool_name: "run_command",
      tool_info: { parameters: { CommandLine: "ls" } },
    });
    expect(parse(active)).toHaveLength(1);
    const done = update({
      state: "DONE",
      tool_name: "run_command",
      duration_seconds: 1.2,
      tool_info: { parameters: { CommandLine: "ls" }, output: "a" },
    });
    expect(parse(done)).toEqual([]);
    // A step first seen as DONE is reported then.
    expect(parse(update({ step_index: 5, state: "DONE", tool_name: "list_dir" }))).toEqual([
      expect.objectContaining({ kind: "command", text: "list_dir" }),
    ]);
  });

  it("maps a tool error to a status error event", () => {
    const parse = parseWith(adapter());
    parse(
      update({ tool_name: "run_command", tool_info: { parameters: { CommandLine: "false" } } }),
    );
    const events = parse(
      update({
        state: "DONE",
        tool_name: "run_command",
        tool_info: { error: { message: "exit status 1" } },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        level: "status",
        kind: "error",
        text: "run_command failed: exit status 1",
      }),
    ]);
  });

  it("emits one important message with the first 500 characters of the result response", () => {
    const parse = parseWith(adapter());
    const events = parse({
      event: "result",
      result: { status: "SUCCESS", response: "r".repeat(600), conversation_id: "c" },
    });
    expect(events).toEqual([
      expect.objectContaining({ level: "important", kind: "message", text: "r".repeat(500) }),
    ]);
  });

  it("falls back to the streamed agent text, once, when the result has no response", () => {
    const parse = parseWith(adapter());
    expect(
      parse(update({ step_index: 1, step_type: "agent_response", text_delta: "Hello, " })),
    ).toEqual([]);
    expect(
      parse(update({ step_index: 1, step_type: "agent_response", text_delta: "world" })),
    ).toEqual([]);
    expect(parse({ event: "result", result: { status: "SUCCESS" } })).toEqual([
      expect.objectContaining({ kind: "message", text: "Hello, world" }),
    ]);
    expect(parse({ event: "result", result: { status: "SUCCESS" } })).toEqual([]);
  });

  it("emits nothing for a stream that never reaches a result, and init clears the buffer", () => {
    const parse = parseWith(adapter());
    parse(update({ step_type: "agent_response", text_delta: "stale" }));
    expect(parse({ event: "init", init: { conversation_id: "c" } })).toEqual([]);
    expect(parse({ event: "result", result: { status: "SUCCESS" } })).toEqual([]);
  });

  it("keeps state per adapter instance and clears it with resetStream", () => {
    const a = adapter();
    const b = adapter();
    parseWith(a)(update({ step_type: "agent_response", text_delta: "only in a" }));
    expect(parseWith(b)({ event: "result", result: { status: "SUCCESS" } })).toEqual([]);
    a.resetStream!();
    expect(parseWith(a)({ event: "result", result: { status: "SUCCESS" } })).toEqual([]);
  });

  it("maps a failed result to an important error event after its message", () => {
    const parse = parseWith(adapter());
    const events = parse({
      event: "result",
      result: {
        status: "ERROR",
        response: "half",
        error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h1m13s",
      },
    });
    expect(events.map((e) => [e.level, e.kind])).toEqual([
      ["important", "message"],
      ["important", "error"],
    ]);
    expect(events[1]!.text).toContain("Individual quota reached");
    expect(
      parse({ event: "result", result: { status: "TIMEOUT" } }).map((e) => [e.kind, e.text]),
    ).toEqual([["error", "agy reported status TIMEOUT"]]);
  });

  it("ignores unknown events, malformed steps, junk and non-objects", () => {
    const parse = parseWith(adapter());
    expect(parse({ event: "mystery", mystery: {} })).toEqual([]);
    expect(parse({ event: "step_update", step_update: "nope" })).toEqual([]);
    expect(parse({ event: "step_update" })).toEqual([]);
    expect(parse({ type: "message", content: "gemini shaped" })).toEqual([]);
    expect(parse("not json")).toEqual([]);
    expect(parse("[1,2]")).toEqual([]);
    expect(parse("42")).toEqual([]);
    expect(parse("")).toEqual([]);
  });
});

describe("agy parseOutcome", () => {
  const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const result = (extra: Record<string, unknown>) => ({ event: "result", result: extra });

  it("extracts the text and the conversation id as the session", () => {
    const out = stream(
      { event: "init", init: { conversation_id: "c-1" } },
      result({ status: "SUCCESS", response: "hi", conversation_id: "c-1" }),
    );
    expect(parseOutcome("agy", out, "", 0)).toEqual({ text: "hi", sessionId: "c-1", errors: [] });
  });

  it("reads the single JSON object after a banner", () => {
    const out = `agy 1.2.6\n${JSON.stringify({ status: "SUCCESS", response: "ok", conversation_id: "c-2" })}`;
    expect(parseOutcome("agy", out, "", 0)).toMatchObject({ text: "ok", sessionId: "c-2" });
  });

  it("appends stderr to a failed run with no text", () => {
    const failed = parseOutcome("agy", "", "boom", 1);
    expect(failed.text).toBe("");
    expect(failed.errors).toContain("boom");
    expect(parseOutcome("agy", "", "ignored", 0).errors).not.toContain("ignored");
  });

  it("marks a result with an error and text as partial, with the error", () => {
    const out = stream(result({ status: "ERROR", response: "edited two files", error: "boom" }));
    expect(parseOutcome("agy", out, "", 1)).toMatchObject({
      text: "edited two files",
      partial: true,
      errors: ["boom"],
    });
  });

  it("marks a run that never reached a result as partial and names the exit code", () => {
    const out = stream(
      { event: "init", init: { conversation_id: "c-3" } },
      {
        event: "step_update",
        step_update: {
          conversation_id: "c-3",
          step_index: 1,
          step_type: "agent_response",
          text_delta: "half",
        },
      },
    );
    const outcome = parseOutcome("agy", out, "", 3);
    expect(outcome).toMatchObject({ text: "half", partial: true, sessionId: "c-3" });
    expect(outcome.errors.join(" ")).toMatch(/exited 3 without a final result/);
  });

  it("reports a non-zero exit with no result as an error", () => {
    const outcome = parseOutcome(
      "agy",
      stream({ event: "init", init: { conversation_id: "c" } }),
      "",
      1,
    );
    expect(outcome.text).toBe("");
    expect(outcome.errors.join(" ")).toMatch(/exited 1 without a final result/);
  });

  it("does not mark a completed run as partial", () => {
    const out = stream(result({ status: "SUCCESS", response: "done" }));
    expect(parseOutcome("agy", out, "", 0)).toEqual({ text: "done", sessionId: null, errors: [] });
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

  it("isolates every role from the user's MCP servers", () => {
    for (const extra of [
      {},
      { mode: "write" as const },
      { role: "research" as const },
      { role: "teamlead" as const },
    ]) {
      expect(build(extra)).toContain("--strict-mcp-config");
    }
    expect(build({}, "sess-1")).toContain("--strict-mcp-config");
  });

  it("keeps the user's MCP servers when AGENTMATE_CLAUDE_INHERIT_MCP=1", () => {
    withEnv({ AGENTMATE_CLAUDE_INHERIT_MCP: "1" }, () => {
      expect(build()).not.toContain("--strict-mcp-config");
    });
    withEnv({ AGENTMATE_CLAUDE_INHERIT_MCP: "0" }, () => {
      expect(build()).toContain("--strict-mcp-config");
    });
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
    expect(args.slice(0, 9)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
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
  const tracked: string[] = [];
  /** Workflow jobs started only to inspect their record are canceled afterwards. */
  const track = (started: Job): Job => {
    tracked.push(started.id);
    return started;
  };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-gemini-"));
    geminiBin = path.join(home, "fake-gemini");
    fs.writeFileSync(geminiBin, FAKE_GEMINI, { mode: 0o755 });
    fs.writeFileSync(path.join(home, "fake-codex"), FAKE_CODEX_IMPLEMENTER, { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = path.join(home, "state");
    process.env["AGENTMATE_GEMINI_BIN"] = geminiBin;
    // Not installed here: a developer's real agy must not change which agent a workflow pairs with.
    process.env["AGENTMATE_AGY_BIN"] = path.join(home, "missing-agy");
    process.env["AGENTMATE_CODEX_BIN"] = path.join(home, "fake-codex");
    process.env["AGENTMATE_CLI"] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    delete process.env["AGENTMATE_DEPTH"];
    delete process.env["AGENTMATE_JOB_ID"];
    delete process.env["AGENTMATE_PARENT_MODE"];
  });

  afterAll(async () => {
    await Promise.all(tracked.map((id) => cancelJob(id).catch(() => undefined)));
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

  it("uses auto_edit for write jobs", async () => {
    const started = startJob({ provider: "gemini", prompt: "edit", cwd: home, mode: "write" });
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("done");
    expect(readResult(started.id).text).toContain("--approval-mode auto_edit");
  }, 45_000);

  it("refuses to continue a gemini job because its --resume is unverified", async () => {
    const first = startJob({ provider: "gemini", prompt: "first", cwd: home });
    await waitJob(first.id, 30_000);
    expect(() =>
      startJob({ provider: "gemini", prompt: "second", cwd: home, continueJob: first.id }),
    ).toThrow(
      "Continuing a job is not available for gemini yet (its --resume is unverified). Start a new job with the full context instead.",
    );
    // The refusal does not depend on the prior job existing.
    expect(() =>
      startJob({ provider: "gemini", prompt: "second", cwd: home, continueJob: "nope" }),
    ).toThrow(/not available for gemini/);
  }, 45_000);

  it("accepts a gemini team lead only in write mode and runs it in yolo", async () => {
    expect(() =>
      startJob({ provider: "gemini", role: "teamlead", prompt: "lead", cwd: home }),
    ).toThrow(
      "A Gemini team lead needs mode write: delegation requires the shell, which Gemini only allows in yolo mode.",
    );
    expect(() =>
      startJob({
        provider: "gemini",
        role: "teamlead",
        prompt: "lead",
        cwd: home,
        mode: "read-only",
      }),
    ).toThrow(/needs mode write/);
    const started = startJob({
      provider: "gemini",
      role: "teamlead",
      prompt: "lead",
      cwd: home,
      mode: "write",
    });
    expect(started.mode).toBe("write");
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("done");
    expect(readResult(started.id).text).toContain("--approval-mode yolo");
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
    ).toThrow("partner applies only to the teamlead, crossreview, split and plan roles");
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

  it("pairs a gemini provider with the first installed other agent and records it", async () => {
    const claudeBin = path.join(home, "fake-claude");
    fs.writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
    withEnv({ AGENTMATE_CLAUDE_BIN: claudeBin, AGENTMATE_CODEX_BIN: path.join(home, "no") }, () => {
      const started = track(
        startJob({
          provider: "gemini",
          role: "teamlead",
          mode: "write",
          prompt: "x",
          cwd: home,
        }),
      );
      expect(started.prompt).toContain("jobs start claude");
      expect(started.partner).toBe("claude");
    });
  });

  it("resolves the default partner among installed agents and fails fast when it is missing", () => {
    const claudeBin = path.join(home, "fake-claude");
    fs.writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
    const missing = path.join(home, "missing-bin");
    const roles = ["teamlead", "crossreview", "split"] as const;
    // Only claude is installed: there is nobody to pair it with, before any file is touched.
    withEnv(
      {
        AGENTMATE_CLAUDE_BIN: claudeBin,
        AGENTMATE_CODEX_BIN: missing,
        AGENTMATE_GEMINI_BIN: missing,
      },
      () => {
        for (const role of roles) {
          expect(() => startJob({ provider: "claude", role, prompt: "t", cwd: home })).toThrow(
            /Agent codex is not installed/,
          );
        }
        // An explicit partner is checked too.
        expect(() =>
          startJob({
            provider: "claude",
            role: "crossreview",
            partner: "gemini",
            prompt: "t",
            cwd: home,
          }),
        ).toThrow(/Agent gemini is not installed/);
      },
    );
    // With gemini installed it becomes the partner of claude.
    withEnv(
      {
        AGENTMATE_CLAUDE_BIN: claudeBin,
        AGENTMATE_CODEX_BIN: missing,
        AGENTMATE_GEMINI_BIN: geminiBin,
      },
      () => {
        for (const role of roles) {
          const started = track(startJob({ provider: "claude", role, prompt: "t", cwd: home }));
          expect(started.partner).toBe("gemini");
        }
      },
    );
  }, 30_000);

  it("keeps the explicit partner and the default pairing when both agents are installed", () => {
    const claudeBin = path.join(home, "fake-claude");
    fs.writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
    withEnv({ AGENTMATE_CLAUDE_BIN: claudeBin }, () => {
      const run = (extra: Partial<Parameters<typeof startJob>[0]>) =>
        track(startJob({ provider: "codex", prompt: "t", cwd: home, ...extra }));
      expect(run({ role: "crossreview" }).partner).toBe("claude");
      expect(run({ role: "crossreview", partner: "gemini" }).partner).toBe("gemini");
      expect(run({ role: "ask" }).partner).toBe(undefined);
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
    // Gemini cannot run shell commands headless, so its briefing carries the diff instead.
    const review = children.find((c) => c.role === "review")!;
    expect(review.prompt).toContain("may not run shell commands");
    expect(review.prompt).toContain("Diff");
  }, 100_000);
});

// A stand-in for the Antigravity CLI that speaks the stream-json format of `agy -p`. The prompt (the
// value of `-p`) selects the behavior; the default answer echoes the arguments it received and names
// the conversation (the one passed to `--conversation`, else `agy-conv-1`).
const FAKE_AGY = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const given = args.indexOf("--conversation") >= 0 ? args[args.indexOf("--conversation") + 1] : null;
const conv = given ?? "agy-conv-1";
const emit = (e) => console.log(JSON.stringify(e));
const step = (index, type, state, extra) => ({ event: "step_update", step_update: { conversation_id: conv, step_index: index, step_type: type, state, ...extra } });
if (prompt.includes("FAIL")) { console.error("agy boom"); process.exit(1); }
emit({ event: "init", init: { conversation_id: conv, model: "agy-test" } });
if (prompt.includes("QUOTA")) {
  emit({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h1m13s", conversation_id: conv } });
  process.exit(1);
}
emit(step(0, "tool", "ACTIVE", { tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } }));
emit(step(0, "tool", "DONE", { tool_name: "run_command", duration_seconds: 0.1, tool_info: { parameters: { CommandLine: "ls" }, output: "a" } }));
emit(step(1, "tool", "ACTIVE", { tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "a.ts" } } }));
emit(step(1, "tool", "DONE", { tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "a.ts" } } }));
const answer = prompt.includes("VERDICT") ? "Looks fine.\\nVerdict: approve" : "pong from agy args=" + args.join(" ");
emit(step(2, "agent_response", "ACTIVE", { text_delta: answer.slice(0, 5) }));
emit(step(2, "agent_response", "DONE", { text_delta: answer.slice(5) }));
emit({ event: "result", result: { status: "SUCCESS", response: answer, conversation_id: conv } });
`;

describe("agy jobs", () => {
  let home: string;
  let agyBin: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-agy-"));
    agyBin = path.join(home, "fake-agy");
    fs.writeFileSync(agyBin, FAKE_AGY, { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = path.join(home, "state");
    process.env["AGENTMATE_AGY_BIN"] = agyBin;
    // Not installed here: a developer's real codex or gemini must not change the default partner.
    process.env["AGENTMATE_CODEX_BIN"] = path.join(home, "missing-codex");
    process.env["AGENTMATE_GEMINI_BIN"] = path.join(home, "missing-gemini");
    delete process.env["AGENTMATE_DEPTH"];
    delete process.env["AGENTMATE_JOB_ID"];
    delete process.env["AGENTMATE_PARENT_MODE"];
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("runs an agy job to done with events, the conversation as session and the answer", async () => {
    const started = startJob({ provider: "agy", prompt: "hello", cwd: home });
    expect(started.provider).toBe("agy");
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("done");
    expect(done.sessionId).toBe("agy-conv-1");
    const { text } = readResult(started.id);
    expect(text).toContain("pong from agy");
    expect(text).toContain(
      `-p hello --output-format stream-json --add-dir ${home} --print-timeout`,
    );
    expect(text).not.toContain("--dangerously-skip-permissions");

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

  it("skips permissions for write jobs only", async () => {
    const started = startJob({ provider: "agy", prompt: "edit", cwd: home, mode: "write" });
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("done");
    expect(readResult(started.id).text).toContain("--dangerously-skip-permissions");
  }, 45_000);

  it("continues a finished job with --conversation and the stored conversation id", async () => {
    const first = startJob({ provider: "agy", prompt: "first", cwd: home });
    const firstDone = await waitJob(first.id, 30_000);
    expect(firstDone.sessionId).toBe("agy-conv-1");
    const second = startJob({
      provider: "agy",
      prompt: "second",
      cwd: home,
      continueJob: first.id,
    });
    const done = await waitJob(second.id, 30_000);
    expect(done.status).toBe("done");
    expect(done.continuesJob).toBe(first.id);
    expect(readResult(second.id).text).toContain("--conversation agy-conv-1");
    expect(done.sessionId).toBe("agy-conv-1");
  }, 60_000);

  it("accepts an agy team lead only in write mode", async () => {
    const message =
      "An agy team lead needs mode write: delegation requires the shell, which agy only allows with --dangerously-skip-permissions.";
    // The lead needs a partner: the fake binary stands in for claude.
    process.env["AGENTMATE_CLAUDE_BIN"] = agyBin;
    expect(() =>
      startJob({ provider: "agy", role: "teamlead", prompt: "lead", cwd: home }),
    ).toThrow(message);
    expect(() =>
      startJob({ provider: "agy", role: "teamlead", prompt: "lead", cwd: home, mode: "read-only" }),
    ).toThrow(message);
    const started = startJob({
      provider: "agy",
      role: "teamlead",
      prompt: "lead",
      cwd: home,
      mode: "write",
    });
    expect(started.mode).toBe("write");
    expect(started.partner).toBe("claude");
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("done");
    expect(readResult(started.id).text).toContain("--dangerously-skip-permissions");
  }, 60_000);

  it("ends a failing agy job as an error with its stderr", async () => {
    const started = startJob({ provider: "agy", prompt: "FAIL", cwd: home });
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("error");
    expect(done.error).toContain("agy boom");
  }, 45_000);

  it("ends a job whose result reports an exhausted quota as quota_exhausted", async () => {
    const started = startJob({ provider: "agy", prompt: "QUOTA", cwd: home });
    const done = await waitJob(started.id, 30_000);
    expect(done.status).toBe("quota_exhausted");
    expect(done.error).toContain("agy quota exhausted");
    expect(done.error).toContain("Individual quota reached");
    expect(done.sessionId).toBe("agy-conv-1");
  }, 45_000);

  it("refuses an agy job when the binary is missing, with the actionable message", () => {
    const missing = path.join(home, "missing-agy");
    withEnv({ AGENTMATE_AGY_BIN: missing }, () => {
      expect(() => startJob({ provider: "agy", prompt: "x", cwd: home })).toThrow(
        `Agent agy is not installed (binary "${missing}" not found on PATH). Install it or set AGENTMATE_AGY_BIN.`,
      );
    });
  });

  it("accepts agy as a partner and as a reviewer in a crossreview", async () => {
    const codexBin = path.join(home, "fake-codex");
    fs.writeFileSync(codexBin, FAKE_CODEX_IMPLEMENTER, { mode: 0o755 });
    process.env["AGENTMATE_CODEX_BIN"] = codexBin;
    const started = startJob({
      provider: "codex",
      role: "crossreview",
      partner: "agy",
      prompt: "add a flag VERDICT",
      cwd: home,
    });
    const done = await waitJob(started.id, 80_000);
    expect(done.status).toBe("done");
    const children = listJobs({ parent: started.id, limit: 10 });
    expect(children.map((c) => `${c.role}:${c.provider}`).sort()).toEqual([
      "implement:codex",
      "review:agy",
    ]);
    expect(readResult(started.id).text).toContain("approve");
    // agy reviews with the diff in its briefing: it has no shell without --dangerously-skip-permissions.
    const review = children.find((c) => c.role === "review")!;
    expect(review.prompt).toContain("may not run shell commands");
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
