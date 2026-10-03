import { describe, it, expect } from "vitest";
import { VERSION } from "../src/lib/version.js";
import {
  buildAskPrompt,
  buildCrossreviewPrompt,
  buildImplementPrompt,
  buildPlanPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  buildSplitPrompt,
  buildTeamleadPrompt,
} from "../src/lib/prompt-builder.js";

describe("buildAskPrompt", () => {
  it("asks for a short direct answer with code evidence", () => {
    const prompt = buildAskPrompt({ question: "Why is X slow?", context: "prod only" });
    expect(prompt).toContain("Why is X slow?");
    expect(prompt).toContain("prod only");
    expect(prompt).toContain("Answer");
    expect(prompt).toContain("Evidence");
  });

  it("lets a form the question asks for override the default structure", () => {
    const prompt = buildAskPrompt({ question: "Reply only with OK" });
    expect(prompt).toMatch(/If the question asks for a specific form.*follow it exactly/s);
    expect(prompt.indexOf("specific form")).toBeLessThan(prompt.indexOf("1. **Answer**"));
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

  it("demands the final line in the exact form a workflow can parse", () => {
    const prompt = buildReviewPrompt({ target: "the diff" });
    expect(prompt).toContain("Verdict: approve");
    expect(prompt).toContain("Verdict: request-changes");
    expect(prompt).toContain("very last line");
    expect(prompt.trimEnd().endsWith("Verdict: request-changes")).toBe(true);
  });
});

describe("buildReviewPrompt without a shell", () => {
  it("tells a reviewer that cannot run git to use the context instead", () => {
    const prompt = buildReviewPrompt({ target: "the diff", shell: false });
    expect(prompt).toContain("You cannot run shell commands");
    expect(prompt).not.toContain("Use read-only git commands");
    expect(buildReviewPrompt({ target: "the diff" })).toContain("Use read-only git commands");
    expect(buildReviewPrompt({ target: "the diff", shell: true })).toContain(
      "Use read-only git commands",
    );
  });
});

describe("buildSplitPrompt", () => {
  it("names the planner and its partner", () => {
    const prompt = buildSplitPrompt({
      goal: "Add export",
      planner: "codex",
      partner: "gemini",
      maxParts: 3,
      mode: "read-only",
    });
    expect(prompt).toContain("codex plans up to 3");
    expect(prompt).toContain("codex or gemini");
    expect(prompt).toContain("Add export");
  });
});

describe("buildCrossreviewPrompt", () => {
  it("records who implements, who reviews and the task", () => {
    const prompt = buildCrossreviewPrompt({
      task: "Add a flag",
      acceptance: "tests pass",
      implementer: "codex",
      reviewer: "claude",
      maxRounds: 3,
    });
    expect(prompt).toContain("codex implements");
    expect(prompt).toContain("claude reviews");
    expect(prompt).toContain("3 round(s)");
    expect(prompt).toContain("Add a flag");
    expect(prompt).toContain("tests pass");
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

describe("buildImplementPrompt verification rule", () => {
  it("tells the worker not to claim unrun verification passed", () => {
    expect(buildImplementPrompt({ task: "t" })).toContain(
      "If a verification command is not permitted or fails to run, say so explicitly instead of claiming it passed.",
    );
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
    const cli = `npx -y agentmate@${VERSION}`;
    expect(prompt).toContain(`${cli} jobs start claude "$(cat <<'EOF'`);
    expect(prompt).toContain("<<'EOF'");
    expect(prompt).toContain(')" --role <ask|review|research|plan|implement>');
    expect(prompt).toContain(`${cli} jobs wait <id> --timeout 90s`);
    expect(prompt).not.toContain("--timeout 10m");
    expect(prompt).not.toContain('"<complete briefing>"');
    expect(prompt).toContain("run the same wait again");
    expect(prompt).toContain(`${cli} jobs result <id>`);
    expect(prompt).toContain(`${cli} jobs list`);
    expect(prompt).toContain("never interpolate repository text or worker output");
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
