import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/agents/cursor.js";
import type { Job } from "../src/jobs/store.js";
import { parseCursorOutput } from "../src/lib/cursor-output-parser.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "cursor",
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

// The documented shape of `cursor-agent -p --output-format stream-json`; never run against the real CLI.
const RUN = jsonl(
  { type: "system", subtype: "init", model: "Claude 4 Sonnet", session_id: "chat-1" },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Checking." }] },
  },
  {
    type: "tool_call",
    subtype: "started",
    tool_call: { shellToolCall: { args: { command: "git status" } } },
  },
  { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { args: {} } } },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Clean." }] },
  },
  { type: "result", subtype: "success", is_error: false, result: "Clean.", session_id: "chat-1" },
);

describe("parseCursorOutput", () => {
  it("takes the result text, the session id and the model", () => {
    expect(parseCursorOutput(RUN, 0)).toEqual({
      resultText: "Clean.",
      sessionId: "chat-1",
      errors: [],
      completed: true,
      usage: { model: "Claude 4 Sonnet" },
    });
  });

  it("reports an is_error result as an error with no answer", () => {
    const r = parseCursorOutput(
      jsonl({ type: "result", subtype: "error", is_error: true, result: "not logged in" }),
      1,
    );
    expect(r.errors).toEqual(["not logged in"]);
    expect(r.resultText).toBe("");
  });

  it("keeps the last assistant text of a cut stream as partial", () => {
    const r = parseCursorOutput(
      jsonl({ type: "assistant", message: { content: [{ type: "text", text: "half" }] } }),
      1,
    );
    expect(r).toMatchObject({ resultText: "half", partial: true, completed: false });
  });
});

describe("cursorAdapter", () => {
  it("runs a read-only job in ask mode without --force", () => {
    const { command, args } = cursorAdapter.buildInvocation(job());
    expect(command).toBe("/nonexistent/agentmate-test/cursor-agent");
    expect(args).toEqual(["-p", "the prompt", "--output-format", "stream-json", "--mode", "ask"]);
  });

  it("applies changes with --force in a write job", () => {
    const { args } = cursorAdapter.buildInvocation(job({ mode: "write", model: "sonnet-4" }));
    expect(args).toEqual(expect.arrayContaining(["--force", "--model", "sonnet-4"]));
    expect(args).not.toContain("ask");
  });

  it("refuses effort and claims no resume", () => {
    expect(cursorAdapter.effortError?.({ effort: "high", model: undefined })).toMatch(
      /no reasoning effort/,
    );
    expect(cursorAdapter.capabilities.resume).toBe(false);
  });

  it("maps messages, shell calls and ignores completions", () => {
    const events = RUN.split("\n").flatMap((line) => cursorAdapter.parseStreamLine!(line));
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["message", "Checking."],
      ["command", "git status"],
      ["message", "Clean."],
    ]);
  });
});
