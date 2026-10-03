import { describe, it, expect } from "vitest";
import {
  buildAskPrompt,
  buildExplainCodePrompt,
  buildImplementPrompt,
  buildPlanPerfPrompt,
  buildPlanPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  buildTeamleadPrompt,
} from "../src/lib/prompt-builder.js";

describe("buildExplainCodePrompt", () => {
  it("builds a prompt with default depth", () => {
    const prompt = buildExplainCodePrompt({ target: "src/parser.rs" });
    expect(prompt).toContain("src/parser.rs");
    expect(prompt).toContain("detailed explanation");
    expect(prompt).toContain("Purpose");
    expect(prompt).toContain("Control Flow");
  });

  it("builds an overview prompt", () => {
    const prompt = buildExplainCodePrompt({
      target: "src/parser.rs",
      depth: "overview",
    });
    expect(prompt).toContain("high-level overview");
  });

  it("builds a trace prompt", () => {
    const prompt = buildExplainCodePrompt({
      target: "src/parser.rs",
      depth: "trace",
    });
    expect(prompt).toContain("execution trace");
  });

  it("includes context when provided", () => {
    const prompt = buildExplainCodePrompt({
      target: "src/parser.rs",
      context: "This is part of the oxc project",
    });
    expect(prompt).toContain("oxc project");
  });
});

describe("buildPlanPerfPrompt", () => {
  it("builds a prompt with default metrics", () => {
    const prompt = buildPlanPerfPrompt({ target: "src/transform.rs" });
    expect(prompt).toContain("src/transform.rs");
    expect(prompt).toContain("latency");
    expect(prompt).toContain("memory");
    expect(prompt).toContain("Hot Path");
    expect(prompt).toContain("Bottleneck");
    expect(prompt).toContain("Optimization Plan");
  });

  it("includes custom metrics", () => {
    const prompt = buildPlanPerfPrompt({
      target: "src/transform.rs",
      metrics: ["throughput", "binary-size"],
    });
    expect(prompt).toContain("throughput");
    expect(prompt).toContain("binary-size");
  });

  it("includes constraints", () => {
    const prompt = buildPlanPerfPrompt({
      target: "src/transform.rs",
      constraints: "Must not increase binary size",
    });
    expect(prompt).toContain("Must not increase binary size");
  });

  it("includes context", () => {
    const prompt = buildPlanPerfPrompt({
      target: "src/transform.rs",
      context: "This function is called 10M times per parse",
    });
    expect(prompt).toContain("10M times per parse");
  });
});

describe("buildAskPrompt", () => {
  it("asks for a short direct answer with code evidence", () => {
    const prompt = buildAskPrompt({ question: "Why is X slow?", context: "prod only" });
    expect(prompt).toContain("Why is X slow?");
    expect(prompt).toContain("prod only");
    expect(prompt).toContain("Answer");
    expect(prompt).toContain("Evidence");
  });
});

describe("buildReviewPrompt", () => {
  it("asks for severity-ordered findings and a verdict", () => {
    const prompt = buildReviewPrompt({ target: "main..HEAD", focus: "error handling" });
    expect(prompt).toContain("main..HEAD");
    expect(prompt).toContain("error handling");
    for (const heading of ["Findings", "Failure scenario", "Verdict", "approve", "request-changes"])
      expect(prompt).toContain(heading);
    expect(prompt).toContain("file:line");
    expect(prompt).toContain("Do not modify any files");
  });
});

describe("buildResearchPrompt", () => {
  it("lists the research output sections and the questions", () => {
    const prompt = buildResearchPrompt({
      topic: "SQLite vs DuckDB",
      questions: ["Which is faster?", "Which is smaller?"],
      scope: "embedded only",
    });
    expect(prompt).toContain("SQLite vs DuckDB");
    expect(prompt).toContain("Which is smaller?");
    expect(prompt).toContain("embedded only");
    for (const heading of ["Findings", "Options compared", "Recommendation", "Open questions"])
      expect(prompt).toContain(heading);
  });
});

describe("buildPlanPrompt", () => {
  it("creates a step-by-step plan by default", () => {
    const prompt = buildPlanPrompt({ goal: "Add caching", constraints: "no new deps" });
    expect(prompt).toContain("Add caching");
    expect(prompt).toContain("no new deps");
    for (const heading of ["Steps", "Files", "Risks", "Verification"])
      expect(prompt).toContain(heading);
  });

  it("critiques an existing plan instead of creating one", () => {
    const prompt = buildPlanPrompt({ goal: "Add caching", existingPlan: "1. do it" });
    expect(prompt).toContain("1. do it");
    expect(prompt).toContain("Critique");
    expect(prompt).toContain("Gaps");
    expect(prompt).toContain("Risks");
  });
});

describe("buildImplementPrompt", () => {
  it("asks to implement, verify, not commit, and report", () => {
    const prompt = buildImplementPrompt({ task: "Fix the bug", acceptance: "tests pass" });
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("tests pass");
    expect(prompt).toContain("Do not commit");
    expect(prompt).toContain("Files changed");
    expect(prompt).toContain("Verification");
  });
});

describe("buildTeamleadPrompt", () => {
  const base = {
    objective: "Migrate to ESM",
    provider: "codex" as const,
    otherProvider: "claude" as const,
    canWrite: true,
  };

  it("contains the CLI commands, the other provider and the report sections", () => {
    const prompt = buildTeamleadPrompt(base);
    expect(prompt).toContain("Migrate to ESM");
    expect(prompt).toContain(
      'npx -y agents-bridge-mcp jobs start claude "<complete briefing>" --role <ask|review|research|plan|implement>',
    );
    expect(prompt).toContain("npx -y agents-bridge-mcp jobs wait <id> --timeout 10m");
    expect(prompt).toContain("npx -y agents-bridge-mcp jobs result <id>");
    expect(prompt).toContain("npx -y agents-bridge-mcp jobs list");
    expect(prompt).toContain("Never delegate to codex");
    for (const heading of [
      "Objective",
      "Plan",
      "Delegations",
      "Findings",
      "Decisions",
      "Deliverables",
      "Open questions",
    ])
      expect(prompt).toContain(heading);
  });

  it("forbids write jobs when the lead cannot write", () => {
    expect(buildTeamleadPrompt({ ...base, canWrite: false })).toContain("Do not start any");
    expect(buildTeamleadPrompt(base)).toContain("only one write job");
  });
});
