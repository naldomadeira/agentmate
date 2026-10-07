import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCommand } from "../src/lib/exec-runner.js";
import { readResult, startJob, waitJob } from "../src/jobs/api.js";
import { renderList, renderSession } from "../src/jobs/render.js";
import {
  appendNotes,
  createSession,
  getSession,
  MAX_CONTEXT_CHARS,
  readContext,
  readNotes,
  setContext,
  withSessionNotes,
} from "../src/jobs/sessions.js";
import { homeDir } from "../src/jobs/store.js";

const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;

const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "PROMPT<<" + prompt + ">>" } }));
`;

let home: string;
const saved = { ...process.env };

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-sessctx-"));
  const bin = path.join(home, "fake-codex");
  fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  process.env["AGENTMATE_HOME"] = path.join(home, "state");
  process.env["AGENTMATE_CODEX_BIN"] = bin;
  process.env["AGENTMATE_CLI"] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  delete process.env["AGENTMATE_DEPTH"];
  delete process.env["AGENTMATE_JOB_ID"];
  delete process.env["AGENTMATE_PARENT_MODE"];
});

afterAll(() => {
  process.env = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return execCommand({
    command: "npx",
    args: ["tsx", CLI_PATH, ...args],
    timeoutMs: 5000,
    env: { ...process.env, AGENTMATE_HOME: path.join(home, "state") },
  });
}

describe("session context storage: set, append, replace", () => {
  it("stores context in context.md with mode 0o600", () => {
    const session = createSession({
      title: "Context storage",
      cwd: "/work/ctx",
      context: "Spec: authenticate via token.",
    });
    expect(readContext(session.id)).toBe("Spec: authenticate via token.");

    const file = path.join(homeDir(), "sessions", session.id, "context.md");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("Spec: authenticate via token.");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("returns empty string when no context has been set", () => {
    const session = createSession({ title: "No context", cwd: "/work/ctx" });
    expect(readContext(session.id)).toBe("");
  });

  it("replaces context with mode replace", () => {
    const session = createSession({
      title: "Replace test",
      cwd: "/work/ctx",
      context: "Initial spec.",
    });
    expect(readContext(session.id)).toBe("Initial spec.");

    setContext(session.id, "Updated spec.", "replace");
    expect(readContext(session.id)).toBe("Updated spec.");
  });

  it("appends to context with mode append", () => {
    const session = createSession({
      title: "Append test",
      cwd: "/work/ctx",
      context: "Decision: use Postgres.",
    });

    setContext(session.id, "Decision: use UUID keys.", "append");
    expect(readContext(session.id)).toBe("Decision: use Postgres.\n\nDecision: use UUID keys.");

    setContext(session.id, "Decision: migration required.", "append");
    expect(readContext(session.id)).toBe(
      "Decision: use Postgres.\n\nDecision: use UUID keys.\n\nDecision: migration required.",
    );
  });

  it("sets context directly when appending to a session with no prior context", () => {
    const session = createSession({ title: "Fresh append", cwd: "/work/ctx" });
    setContext(session.id, "First context item.", "append");
    expect(readContext(session.id)).toBe("First context item.");
  });

  it("throws when session id is unknown or malformed", () => {
    expect(() => readContext("unknown-id")).toThrow(/Session not found/);
    expect(() => setContext("unknown-id", "some text")).toThrow(/Session not found/);
  });
});

describe("session context size limit", () => {
  it("refuses context larger than 16 KB on creation with a clear error", () => {
    const huge = "x".repeat(MAX_CONTEXT_CHARS + 1);
    expect(() => createSession({ title: "Too big", cwd: "/work", context: huge })).toThrow(
      /Session context is too large \(16001 characters, max 16000\)/,
    );
  });

  it("refuses context larger than 16 KB on replace with a clear error", () => {
    const session = createSession({ title: "Size limit replace", cwd: "/work" });
    const huge = "a".repeat(MAX_CONTEXT_CHARS + 10);
    expect(() => setContext(session.id, huge, "replace")).toThrow(/Session context is too large/);
    expect(readContext(session.id)).toBe("");
  });

  it("refuses append when the combined context exceeds 16 KB without corrupting existing context", () => {
    const session = createSession({
      title: "Size limit append",
      cwd: "/work",
      context: "a".repeat(10_000),
    });
    const addition = "b".repeat(6_500); // 10000 + 2 + 6500 = 16502 > 16000
    expect(() => setContext(session.id, addition, "append")).toThrow(
      /Session context is too large/,
    );
    expect(readContext(session.id)).toBe("a".repeat(10_000));
  });

  it("accepts context right at the 16,000 character limit", () => {
    const exact = "c".repeat(MAX_CONTEXT_CHARS);
    const session = createSession({ title: "Exact limit", cwd: "/work", context: exact });
    expect(readContext(session.id)).toHaveLength(MAX_CONTEXT_CHARS);
  });
});

describe("briefing contains context before notes", () => {
  it("places context ahead of shared notes in withSessionNotes", () => {
    const session = createSession({
      title: "Feature Auth",
      cwd: home,
      context: "Spec: JWT with 15m expiration.",
    });
    appendNotes(session.id, "Note: legacy sessions still exist.", "host");

    const briefing = withSessionNotes(session.id, "Implement auth tokens");

    const contextHeader = `## Session context (session ${session.id})`;
    const notesHeader = `## Shared session notes (session ${session.id}: Feature Auth)`;

    expect(briefing).toContain(contextHeader);
    expect(briefing).toContain("Spec: JWT with 15m expiration.");
    expect(briefing).toContain(notesHeader);
    expect(briefing).toContain("Note: legacy sessions still exist.");

    const contextPos = briefing.indexOf(contextHeader);
    const notesPos = briefing.indexOf(notesHeader);
    expect(contextPos).toBeGreaterThan(0);
    expect(notesPos).toBeGreaterThan(contextPos);
  });

  it("includes only context when the session has context but no notes", () => {
    const session = createSession({
      title: "Only Context",
      cwd: home,
      context: "Fixed briefing text.",
    });

    const briefing = withSessionNotes(session.id, "Focus on X");
    expect(briefing).toContain(`## Session context (session ${session.id})`);
    expect(briefing).toContain("Fixed briefing text.");
    expect(briefing).not.toContain("## Shared session notes");
  });

  it("includes only notes when the session has notes but no context", () => {
    const session = createSession({ title: "Only Notes", cwd: home });
    appendNotes(session.id, "Shared fact.", "host");

    const briefing = withSessionNotes(session.id, "Focus on Y");
    expect(briefing).not.toContain("## Session context");
    expect(briefing).toContain("## Shared session notes");
    expect(briefing).toContain("Shared fact.");
  });

  it("returns prompt unchanged when neither context nor notes are present", () => {
    const session = createSession({ title: "Neither", cwd: home });
    expect(withSessionNotes(session.id, "Pure prompt")).toBe("Pure prompt");
  });

  it("startJob injects context before notes in job prompt", async () => {
    const session = createSession({
      title: "Job Briefing",
      cwd: home,
      context: "Integration tests run via pnpm test:integration.",
    });
    appendNotes(session.id, "DB is running on port 5432.", "host");

    const job = startJob({
      provider: "codex",
      prompt: "Review migrations",
      cwd: home,
      sessionId: session.id,
    });

    expect(job.prompt).toContain(`## Session context (session ${session.id})`);
    expect(job.prompt).toContain("Integration tests run via pnpm test:integration.");
    expect(job.prompt).toContain(`## Shared session notes (session ${session.id}: Job Briefing)`);
    expect(job.prompt).toContain("DB is running on port 5432.");

    const ctxIdx = job.prompt.indexOf("## Session context");
    const notesIdx = job.prompt.indexOf("## Shared session notes");
    expect(ctxIdx).toBeLessThan(notesIdx);

    await waitJob(job.id, 20_000);
    const result = readResult(job.id);
    expect(result.text).toContain("Session context");
    expect(result.text).toContain("Shared session notes");
  }, 30_000);
});

describe("listLine and renderList preview stripping", () => {
  it("strips context and notes from job preview in renderList", () => {
    const session = createSession({
      title: "Strip Test",
      cwd: home,
      context: "Very long fixed context specification and guidelines.",
    });
    appendNotes(session.id, "Some note from previous agent.", "host");

    const job = startJob({
      provider: "codex",
      prompt: "Run the build",
      cwd: home,
      sessionId: session.id,
    });

    const rendered = renderList([job]);
    expect(rendered).toContain("Run the build");
    expect(rendered).not.toContain("Session context");
    expect(rendered).not.toContain("Very long fixed context");
    expect(rendered).not.toContain("Shared session notes");
    expect(rendered).not.toContain("Some note from previous agent");
  });

  it("strips context even when there are no notes", () => {
    const session = createSession({
      title: "Context Only Strip",
      cwd: home,
      context: "Fixed spec without notes.",
    });

    const job = startJob({
      provider: "codex",
      prompt: "Fix the bug",
      cwd: home,
      sessionId: session.id,
    });

    const rendered = renderList([job]);
    expect(rendered).toContain("Fix the bug");
    expect(rendered).not.toContain("Session context");
    expect(rendered).not.toContain("Fixed spec without notes");
  });
});

describe("renderSession context display", () => {
  it("shows context section in renderSession", () => {
    const session = createSession({
      title: "Show Session",
      cwd: home,
      context: "API endpoint decisions and curl examples.",
    });
    appendNotes(session.id, "Note 1", "host");

    const text = renderSession(
      getSession(session.id),
      readNotes(session.id),
      [],
      readContext(session.id),
    );

    expect(text).toContain(`session ${session.id} · Show Session`);
    expect(text).toContain("context:\nAPI endpoint decisions and curl examples.");
    expect(text).toContain("notes:\n");
  });

  it("shows (no context) when context is empty", () => {
    const session = createSession({ title: "Empty Context Session", cwd: home });
    const text = renderSession(getSession(session.id), "", [], "");
    expect(text).toContain("context:\n(no context)");
  });

  it("truncates context to ~2 KB with total size note when longer than 2,000 characters", () => {
    const session = createSession({ title: "Long Context Session", cwd: home });
    const longContext = "x".repeat(3_500);
    setContext(session.id, longContext, "replace");

    const text = renderSession(
      getSession(session.id),
      readNotes(session.id),
      [],
      readContext(session.id),
    );

    expect(text).toContain("context:\n");
    expect(text).toContain("…[truncated, 3500 characters total]");
    expect(text).not.toContain("x".repeat(2_500));
  });
});

describe("CLI sessions commands with context", () => {
  it("sessions start with --context creates session with context", async () => {
    const res = await runCli(["sessions", "start", "CLI Context Test", "--context", "CLI spec"]);
    expect(res.exitCode).toBe(0);
    const id = res.stdout.trim();
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(readContext(id)).toBe("CLI spec");
  }, 30_000);

  it("sessions start with --context-file reads context from file", async () => {
    const filePath = path.join(home, "spec.md");
    fs.writeFileSync(filePath, "Spec from file content");

    const res = await runCli([
      "sessions",
      "start",
      "File Context Test",
      "--context-file",
      filePath,
    ]);
    expect(res.exitCode).toBe(0);
    const id = res.stdout.trim();
    expect(readContext(id)).toBe("Spec from file content");
  }, 30_000);

  it("sessions context <id> sets, appends, and reads context", async () => {
    const session = createSession({ title: "CLI context test", cwd: home });

    // Set context via positional text
    const setRes = await runCli(["sessions", "context", session.id, "Initial CLI text"]);
    expect(setRes.exitCode).toBe(0);
    expect(setRes.stdout).toContain(`Set context for session ${session.id}.`);
    expect(readContext(session.id)).toBe("Initial CLI text");

    // Read context
    const viewRes = await runCli(["sessions", "context", session.id]);
    expect(viewRes.exitCode).toBe(0);
    expect(viewRes.stdout.trim()).toBe("Initial CLI text");

    // Append context
    const appendRes = await runCli(["sessions", "context", session.id, "Second line", "--append"]);
    expect(appendRes.exitCode).toBe(0);
    expect(appendRes.stdout).toContain(`Appended to context for session ${session.id}.`);
    expect(readContext(session.id)).toBe("Initial CLI text\n\nSecond line");
  }, 30_000);

  it("sessions context <id> --file sets context from file", async () => {
    const session = createSession({ title: "CLI file context", cwd: home });
    const filePath = path.join(home, "override.md");
    fs.writeFileSync(filePath, "Overridden from file");

    const res = await runCli(["sessions", "context", session.id, "--file", filePath]);
    expect(res.exitCode).toBe(0);
    expect(readContext(session.id)).toBe("Overridden from file");
  }, 30_000);

  it("sessions show <id> displays the context", async () => {
    const session = createSession({
      title: "CLI show test",
      cwd: home,
      context: "Context shown via CLI",
    });
    const res = await runCli(["sessions", "show", session.id]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Context shown via CLI");
  }, 30_000);
});

describe("session context from a worker", () => {
  it("is refused, so a worker cannot brief its siblings", () => {
    const saved = process.env["AGENTMATE_JOB_ID"];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-ctx-worker-"));
    const savedHome = process.env["AGENTMATE_HOME"];
    process.env["AGENTMATE_HOME"] = home;
    try {
      const session = createSession({ title: "t", cwd: home });
      process.env["AGENTMATE_JOB_ID"] = "worker-1";
      expect(() => setContext(session.id, "do this instead")).toThrow(/Only the host session/);
      expect(() => createSession({ title: "t", cwd: home, context: "x" })).toThrow(
        /Only the host session/,
      );
      expect(readContext(session.id)).toBe("");
    } finally {
      if (saved === undefined) delete process.env["AGENTMATE_JOB_ID"];
      else process.env["AGENTMATE_JOB_ID"] = saved;
      if (savedHome === undefined) delete process.env["AGENTMATE_HOME"];
      else process.env["AGENTMATE_HOME"] = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
