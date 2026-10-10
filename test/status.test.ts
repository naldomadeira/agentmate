import { describe, expect, it } from "vitest";
import { isFailedStatus, renderStatusLine, statusRunning } from "../src/jobs/render.js";
import type { Job } from "../src/jobs/store.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j",
  provider: "codex",
  mode: "read-only",
  role: "ask",
  depth: 0,
  prompt: "p",
  cwd: "/repo",
  timeoutMs: 1_000,
  status: "running",
  createdAt: new Date().toISOString(),
  ...extra,
});

describe("jobs list status rendering", () => {
  it("counts error, timeout and quota_exhausted as failures, nothing else", () => {
    expect(
      ["error", "timeout", "quota_exhausted"].every((s) => isFailedStatus(s as Job["status"])),
    ).toBe(true);
    expect(
      ["done", "canceled", "running", undefined].some((s) => isFailedStatus(s as Job["status"])),
    ).toBe(false);
  });

  it("uses the effective model when present and shortens status-bar model names", () => {
    expect(statusRunning(job({ usage: { model: "gpt-5.6-terra" } })).model).toBe("terra");
    expect(statusRunning(job({ model: "claude-sonnet-4-6" })).model).toBe("sonnet");
    expect(statusRunning(job({ model: "abcdefghijk" })).model).toBe("abcdefghi…");
  });

  it("shortens model families by pattern, not by a fixed list", () => {
    expect(statusRunning(job({ model: "gpt-6.1-sol" })).model).toBe("sol");
    expect(statusRunning(job({ model: "gpt-5.6-luna" })).model).toBe("luna");
    expect(statusRunning(job({ model: "claude-opus-4-6-thinking" })).model).toBe("opus");
    expect(statusRunning(job({ model: "gemini-3.1-pro-high" })).model).toBe("3.1-pro");
    expect(statusRunning(job({})).model).toBe("default");
  });

  it("renders compact durations, unread failures, and no idle line", () => {
    const running = [
      { id: "a", provider: "codex", model: "terra", elapsed_seconds: 45, cwd: "/repo" },
      { id: "b", provider: "claude", model: "sonnet", elapsed_seconds: 4 * 60, cwd: "/repo" },
      { id: "c", provider: "agy", model: "flash", elapsed_seconds: 72 * 60, cwd: "/repo" },
      { id: "d", provider: "gemini", model: "pro", elapsed_seconds: 1, cwd: "/repo" },
    ];
    expect(renderStatusLine(running, { total: 1, failed: 1 })).toBe(
      "mate ▶4 codex/terra 45s · claude/sonnet 4m · agy/flash 1h12m · ✓1 unread ✗1",
    );
    expect(renderStatusLine([], { total: 3, failed: 1 })).toBe("mate ✓3 unread ✗1");
    expect(renderStatusLine([], { total: 0, failed: 0 })).toBe("");
  });
});
