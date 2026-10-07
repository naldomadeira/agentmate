import { describe, it, expect } from "vitest";
import { parseClaudeOutput } from "../src/lib/claude-output-parser.js";

describe("parseClaudeOutput", () => {
  it("parses result as string", () => {
    const json = JSON.stringify({
      result: "The answer is 42.",
      session_id: "s-123",
    });

    const result = parseClaudeOutput(json);
    expect(result.resultText).toBe("The answer is 42.");
    expect(result.sessionId).toBe("s-123");
    expect(result.errors).toHaveLength(0);
  });

  it("parses result with content array", () => {
    const json = JSON.stringify({
      result: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      },
    });

    const result = parseClaudeOutput(json);
    expect(result.resultText).toBe("Hello \nWorld");
  });

  it("falls back to raw text when JSON parsing fails", () => {
    const result = parseClaudeOutput("This is plain text output");
    expect(result.resultText).toBe("This is plain text output");
    expect(result.errors).toHaveLength(0);
  });

  it("handles empty output", () => {
    const result = parseClaudeOutput("");
    expect(result.resultText).toBe("");
    expect(result.errors).toContain("Empty output from Claude CLI");
  });

  it("extracts error field", () => {
    const json = JSON.stringify({
      error: "Authentication failed",
      result: "",
    });

    const result = parseClaudeOutput(json);
    expect(result.errors).toContain("Authentication failed");
  });

  it("extracts cost_usd", () => {
    const json = JSON.stringify({
      result: "Done",
      cost_usd: 0.05,
    });

    const result = parseClaudeOutput(json);
    expect(result.usage?.costUsd).toBe(0.05);
  });

  it("handles nested error object", () => {
    const json = JSON.stringify({
      error: { message: "Rate limit exceeded", code: 429 },
    });

    const result = parseClaudeOutput(json);
    expect(result.errors).toContain("Rate limit exceeded");
  });

  it("stringifies response when no result field found", () => {
    const json = JSON.stringify({ data: "some unexpected format" });

    const result = parseClaudeOutput(json);
    expect(result.resultText).toContain("some unexpected format");
  });
});

// Condensed from a real `claude -p --output-format stream-json --verbose` capture.
const STREAM = [
  { type: "active_goal", value: null, session_id: "s-real" },
  { type: "system", subtype: "init", session_id: "s-real", tools: ["Bash", "Read"] },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    },
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] },
  },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hello." }] },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Hello.",
    session_id: "s-real",
    total_cost_usd: 0.0448268,
  },
  { type: "system", subtype: "task_summary", detail: null },
];
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("parseClaudeOutput (stream-json)", () => {
  it("reads the last result event, ignoring lines after it", () => {
    const result = parseClaudeOutput(jsonl(STREAM));
    expect(result.resultText).toBe("Hello.");
    expect(result.sessionId).toBe("s-real");
    expect(result.usage?.costUsd).toBe(0.0448268);
    expect(result.errors).toEqual([]);
  });

  it("falls back to the last assistant message text when the result has no text", () => {
    const events = STREAM.map((event) =>
      (event as { type: string }).type === "result"
        ? { type: "result", subtype: "success", is_error: false, session_id: "s-real" }
        : event,
    );
    events.splice(5, 0, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part one. " },
          { type: "tool_use", name: "Read", input: {} },
          { type: "text", text: "Part two." },
        ],
      },
    });
    const result = parseClaudeOutput(jsonl(events));
    expect(result.resultText).toBe("Hello.");
    const only = parseClaudeOutput(
      jsonl([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Part one. " },
              { type: "text", text: "Part two." },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false },
      ]),
    );
    expect(only.resultText).toBe("Part one. Part two.");
  });

  it("reports an error result as an error and leaves the text empty", () => {
    const result = parseClaudeOutput(
      jsonl([
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "partial" }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "You've hit your usage limit.",
          session_id: "s-2",
        },
      ]),
    );
    expect(result.resultText).toBe("");
    expect(result.errors).toEqual(["You've hit your usage limit."]);
    expect(result.sessionId).toBe("s-2");
    const noText = parseClaudeOutput(
      jsonl([{ type: "result", subtype: "error_max_turns", is_error: true }]),
    );
    expect(noText.errors).toEqual(["error_max_turns"]);
    expect(noText.resultText).toBe("");
  });

  it("returns the last assistant text as partial output when the stream has no result event", () => {
    const cut = parseClaudeOutput(
      jsonl([
        { type: "system", subtype: "init", session_id: "s-cut" },
        { type: "assistant", message: { content: [{ type: "text", text: "First thought." }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Half an answ" }] } },
      ]),
    );
    expect(cut).toMatchObject({
      resultText: "Half an answ",
      sessionId: "s-cut",
      partial: true,
      errors: [],
    });
    const none = parseClaudeOutput(jsonl([{ type: "system", subtype: "init" }]));
    expect(none.resultText).toBe("");
    expect(none.partial).toBeUndefined();
    // a stream that ends properly is never partial
    expect(parseClaudeOutput(jsonl(STREAM)).partial).toBeUndefined();
  });

  it("still accepts a single legacy JSON object", () => {
    const result = parseClaudeOutput(
      JSON.stringify({ type: "result", result: "ok", session_id: "s" }),
    );
    expect(result).toMatchObject({ resultText: "ok", sessionId: "s" });
  });

  it("keeps stray non-JSON lines from breaking a stream", () => {
    const result = parseClaudeOutput(`warning: something\n${jsonl(STREAM)}\n`);
    expect(result.resultText).toBe("Hello.");
  });
});
