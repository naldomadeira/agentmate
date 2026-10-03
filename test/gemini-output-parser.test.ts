import { describe, expect, it } from "vitest";
import { parseGeminiOutput } from "../src/lib/gemini-output-parser.js";

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("parseGeminiOutput", () => {
  it("reads the single JSON object of --output-format json", () => {
    const out = JSON.stringify({ session_id: "s-1", response: "All good", stats: { models: {} } });
    expect(parseGeminiOutput(out)).toEqual({
      resultText: "All good",
      sessionId: "s-1",
      errors: [],
    });
  });

  it("reports the error of the single JSON object", () => {
    const out = JSON.stringify({ error: { type: "ApiError", message: "bad key", code: 401 } });
    const parsed = parseGeminiOutput(out);
    expect(parsed.resultText).toBe("");
    expect(parsed.errors).toEqual(["ApiError: bad key"]);
  });

  it("keeps a response next to a warning-level error object", () => {
    const parsed = parseGeminiOutput(
      JSON.stringify({ response: "partial answer", error: { message: "slow" } }),
    );
    expect(parsed.resultText).toBe("partial answer");
    expect(parsed.errors).toEqual(["slow"]);
  });

  it("concatenates assistant chunks of a stream and takes the session from init", () => {
    const out = lines(
      { type: "init", session_id: "g-7", model: "gemini-2.5-pro" },
      { type: "message", role: "user", content: "question" },
      { type: "message", role: "assistant", content: "Hel", delta: true },
      { type: "tool_use", name: "run_shell_command", args: { command: "ls" } },
      { type: "tool_result", output: "a" },
      { type: "message", role: "assistant", content: "lo", delta: true },
      { type: "result", status: "success", stats: {} },
    );
    expect(parseGeminiOutput(out)).toEqual({ resultText: "Hello", sessionId: "g-7", errors: [] });
  });

  it("prefers result.response over the chunks", () => {
    const out = lines(
      { type: "init", session_id: "g-1" },
      { type: "message", role: "assistant", content: "draft" },
      { type: "result", response: "final answer" },
    );
    expect(parseGeminiOutput(out).resultText).toBe("final answer");
  });

  it("tolerates text, delta and parts as the chunk field", () => {
    const out = lines(
      { type: "message", role: "assistant", text: "a" },
      { type: "message", role: "assistant", delta: "b" },
      { type: "message", role: "model", content: [{ text: "c" }, { text: "d" }] },
      { type: "message", content: "e" },
      { type: "result" },
    );
    expect(parseGeminiOutput(out).resultText).toBe("abcde");
  });

  it("separates complete (non-delta) messages", () => {
    const out = lines(
      { type: "message", role: "assistant", content: "one", delta: false },
      { type: "message", role: "assistant", content: "two", delta: false },
      { type: "result" },
    );
    expect(parseGeminiOutput(out).resultText).toBe("one\n\ntwo");
  });

  it("flags a stream without a result as partial", () => {
    const out = lines(
      { type: "init", session_id: "g-2" },
      { type: "message", role: "assistant", content: "Half an answ" },
    );
    expect(parseGeminiOutput(out)).toEqual({
      resultText: "Half an answ",
      sessionId: "g-2",
      errors: [],
      partial: true,
    });
  });

  it("returns an empty, non-partial result for a stream with nothing said", () => {
    const parsed = parseGeminiOutput(lines({ type: "init", session_id: "g-3" }));
    expect(parsed.resultText).toBe("");
    expect(parsed.partial).toBeUndefined();
    expect(parsed.sessionId).toBe("g-3");
  });

  it("collects error events and an error result without text", () => {
    const out = lines(
      { type: "init", session_id: "g-4" },
      { type: "error", message: "rate limited" },
      { type: "result", status: "error", error: { type: "Quota", message: "daily limit" } },
    );
    const parsed = parseGeminiOutput(out);
    expect(parsed.resultText).toBe("");
    expect(parsed.errors).toEqual(["rate limited", "Quota: daily limit"]);
  });

  it("keeps the streamed text when only a non-fatal error was reported", () => {
    const out = lines(
      { type: "message", role: "assistant", content: "done anyway" },
      { type: "error", message: "tool warning" },
      { type: "result", status: "success" },
    );
    const parsed = parseGeminiOutput(out);
    expect(parsed.resultText).toBe("done anyway");
    expect(parsed.errors).toEqual(["tool warning"]);
  });

  it("skips stray non-JSON lines in a stream", () => {
    const out = `Loaded cached credentials.\n${lines(
      { type: "message", role: "assistant", content: "ok" },
      { type: "result" },
    )}\nbye`;
    expect(parseGeminiOutput(out).resultText).toBe("ok");
  });

  it("treats a lone result event like a stream", () => {
    expect(parseGeminiOutput(JSON.stringify({ type: "result", response: "x" })).resultText).toBe(
      "x",
    );
  });

  it("falls back to raw text for non-JSON output and flags empty output", () => {
    expect(parseGeminiOutput("just text\n").resultText).toBe("just text");
    expect(parseGeminiOutput("  \n").errors).toEqual(["Empty output from Gemini CLI"]);
  });
});
