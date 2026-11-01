import { describe, expect, it } from "vitest";
import { grokAdapter } from "../src/agents/grok.js";
import type { Job } from "../src/jobs/store.js";
import { parseGrokOutput } from "../src/lib/grok-output-parser.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "grok",
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

// The shape of a real `grok -p --output-format streaming-json` run (1.0.70), trimmed.
const RUN = jsonl(
  { type: "thought", data: "I will read a.txt" },
  { type: "text", data: "I'll read" },
  { type: "text", data: " it." },
  { type: "usage", usage: { input_tokens: 1 }, signature: "x" },
  {
    type: "tool_call",
    toolCallId: "c-0",
    toolName: "read_file",
    rawInput: { target_file: "/tmp/a.txt" },
  },
  { type: "tool_call_update", toolCallId: "c-0", status: "completed" },
  { type: "text", data: "h" },
  { type: "text", data: "i" },
  {
    type: "end",
    stopReason: "end_turn",
    sessionId: "01a194e2",
    usage: {
      input_tokens: 18515,
      output_tokens: 187,
      reasoning_tokens: 107,
      cache_read_input_tokens: 39040,
    },
    total_cost_usd: 0.057672,
    modelUsage: { "grok-4.7-build": { inputTokens: 18515 } },
  },
);

describe("parseGrokOutput", () => {
  it("takes the text after the last tool call, the session id and the usage", () => {
    expect(parseGrokOutput(RUN, 0)).toEqual({
      resultText: "hi",
      sessionId: "01a194e2",
      errors: [],
      completed: true,
      usage: {
        model: "grok-4.7-build",
        inputTokens: 18515,
        outputTokens: 187,
        reasoningTokens: 107,
        cachedInputTokens: 39040,
        costUsd: 0.057672,
      },
    });
  });

  it("keeps text from a stream cut off before its end as partial", () => {
    const r = parseGrokOutput(jsonl({ type: "text", data: "half" }), 1);
    expect(r).toMatchObject({ resultText: "half", partial: true, completed: false });
    expect(r.errors).toEqual(["grok exited 1 without a final result"]);
  });

  it("reports plain text before any JSON as the error", () => {
    const r = parseGrokOutput("Error: not logged in", 1);
    expect(r.resultText).toBe("");
    expect(r.errors).toEqual(["Error: not logged in"]);
  });

  it("reports error events and a failed stop reason", () => {
    const r = parseGrokOutput(
      jsonl(
        { type: "error", message: "boom" },
        { type: "end", stopReason: "refusal", sessionId: "s" },
      ),
      0,
    );
    expect(r.errors).toEqual(["boom", "grok stopped: refusal"]);
  });
});

describe("grokAdapter", () => {
  it("denies write and shell tools in a read-only job", () => {
    const { args } = grokAdapter.buildInvocation(job());
    expect(args.slice(0, 4)).toEqual(["-p", "the prompt", "--output-format", "streaming-json"]);
    expect(args).toContain(
      "--disallowed-tools=write,search_replace,run_terminal_command,image_edit",
    );
    expect(args).not.toContain("--always-approve");
  });

  it("approves everything in a write job and passes model, effort and resume", () => {
    const { args } = grokAdapter.buildInvocation(
      job({ mode: "write", model: "grok-4.7", effort: "high" }),
      "sess-1",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--always-approve",
        "--model",
        "grok-4.7",
        "--reasoning-effort",
        "high",
        "--resume",
        "sess-1",
      ]),
    );
    expect(args.some((a) => a.startsWith("--disallowed-tools"))).toBe(false);
  });

  it("guards a prompt that starts with a dash", () => {
    expect(grokAdapter.buildInvocation(job({ prompt: "--x" })).args[1]).toBe(" --x");
  });

  it("batches text into one message per segment and maps tool calls", () => {
    grokAdapter.resetStream?.();
    const events = RUN.split("\n").flatMap((line) => grokAdapter.parseStreamLine!(line));
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["message", "I'll read it."],
      ["command", "read_file"],
      ["message", "hi"],
    ]);
  });

  it("turns a shell call and a file edit into command and file events", () => {
    grokAdapter.resetStream?.();
    const shell = grokAdapter.parseStreamLine!(
      jsonl({
        type: "tool_call",
        toolName: "run_terminal_command",
        rawInput: { command: "pnpm test" },
      }),
    );
    expect(shell[0]).toMatchObject({ kind: "command", text: "pnpm test" });
    const edit = grokAdapter.parseStreamLine!(
      jsonl({ type: "tool_call", toolName: "write", rawInput: { target_file: "/tmp/x.ts" } }),
    );
    expect(edit[0]).toMatchObject({ kind: "file", data: { path: "/tmp/x.ts", kind: "write" } });
  });

  it("is resumable, offers no shell to read-only jobs and takes effort", () => {
    expect(grokAdapter.capabilities).toMatchObject({ resume: true, shell: false, write: true });
    expect(grokAdapter.effortError?.({ effort: "high", model: undefined })).toBeNull();
  });
});
