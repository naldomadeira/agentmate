import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readResult, startJob, summarize, waitJob } from "../src/jobs/api.js";
import { renderList, renderSession } from "../src/jobs/render.js";
import {
  appendNotes,
  attachJob,
  createSession,
  getSession,
  listSessions,
  readNotes,
  sessionJobs,
} from "../src/jobs/sessions.js";
import { homeDir, readJob } from "../src/jobs/store.js";

// A stand-in for the codex CLI that echoes its prompt, so the notes prefix is visible in the result.
const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "PROMPT<<" + prompt + ">>" } }));
`;

let home: string;
const saved = { ...process.env };

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abm-sessions-"));
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("sessions storage", () => {
  it("creates a session on disk with owner-only permissions", () => {
    const session = createSession({ title: "Refactor auth", cwd: "/work/app" });
    expect(session.id).toMatch(/^[a-z0-9-]+$/);
    expect(session).toMatchObject({ title: "Refactor auth", cwd: "/work/app", jobs: [] });
    expect(session.createdAt).toBe(session.updatedAt);

    const dir = path.join(homeDir(), "sessions", session.id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"))).toEqual(session);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "session.json")).mode & 0o777).toBe(0o600);
    expect(getSession(session.id)).toEqual(session);
  });

  it("throws a hint for an unknown or malformed session id", () => {
    expect(() => getSession("nope")).toThrow(/Session not found: nope.*sessions list/);
    expect(() => getSession("../etc")).toThrow(/Invalid session id/);
  });

  it("lists sessions newest first, filtered by cwd and limit", async () => {
    const a = createSession({ title: "a", cwd: "/list/one" });
    await sleep(5);
    const b = createSession({ title: "b", cwd: "/list/two" });
    await sleep(5);
    const c = createSession({ title: "c", cwd: "/list/one" });

    const mine = listSessions({ cwd: "/list/one" }).map((s) => s.id);
    expect(mine).toEqual([c.id, a.id]);
    expect(listSessions({ cwd: "/list/two" }).map((s) => s.id)).toEqual([b.id]);
    expect(listSessions({ cwd: "/list/one", limit: 1 }).map((s) => s.id)).toEqual([c.id]);
    expect(listSessions().map((s) => s.id)).toContain(a.id);
  });

  it("appends notes with an ISO stamp and author, and bumps updatedAt", async () => {
    const session = createSession({ title: "notes", cwd: "/n" });
    expect(readNotes(session.id)).toBe("");
    await sleep(5);
    appendNotes(session.id, "Use the v2 API.", "host");
    appendNotes(session.id, "Tests live in test/api.", "codex");

    const notes = readNotes(session.id);
    expect(notes).toMatch(/\n### \d{4}-\d\d-\d\dT[\d:.]+Z · host\nUse the v2 API\.\n/);
    expect(notes).toMatch(/### \S+ · codex\nTests live in test\/api\.\n$/);
    expect(getSession(session.id).updatedAt > session.updatedAt).toBe(true);
    expect(fs.statSync(path.join(homeDir(), "sessions", session.id, "notes.md")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("returns only the last maxChars of the notes", () => {
    const session = createSession({ title: "tail", cwd: "/t" });
    appendNotes(session.id, "FIRST-ENTRY", "host");
    appendNotes(session.id, "x".repeat(200), "host");
    appendNotes(session.id, "LAST-ENTRY", "host");

    const tail = readNotes(session.id, 50);
    expect(tail).toHaveLength(50);
    expect(tail).toContain("LAST-ENTRY");
    expect(tail).not.toContain("FIRST-ENTRY");
    expect(readNotes(session.id)).toContain("FIRST-ENTRY");
  });

  it("attaches each job once and resolves them to jobs", () => {
    const session = createSession({ title: "attach", cwd: home });
    const job = startJob({ provider: "codex", prompt: "hello", cwd: home, sessionId: session.id });
    attachJob(session.id, job.id);
    expect(getSession(session.id).jobs).toEqual([job.id]);
    expect(sessionJobs(session.id).map((j) => j.id)).toEqual([job.id]);
    expect(() => attachJob("nope", job.id)).toThrow(/Session not found/);
  });
});

describe("startJob with a session", () => {
  it("attaches the job and records the session on it", async () => {
    const session = createSession({ title: "attach me", cwd: home });
    const job = startJob({ provider: "codex", prompt: "hello", cwd: home, sessionId: session.id });
    expect(job.session).toBe(session.id);
    expect(readJob(job.id)?.session).toBe(session.id);
    expect(getSession(session.id).jobs).toEqual([job.id]);
    expect(summarize(job)).toContain(`session ${session.id}`);
    expect(renderList([job])).toContain(`session ${session.id}`);
    await waitJob(job.id, 20_000);
  }, 30_000);

  it("adds no prefix while the session has no notes", async () => {
    const session = createSession({ title: "empty", cwd: home });
    const job = startJob({
      provider: "codex",
      prompt: "just this",
      cwd: home,
      sessionId: session.id,
    });
    expect(job.prompt).toBe("just this");
    await waitJob(job.id, 20_000);
  }, 30_000);

  it("prefixes the prompt of every role with the notes", async () => {
    const session = createSession({ title: "Auth rewrite", cwd: home });
    appendNotes(session.id, "Decision: keep the legacy cookie.", "host");

    const custom = startJob({
      provider: "codex",
      prompt: "do it",
      cwd: home,
      sessionId: session.id,
    });
    expect(
      custom.prompt.startsWith(`## Shared session notes (session ${session.id}: Auth rewrite)\n`),
    ).toBe(true);
    expect(custom.prompt).toContain("Decision: keep the legacy cookie.");
    expect(custom.prompt).toContain("\n\n---\n\ndo it");

    const ask = startJob({
      provider: "codex",
      role: "ask",
      fields: { question: "what now?" },
      cwd: home,
      sessionId: session.id,
    });
    expect(ask.prompt).toContain("Decision: keep the legacy cookie.");
    expect(ask.prompt).toContain("Question: what now?");

    // the list line shows the role prompt, not the notes prefix
    expect(renderList([custom])).toContain("do it");
    expect(renderList([custom])).not.toContain("Shared session notes");

    await waitJob(custom.id, 20_000);
    expect(readResult(custom.id).text).toContain("Shared session notes");
    await waitJob(ask.id, 20_000);
    expect(getSession(session.id).jobs).toEqual([custom.id, ask.id]);
  }, 60_000);

  it("refuses an unknown session before writing a job", () => {
    expect(() =>
      startJob({ provider: "codex", prompt: "x", cwd: home, sessionId: "does-not-exist" }),
    ).toThrow(/Session not found: does-not-exist/);
  });
});

describe("renderSession", () => {
  it("shows the session, the notes and its jobs", () => {
    const session = createSession({ title: "Render me", cwd: home });
    appendNotes(session.id, "A short fact.", "host");
    const job = startJob({ provider: "codex", prompt: "work", cwd: home, sessionId: session.id });
    const text = renderSession(
      getSession(session.id),
      readNotes(session.id),
      sessionJobs(session.id),
    );
    expect(text).toContain(`session ${session.id}`);
    expect(text).toContain("Render me");
    expect(text).toContain("A short fact.");
    expect(text).toContain(job.id);
    expect(renderSession(session, "", [])).toContain("(no notes)");
    expect(renderSession(session, "", [])).toContain("No jobs.");
  });
});
