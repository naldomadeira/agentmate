import { describe, expect, it } from "vitest";
import { parseCodexOutput } from "../src/lib/codex-output-parser.js";
import { parseClaudeOutput } from "../src/lib/claude-output-parser.js";
import { parseAgyOutput } from "../src/lib/agy-output-parser.js";
import { summarize } from "../src/jobs/api.js";
import type { Job } from "../src/jobs/store.js";

describe("Usage extraction", () => {
  describe("Codex", () => {
    it("extracts model and sums tokens across turns", () => {
      const out = `{"type":"thread.started","model":"gpt-4"}\n{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50,"reasoning_output_tokens":10,"cached_input_tokens":20}}\n{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":30,"reasoning_output_tokens":5}}\n{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}`;
      const parsed = parseCodexOutput(out);
      expect(parsed.usage).toEqual({
        model: "gpt-4",
        inputTokens: 150,
        outputTokens: 80,
        reasoningTokens: 15,
        cachedInputTokens: 20,
      });
    });

    it("handles missing usage", () => {
      const out = `{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}`;
      const parsed = parseCodexOutput(out);
      expect(parsed.usage).toBeNull();
    });
  });

  describe("Claude", () => {
    it("extracts model, cost, and tokens from stream", () => {
      const out = `{"type":"system","subtype":"init","model":"claude-3-opus"}\n{"type":"result","result":"Done","session_id":"s-1","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"total_cost_usd":0.045}`;
      const parsed = parseClaudeOutput(out);
      expect(parsed.usage).toEqual({
        model: "claude-3-opus",
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 15,
        costUsd: 0.045,
      });
    });

    it("extracts main model from modelUsage if available", () => {
      const out = `{"type":"message_start"}\n{"type":"result","result":"Done","modelUsage":{"claude-3-sonnet":{"input_tokens":100,"output_tokens":50}}}`;
      const parsed = parseClaudeOutput(out);
      expect(parsed.usage?.model).toBe("claude-3-sonnet");
    });
  });

  describe("Agy", () => {
    it("extracts model from init event in stream", () => {
      const out = `{"event":"init","init":{"model":"gemini-test"}}\n{"event":"result","result":{"status":"SUCCESS","response":"Done"}}`;
      const parsed = parseAgyOutput(out, 0);
      expect(parsed.usage).toEqual({ model: "gemini-test" });
    });
  });

  describe("Summary rendering", () => {
    const baseJob: Job = {
      id: "j-123",
      provider: "codex",
      mode: "read-only",
      role: "review",
      depth: 0,
      prompt: "test",
      cwd: "/",
      timeoutMs: 10000,
      status: "done",
      createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
      startedAt: new Date("2024-01-01T00:00:00Z").toISOString(),
      finishedAt: new Date("2024-01-01T00:02:32Z").toISOString(), // 152s
    };

    it("renders without usage", () => {
      const job = { ...baseJob, model: "gpt-6.1-sol", effort: "high" } as Job;
      expect(summarize(job)).toBe(
        "job j-123 · codex/read-only · review · gpt-6.1-sol · high · done · 152s",
      );
    });

    it("renders with matching usage", () => {
      const job = {
        ...baseJob,
        model: "gpt-6.1-sol",
        effort: "high",
        usage: {
          model: "gpt-6.1-sol",
          inputTokens: 12300,
          outputTokens: 2100,
          reasoningTokens: 1000,
          costUsd: 0.04,
        },
      } as Job;
      expect(summarize(job)).toBe(
        "job j-123 · codex/read-only · review · ran gpt-6.1-sol · high · in 12.3k / out 2.1k / reasoning 1.0k tok · $0.04 · done · 152s",
      );
    });

    it("renders with mismatched usage model", () => {
      const job = {
        ...baseJob,
        model: "gpt-4",
        usage: { model: "gpt-6.1-sol", inputTokens: 500, outputTokens: 100 },
      } as Job;
      expect(summarize(job)).toBe(
        "job j-123 · codex/read-only · review · ran gpt-6.1-sol (asked gpt-4) · in 500 / out 100 tok · done · 152s",
      );
    });

    it("shows the model that ran when none was asked for", () => {
      const job = {
        ...baseJob,
        effort: "medium",
        usage: { model: "gpt-6.1-sol", inputTokens: 500 },
      } as Job;
      expect(summarize(job)).toBe(
        "job j-123 · codex/read-only · review · ran gpt-6.1-sol · medium · in 500 tok · done · 152s",
      );
    });
  });

  it("does not call an agy id with the effort folded in a mismatch", () => {
    const job = {
      id: "j-agy",
      provider: "agy",
      mode: "read-only",
      role: "ask",
      depth: 0,
      prompt: "q",
      cwd: "/",
      timeoutMs: 1000,
      status: "done",
      createdAt: new Date().toISOString(),
      model: "gemini-3.8-flash",
      effort: "low",
      usage: { model: "gemini-3.8-flash-low" },
    } as Job;
    expect(summarize(job)).toContain("ran gemini-3.8-flash-low · low");
    expect(summarize(job)).not.toContain("asked");
  });
});
