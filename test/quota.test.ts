import { afterEach, describe, expect, it } from "vitest";
import { detectQuotaExhaustion, quotaPatterns } from "../src/jobs/quota.js";

const saved = process.env["AGENTMATE_QUOTA_PATTERNS"];
afterEach(() => {
  if (saved === undefined) delete process.env["AGENTMATE_QUOTA_PATTERNS"];
  else process.env["AGENTMATE_QUOTA_PATTERNS"] = saved;
});

describe("detectQuotaExhaustion", () => {
  it.each([
    "You've hit your usage limit. Try again at 6pm.",
    "Claude AI usage limit reached|1759500000",
    "You've hit your limit · resets 6pm",
    "Error: insufficient_quota",
    "You exceeded your current quota, please check your plan",
    "Your account is out of credits",
    "Rate limit reached for requests; it will reset at 14:00",
    "rate limit hit, try again at 6pm",
    "Monthly quota exceeded",
    "weekly limit reached",
  ])("matches %s", (line) => {
    expect(detectQuotaExhaustion(line, [], "")).toBe(line);
  });

  it("matches in stderr, parsed errors and result text and returns the first matching line, trimmed", () => {
    expect(detectQuotaExhaustion("starting\n  usage limit hit \nmore", [], "")).toBe(
      "usage limit hit",
    );
    expect(detectQuotaExhaustion("", ["boom", "You have hit your limit."], "")).toBe(
      "You have hit your limit.",
    );
    expect(detectQuotaExhaustion("", [], "fine\nout of credits here")).toBe("out of credits here");
  });

  it("clips the line to 200 characters", () => {
    const found = detectQuotaExhaustion(`usage limit ${"x".repeat(400)}`, [], "");
    expect(found).toHaveLength(200);
  });

  it("does not treat a plain 429 or a transient rate limit as exhaustion", () => {
    expect(detectQuotaExhaustion("HTTP 429 Too Many Requests", [], "")).toBeNull();
    expect(
      detectQuotaExhaustion("429: rate limit exceeded", ["Request failed: 429"], ""),
    ).toBeNull();
    expect(detectQuotaExhaustion("too many requests, slow down", [], "")).toBeNull();
    expect(
      detectQuotaExhaustion("429 Rate limit reached for gpt-5. Please try again in 20s.", [], ""),
    ).toBeNull();
    expect(detectQuotaExhaustion("boom", [], "")).toBeNull();
    expect(detectQuotaExhaustion("", [], "")).toBeNull();
  });

  it("still matches a 429 that carries a reset or limit phrase", () => {
    expect(detectQuotaExhaustion("429 rate limit, try again at 6pm", [], "")).toBe(
      "429 rate limit, try again at 6pm",
    );
    expect(detectQuotaExhaustion("429 You exceeded your current quota", [], "")).not.toBeNull();
  });

  it("extends the defaults with AGENTMATE_QUOTA_PATTERNS", () => {
    expect(detectQuotaExhaustion("budget burned", [], "")).toBeNull();
    process.env["AGENTMATE_QUOTA_PATTERNS"] = "budget burned|plan cap \\d+";
    expect(detectQuotaExhaustion("budget burned", [], "")).toBe("budget burned");
    expect(detectQuotaExhaustion("Plan CAP 5 hit", [], "")).toBe("Plan CAP 5 hit");
    expect(detectQuotaExhaustion("usage limit", [], "")).toBe("usage limit");
  });

  it("ignores invalid and empty extra patterns", () => {
    process.env["AGENTMATE_QUOTA_PATTERNS"] = "(unclosed||  |valid thing";
    expect(() => quotaPatterns()).not.toThrow();
    expect(detectQuotaExhaustion("a valid thing happened", [], "")).toBe("a valid thing happened");
    expect(detectQuotaExhaustion("nothing", [], "")).toBeNull();
  });
});
