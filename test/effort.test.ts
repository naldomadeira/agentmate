import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agyModelId, createAgyAdapter } from "../src/agents/agy.js";
import { claudeAdapter } from "../src/agents/claude.js";
import { codexAdapter } from "../src/agents/codex.js";
import { createGeminiAdapter } from "../src/agents/gemini.js";
import { startJob, summarize } from "../src/jobs/api.js";
import { renderList } from "../src/jobs/render.js";
import { writeJob, type Job } from "../src/jobs/store.js";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j-1",
  provider: "codex",
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

describe("codex effort", () => {
  it("adds no config override without an effort", () => {
    expect(codexAdapter.buildInvocation(job()).args).not.toContain("-c");
  });

  it("passes -c model_reasoning_effort on exec", () => {
    const { args } = codexAdapter.buildInvocation(job({ model: "gpt-x", effort: "high" }));
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-x",
      "-c",
      "model_reasoning_effort=high",
      "--sandbox",
      "read-only",
      "the prompt",
    ]);
  });

  it("keeps the override on exec resume", () => {
    const { args } = codexAdapter.buildInvocation(job({ effort: "xhigh" }), "t-9");
    expect(args).toEqual([
      "exec",
      "resume",
      "t-9",
      "--json",
      "-c",
      "model_reasoning_effort=xhigh",
      "the prompt",
    ]);
  });

  it("accepts every effort", () => {
    expect(codexAdapter.effortError?.({ effort: "xhigh" })).toBeNull();
  });
});

describe("claude effort", () => {
  it("passes --effort, and nothing without it", () => {
    const withEffort = claudeAdapter.buildInvocation(job({ provider: "claude", effort: "high" }));
    const at = withEffort.args.indexOf("--effort");
    expect(withEffort.args[at + 1]).toBe("high");
    expect(claudeAdapter.buildInvocation(job({ provider: "claude" })).args).not.toContain(
      "--effort",
    );
  });

  it("keeps --effort when resuming", () => {
    const { args } = claudeAdapter.buildInvocation(
      job({ provider: "claude", effort: "low" }),
      "s-1",
    );
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });
});

describe("agy effort", () => {
  const agy = createAgyAdapter();

  it("folds the effort into the model id", () => {
    expect(agyModelId("gemini-3.1-pro", "high")).toBe("gemini-3.1-pro-high");
    expect(agyModelId("gemini-3.8-flash-high", "medium")).toBe("gemini-3.8-flash-medium");
    expect(agyModelId("gemini-3.8-flash-low", undefined)).toBe("gemini-3.8-flash-low");
  });

  it("passes the combined id to --model, also when resuming", () => {
    const built = agy.buildInvocation(
      job({ provider: "agy", model: "gemini-3.1-pro", effort: "low" }),
    );
    expect(built.args[built.args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-low");
    const resumed = agy.buildInvocation(
      job({ provider: "agy", model: "gemini-3.1-pro-high", effort: "low" }),
      "conv-1",
    );
    expect(resumed.args[resumed.args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-low");
  });

  it("needs a model and refuses xhigh", () => {
    expect(agy.effortError?.({ effort: "high" })).toMatch(/needs a model/);
    expect(agy.effortError?.({ effort: "xhigh", model: "gemini-3.1-pro" })).toMatch(/not xhigh/);
    expect(agy.effortError?.({ effort: "medium", model: "gemini-3.8-flash" })).toBeNull();
  });
});

describe("gemini effort", () => {
  it("refuses an effort instead of dropping it", () => {
    const gemini = createGeminiAdapter();
    expect(gemini.effortError?.({ effort: "high" })).toMatch(/no reasoning effort/);
    expect(gemini.effortError?.({})).toBeNull();
  });
});

describe("startJob with effort", () => {
  let home: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-effort-"));
    // startJob only checks that the binary exists before refusing; nothing is run.
    const fake = path.join(home, "fake");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env["AGENTMATE_HOME"] = home;
    process.env["AGENTMATE_GEMINI_BIN"] = fake;
    process.env["AGENTMATE_AGY_BIN"] = fake;
    process.env["AGENTMATE_CODEX_BIN"] = fake;
    delete process.env["AGENTMATE_DEPTH"];
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses an effort gemini cannot apply, before writing a job", () => {
    expect(() =>
      startJob({ provider: "gemini", role: "ask", prompt: "q", effort: "high", cwd: home }),
    ).toThrow(/gemini has no reasoning effort/);
    expect(fs.existsSync(path.join(home, "jobs"))).toBe(false);
  });

  it("refuses an agy effort without a model", () => {
    expect(() =>
      startJob({ provider: "agy", role: "ask", prompt: "q", effort: "high", cwd: home }),
    ).toThrow(/needs a model/);
  });

  it("stores the effort and inherits it on continue", () => {
    const prior = job({
      id: "prior-1",
      status: "done",
      sessionId: "t-1",
      model: "gpt-x",
      effort: "high",
      cwd: home,
    });
    writeJob(prior);
    const next = startJob({
      provider: "codex",
      prompt: "go on",
      continueJob: "prior-1",
      cwd: home,
    });
    expect(next.effort).toBe("high");
    expect(next.model).toBe("gpt-x");
    const overridden = startJob({
      provider: "codex",
      prompt: "again",
      continueJob: "prior-1",
      effort: "low",
      cwd: home,
    });
    expect(overridden.effort).toBe("low");
  });
});

describe("effort in summaries", () => {
  it("shows the model and effort in the result header and the list", () => {
    const j = job({ model: "gpt-6.1-sol", effort: "high" });
    expect(summarize(j)).toContain("gpt-6.1-sol · high");
    expect(renderList([j])).toContain("gpt-6.1-sol·high");
    expect(summarize(job())).not.toContain("default model");
  });
});
