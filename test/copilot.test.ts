import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copilotAdapter, copilotAllowedTools } from "../src/agents/copilot.js";
import { readResult, startJob, summarize, waitJob } from "../src/jobs/api.js";
import { readEvents } from "../src/jobs/events.js";
import { detectQuotaExhaustion } from "../src/jobs/quota.js";
import { type Job } from "../src/jobs/store.js";
import { parseCopilotOutput } from "../src/lib/copilot-output-parser.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "copilot",
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

const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

// The shape of a real `copilot -p --output-format json` run (1.0.93), trimmed to what is read.
const RUN = jsonl(
  { type: "session.auto_mode_resolved", data: { chosenModel: "gpt-5.6-luna" } },
  { type: "assistant.message_delta", data: { deltaContent: "Bra" }, ephemeral: true },
  {
    type: "assistant.message",
    data: { model: "gpt-5.6-luna", content: "", toolRequests: [{ name: "bash" }] },
  },
  {
    type: "tool.execution_start",
    data: { toolName: "bash", arguments: { command: "git status --short --branch" } },
  },
  { type: "assistant.message", data: { model: "gpt-5.6-luna", content: "Branch: main" } },
  {
    type: "result",
    sessionId: "bd23254f-e28c-482a-b282-b9ff16931206",
    exitCode: 0,
    usage: { premiumRequests: 1, totalApiDurationMs: 1150 },
  },
);

describe("parseCopilotOutput", () => {
  it("takes the last assistant text, the session id and the usage", () => {
    expect(parseCopilotOutput(RUN, 0)).toEqual({
      resultText: "Branch: main",
      sessionId: "bd23254f-e28c-482a-b282-b9ff16931206",
      errors: [],
      completed: true,
      usage: { model: "gpt-5.6-luna", premiumRequests: 1 },
    });
  });

  it("keeps the last text of a stream cut off before its result as partial", () => {
    const cut = jsonl({ type: "assistant.message", data: { content: "Half" } });
    expect(parseCopilotOutput(cut, 1)).toMatchObject({
      resultText: "Half",
      partial: true,
      completed: false,
    });
  });

  it("reports a plain error line, such as an unavailable model", () => {
    const r = parseCopilotOutput('Error: Model "x" from --model flag is not available.', 1);
    expect(r.resultText).toBe("");
    expect(r.errors).toEqual(['Error: Model "x" from --model flag is not available.']);
  });

  it("collects error events and a non-zero result exit code", () => {
    const r = parseCopilotOutput(
      jsonl(
        { type: "session.error", data: { message: "boom" } },
        { type: "result", sessionId: "s", exitCode: 1 },
      ),
      1,
    );
    expect(r.errors).toEqual(["boom", "copilot reported exit code 1"]);
  });
});

describe("copilot buildInvocation", () => {
  const flags = (j: Job, resume?: string) => copilotAdapter.buildInvocation(j, resume).args;

  it("runs headless with JSONL, no built-in MCPs or personal skills, git reads only", () => {
    expect(flags(job())).toEqual([
      "-p",
      "the prompt",
      "--output-format",
      "json",
      "--no-auto-update",
      "--disable-builtin-mcps",
      "--excluded-tools=skill",
      "--allow-tool=shell(git diff)",
      "--allow-tool=shell(git log)",
      "--allow-tool=shell(git show)",
      "--allow-tool=shell(git status)",
      "--deny-tool=write",
    ]);
  });

  it("keeps the MCPs and skills with AGENTMATE_COPILOT_INHERIT=1", () => {
    process.env["AGENTMATE_COPILOT_INHERIT"] = "1";
    try {
      expect(flags(job())).not.toContain("--disable-builtin-mcps");
    } finally {
      delete process.env["AGENTMATE_COPILOT_INHERIT"];
    }
  });

  it("passes model, effort and the session to resume", () => {
    const args = flags(job({ model: "gpt-6.1-sol", effort: "high" }), "s-1");
    expect(args).toContain("--resume=s-1");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "gpt-6.1-sol",
    ]);
    expect(args.slice(args.indexOf("--reasoning-effort"))[1]).toBe("high");
  });

  it("lets a write job edit and verify, without the read-only deny", () => {
    const args = flags(job({ mode: "write", role: "implement" }));
    expect(args).toContain("--allow-tool=write");
    expect(args).toContain("--allow-tool=shell(pnpm:*)");
    expect(args).toContain("--allow-tool=shell(git commit)");
    expect(args).not.toContain("--deny-tool=write");
  });

  it("extends the write tools with AGENTMATE_COPILOT_WRITE_TOOLS", () => {
    process.env["AGENTMATE_COPILOT_WRITE_TOOLS"] = "shell(cargo:*), shell(go:*)";
    try {
      expect(copilotAllowedTools(job({ mode: "write" }))).toEqual(
        expect.arrayContaining(["shell(cargo:*)", "shell(go:*)"]),
      );
    } finally {
      delete process.env["AGENTMATE_COPILOT_WRITE_TOOLS"];
    }
  });

  it("gives a review with allowCommands the whole shell, still denying file writes", () => {
    const args = flags(job({ role: "review", allowCommands: true }));
    expect(args).toContain("--allow-tool=shell");
    expect(args).toContain("--deny-tool=write");
  });

  it("lets a team lead run the AgentMate CLI", () => {
    expect(copilotAllowedTools(job({ role: "teamlead" }))).toEqual(
      expect.arrayContaining(["shell(agentmate:*)", "shell(npx:*)"]),
    );
  });

  it("prefixes a prompt that starts with a dash", () => {
    expect(flags(job({ prompt: "-x" }))[1]).toBe(" -x");
  });
});

describe("copilot effort", () => {
  it("needs a model other than auto", () => {
    expect(copilotAdapter.effortError?.({ effort: "high" })).toMatch(/auto model takes no/);
    expect(copilotAdapter.effortError?.({ effort: "high", model: "auto" })).toMatch(/auto/);
    expect(copilotAdapter.effortError?.({ effort: "high", model: "gpt-6.1-sol" })).toBeNull();
  });
});

describe("copilot stream events", () => {
  const parse = (e: unknown) => copilotAdapter.parseStreamLine!(JSON.stringify(e));

  it("turns messages, commands, file edits and errors into events", () => {
    expect(parse({ type: "assistant.message", data: { content: "hi" } })[0]).toMatchObject({
      level: "important",
      kind: "message",
      text: "hi",
    });
    expect(
      parse({
        type: "tool.execution_start",
        data: { toolName: "bash", arguments: { command: "ls" } },
      })[0],
    ).toMatchObject({ level: "fyi", kind: "command", text: "ls" });
    expect(
      parse({
        type: "tool.execution_start",
        data: { toolName: "edit", arguments: { path: "a.ts" } },
      })[0],
    ).toMatchObject({ level: "status", kind: "file", data: { path: "a.ts", kind: "edit" } });
    expect(parse({ type: "session.error", data: { message: "bad" } })[0]).toMatchObject({
      level: "important",
      kind: "error",
      text: "bad",
    });
  });

  it("skips deltas, empty messages and telemetry", () => {
    expect(parse({ type: "assistant.message_delta", data: { deltaContent: "x" } })).toEqual([]);
    expect(parse({ type: "assistant.message", data: { content: "" } })).toEqual([]);
    expect(parse({ type: "session.usage_checkpoint", data: {} })).toEqual([]);
    expect(copilotAdapter.parseStreamLine!("not json")).toEqual([]);
  });
});

describe("copilot quota", () => {
  it("recognizes a spent premium request allowance, also when it names GitHub Copilot", () => {
    expect(
      detectQuotaExhaustion(
        "You have reached your monthly premium request limit for GitHub Copilot.",
        [],
        "",
      ),
    ).not.toBeNull();
    expect(
      detectQuotaExhaustion("Premium requests quota exceeded for this month.", [], ""),
    ).not.toBeNull();
  });

  it("still ignores a GitHub API rate limit", () => {
    expect(
      detectQuotaExhaustion("GitHub API rate limit exceeded, resets at 6pm", [], ""),
    ).toBeNull();
  });
});

// A stand-in for the copilot CLI: prints a real-shaped JSONL run, with the argv as the answer.
const FAKE_COPILOT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const emit = (e) => console.log(JSON.stringify(e));
emit({ type: "session.auto_mode_resolved", data: { chosenModel: "gpt-5.6-luna" } });
emit({ type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "git status" } } });
emit({ type: "assistant.message", data: { model: "gpt-5.6-luna", content: "args=" + args.join(" ") } });
emit({ type: "result", sessionId: "s-fake", exitCode: 0, usage: { premiumRequests: 1 } });
`;

describe("a copilot job", () => {
  let home: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-copilot-"));
    const bin = path.join(home, "fake-copilot");
    fs.writeFileSync(bin, FAKE_COPILOT, { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = home;
    process.env["AGENTMATE_COPILOT_BIN"] = bin;
    delete process.env["AGENTMATE_DEPTH"];
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("runs to done with the answer, the session, the usage and the events", async () => {
    const started = startJob({ provider: "copilot", role: "ask", prompt: "q", cwd: home });
    const done = await waitJob(started.id, 20_000);
    expect(done.status).toBe("done");
    expect(done.sessionId).toBe("s-fake");
    expect(done.usage).toEqual({ model: "gpt-5.6-luna", premiumRequests: 1 });
    expect(summarize(done)).toContain("ran gpt-5.6-luna · 1 premium request");
    expect(readResult(started.id).text).toContain("--deny-tool=write");
    const kinds = readEvents(started.id, { levels: ["important", "status", "fyi"] }).map(
      (e) => e.kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(["started", "command", "message", "finished"]));
  });

  it("continues the session with --resume", async () => {
    const first = await waitJob(
      startJob({ provider: "copilot", prompt: "a", cwd: home }).id,
      20_000,
    );
    const next = startJob({ provider: "copilot", prompt: "b", continueJob: first.id, cwd: home });
    await waitJob(next.id, 20_000);
    expect(readResult(next.id).text).toContain("--resume=s-fake");
  });

  it("refuses an effort without a model before writing the job", () => {
    expect(() => startJob({ provider: "copilot", prompt: "q", effort: "high", cwd: home })).toThrow(
      /auto model takes no reasoning effort/,
    );
  });
});
