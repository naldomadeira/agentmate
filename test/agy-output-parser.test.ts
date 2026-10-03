import { describe, expect, it } from "vitest";
import { parseAgyOutput } from "../src/lib/agy-output-parser.js";

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const step = (extra: Record<string, unknown>) => ({
  event: "step_update",
  step_update: { conversation_id: "c-1", step_index: 0, state: "DONE", ...extra },
});

describe("parseAgyOutput", () => {
  it("reads the single JSON object of --output-format json", () => {
    const out = JSON.stringify({ status: "SUCCESS", response: "All good", conversation_id: "c-9" });
    expect(parseAgyOutput(out, 0)).toEqual({
      resultText: "All good",
      sessionId: "c-9",
      errors: [],
      completed: true,
    });
  });

  it("starts at the first brace when a banner precedes the single JSON object", () => {
    const out = `agy 1.2.6 starting...\nloaded profile\n${JSON.stringify({ status: "SUCCESS", response: "ok", conversation_id: "c-2" })}\n`;
    const parsed = parseAgyOutput(out, 0);
    expect(parsed).toMatchObject({ resultText: "ok", sessionId: "c-2", completed: true });
    expect(parsed.errors).toEqual([]);
  });

  it("reads a pretty-printed single object after banner noise", () => {
    const out = `banner\n${JSON.stringify({ status: "SUCCESS", response: "multi\nline", conversation_id: "c-3" }, null, 2)}`;
    expect(parseAgyOutput(out, 0)).toMatchObject({
      resultText: "multi\nline",
      sessionId: "c-3",
      completed: true,
    });
  });

  it("reads the result event of a stream, with the conversation id from the init event", () => {
    const out = lines(
      { event: "init", init: { conversation_id: "c-7", model: "gemini-test" } },
      step({
        step_index: 0,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "ls" } },
      }),
      step({ step_index: 1, step_type: "agent_response", text_delta: "Hel", state: "ACTIVE" }),
      step({ step_index: 1, step_type: "agent_response", text_delta: "lo", state: "DONE" }),
      { event: "result", result: { status: "SUCCESS", response: "Hello", conversation_id: "c-7" } },
    );
    expect(parseAgyOutput(out, 0)).toEqual({
      resultText: "Hello",
      sessionId: "c-7",
      errors: [],
      completed: true,
    });
  });

  it("tolerates banner lines and a conversation id on the step updates only", () => {
    const out = `warming up\n${lines(
      step({ step_index: 0, step_type: "agent_response", text_delta: "partial words" }),
    )}\n`;
    const parsed = parseAgyOutput(out, 1);
    expect(parsed.sessionId).toBe("c-1");
    expect(parsed.completed).toBe(false);
  });

  it("falls back to the streamed text when the result has no response", () => {
    const out = lines(
      step({ step_index: 2, step_type: "agent_response", text_delta: "streamed answer" }),
      { event: "result", result: { status: "SUCCESS", conversation_id: "c-1" } },
    );
    expect(parseAgyOutput(out, 0)).toMatchObject({
      resultText: "streamed answer",
      completed: true,
      errors: [],
    });
  });

  it("returns the streamed text as partial when the stream has no result", () => {
    const out = lines(
      step({ step_index: 1, step_type: "agent_response", text_delta: "first " }),
      step({ step_index: 1, step_type: "agent_response", text_delta: "half" }),
    );
    const parsed = parseAgyOutput(out, 1);
    expect(parsed).toMatchObject({ resultText: "first half", partial: true, completed: false });
    expect(parsed.errors).toEqual(["agy exited 1 without a final result"]);
  });

  it("reports a failed result and keeps its text as partial", () => {
    const out = lines({
      event: "result",
      result: {
        status: "ERROR",
        response: "half an answer",
        error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h1m13s",
        conversation_id: "c-4",
      },
    });
    const parsed = parseAgyOutput(out, 1);
    expect(parsed.errors).toEqual([
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h1m13s",
    ]);
    expect(parsed).toMatchObject({ resultText: "half an answer", partial: true, completed: true });
    expect(parsed.sessionId).toBe("c-4");
  });

  it("reports a non-success status without an error message", () => {
    const parsed = parseAgyOutput(JSON.stringify({ status: "TIMEOUT", conversation_id: "c-5" }), 0);
    expect(parsed.errors).toEqual(["agy reported status TIMEOUT"]);
    expect(parsed.resultText).toBe("");
    expect(parsed.sessionId).toBe("c-5");
  });

  it("reads an error object", () => {
    const parsed = parseAgyOutput(
      JSON.stringify({ status: "ERROR", error: { type: "ApiError", message: "bad key" } }),
      1,
    );
    expect(parsed.errors).toEqual(["ApiError: bad key"]);
  });

  it("reports empty output and output that holds no JSON", () => {
    expect(parseAgyOutput("  \n", 1).errors).toEqual(["Empty output from agy"]);
    const plain = parseAgyOutput("something went wrong\nnot json", 1);
    expect(plain.resultText).toBe("");
    expect(plain.completed).toBe(false);
    expect(plain.errors[0]).toContain("agy did not return parseable JSON (exit 1)");
    expect(plain.errors[0]).toContain("something went wrong");
  });

  it("ignores lines that are not events and non-object results", () => {
    const out = lines({ event: "result", result: "oops" }, "not an object", {
      event: "mystery",
      mystery: { conversation_id: "c-8" },
    });
    const parsed = parseAgyOutput(out, 0);
    expect(parsed.completed).toBe(false);
    expect(parsed.sessionId).toBe("c-8");
    expect(parsed.errors).toEqual(["agy ended without a final result"]);
    expect(parsed.partial).toBeUndefined();
  });
});
