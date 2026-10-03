import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "../src/jobs/events.js";
import {
  ackInbox,
  appendInbox,
  inboxFile,
  readCursor,
  readInbox,
  renderInbox,
  unreadInbox,
  type InboxEntry,
} from "../src/jobs/inbox.js";
import { writeJob, type Job } from "../src/jobs/store.js";

let base: string;
let repo: string;
let sub: string;
let elsewhere: string;
const saved = process.env["AGENTMATE_HOME"];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "abm-inbox-"));
  process.env["AGENTMATE_HOME"] = path.join(base, "state");
  repo = path.join(base, "repo");
  sub = path.join(repo, "packages", "a");
  elsewhere = path.join(base, "repo-two");
  for (const dir of [sub, elsewhere]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env["AGENTMATE_HOME"];
  else process.env["AGENTMATE_HOME"] = saved;
  fs.rmSync(base, { recursive: true, force: true });
});

const at = (n: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, n)).toISOString();

function entry(fields: Partial<InboxEntry> = {}): InboxEntry {
  return {
    ts: at(0),
    job: "job-a",
    cwd: repo,
    provider: "codex",
    role: "ask",
    kind: "finished",
    text: "done",
    ...fields,
  };
}

function seedJob(id: string, fields: Partial<Job> = {}): void {
  writeJob({
    id,
    provider: "codex",
    mode: "read-only",
    role: "review",
    depth: 0,
    prompt: "p",
    cwd: repo,
    timeoutMs: 1000,
    status: "running",
    createdAt: at(0),
    ...fields,
  });
}

describe("inbox", () => {
  it("is written by important message, finished and error events only", () => {
    seedJob("job-a", { session: "sess-1" });
    const event = (level: "important" | "status" | "fyi", kind: string, n: number) =>
      appendEvent("job-a", { ts: at(n), job: "job-a", level, kind: kind as never, text: kind });
    event("important", "started", 1);
    event("important", "message", 2);
    event("fyi", "command", 3);
    event("status", "file", 4);
    event("important", "error", 5);
    event("important", "finished", 6);
    event("fyi", "message", 7);

    const entries = readInbox();
    expect(entries.map((e) => e.kind)).toEqual(["message", "error", "finished"]);
    expect(entries[0]).toEqual({
      ts: at(2),
      job: "job-a",
      cwd: repo,
      session: "sess-1",
      provider: "codex",
      role: "review",
      kind: "message",
      text: "message",
    });
    expect(fs.statSync(inboxFile()).mode & 0o777).toBe(0o600);
  });

  it("never lets an inbox failure break appendEvent", () => {
    seedJob("job-a");
    // A directory where the inbox file should be makes every inbox write fail.
    fs.mkdirSync(inboxFile(), { recursive: true });
    expect(() =>
      appendEvent("job-a", {
        ts: at(1),
        job: "job-a",
        level: "important",
        kind: "finished",
        text: "x",
      }),
    ).not.toThrow();
    expect(
      fs.readFileSync(path.join(base, "state", "jobs", "job-a", "events.jsonl"), "utf8"),
    ).toContain("finished");
  });

  it("skips the inbox when the job is unknown", () => {
    fs.mkdirSync(path.join(base, "state", "jobs", "ghost"), { recursive: true });
    appendEvent("ghost", {
      ts: at(1),
      job: "ghost",
      level: "important",
      kind: "finished",
      text: "x",
    });
    expect(readInbox()).toEqual([]);
  });

  it("reads a missing file as empty and skips truncated lines", () => {
    expect(readInbox()).toEqual([]);
    appendInbox(entry({ ts: at(1) }));
    fs.appendFileSync(inboxFile(), '{"ts":"2026-10-03T12:00:09.000Z","job":"cut');
    expect(readInbox().map((e) => e.ts)).toEqual([at(1)]);
  });

  it("filters by cwd (equal or subdirectory, by realpath) but not by a sibling prefix", () => {
    appendInbox(entry({ ts: at(1), job: "in-repo", cwd: repo }));
    appendInbox(entry({ ts: at(2), job: "in-sub", cwd: sub }));
    appendInbox(entry({ ts: at(3), job: "sibling", cwd: elsewhere }));
    const link = path.join(base, "link");
    fs.symlinkSync(repo, link);

    expect(readInbox({ cwd: repo }).map((e) => e.job)).toEqual(["in-repo", "in-sub"]);
    expect(readInbox({ cwd: link }).map((e) => e.job)).toEqual(["in-repo", "in-sub"]);
    expect(readInbox({ cwd: sub }).map((e) => e.job)).toEqual(["in-sub"]);
    expect(readInbox({ cwd: elsewhere }).map((e) => e.job)).toEqual(["sibling"]);
    expect(readInbox().map((e) => e.job)).toEqual(["in-repo", "in-sub", "sibling"]);
  });

  it("filters by since, kinds and keeps the newest N, newest last", () => {
    for (let n = 1; n <= 5; n++)
      appendInbox(entry({ ts: at(n), kind: n % 2 ? "message" : "error", text: `t${n}` }));

    expect(readInbox({ since: at(2) }).map((e) => e.text)).toEqual(["t3", "t4", "t5"]);
    expect(readInbox({ kinds: ["error"] }).map((e) => e.text)).toEqual(["t2", "t4"]);
    expect(readInbox({ limit: 2 }).map((e) => e.text)).toEqual(["t4", "t5"]);
    expect(readInbox({ limit: 0 })).toEqual([]);
  });

  it("keeps a cursor per directory: unread, ack, and unread again after new entries", () => {
    appendInbox(entry({ ts: at(1), job: "j1", cwd: repo }));
    appendInbox(entry({ ts: at(2), job: "j2", cwd: sub }));
    appendInbox(entry({ ts: at(3), job: "j3", cwd: elsewhere }));

    expect(readCursor(repo)).toBeNull();
    expect(unreadInbox(repo).map((e) => e.job)).toEqual(["j1", "j2"]);
    expect(unreadInbox(repo, 1).map((e) => e.job)).toEqual(["j2"]);

    ackInbox(repo, at(1));
    expect(readCursor(repo)).toBe(at(1));
    expect(unreadInbox(repo).map((e) => e.job)).toEqual(["j2"]);
    expect(unreadInbox(elsewhere).map((e) => e.job)).toEqual(["j3"]);

    ackInbox(repo, at(2));
    expect(unreadInbox(repo)).toEqual([]);
    appendInbox(entry({ ts: at(4), job: "j4", cwd: repo }));
    expect(unreadInbox(repo).map((e) => e.job)).toEqual(["j4"]);

    const dir = path.join(base, "state", "inbox-cursors");
    expect(fs.readdirSync(dir)).toHaveLength(1);
    // The cursor never moves backwards.
    ackInbox(repo, at(1));
    expect(readCursor(repo)).toBe(at(2));
  });

  it("tolerates a corrupt cursor file", () => {
    ackInbox(repo, at(1));
    const dir = path.join(base, "state", "inbox-cursors");
    for (const file of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, file), "{nope");
    expect(readCursor(repo)).toBeNull();
  });

  it("rotates the file to inbox.1.jsonl once it passes 5 MB, keeping one generation", () => {
    appendInbox(entry({ ts: at(1), job: "old" }));
    fs.appendFileSync(inboxFile(), `${" ".repeat(5 * 1024 * 1024 + 1)}\n`);
    appendInbox(entry({ ts: at(2), job: "new" }));

    const rotated = path.join(path.dirname(inboxFile()), "inbox.1.jsonl");
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.readFileSync(rotated, "utf8")).toContain('"old"');
    expect(readInbox().map((e) => e.job)).toEqual(["new"]);

    // A second rotation overwrites the previous generation.
    fs.appendFileSync(inboxFile(), `${" ".repeat(5 * 1024 * 1024 + 1)}\n`);
    appendInbox(entry({ ts: at(3), job: "newer" }));
    expect(fs.readFileSync(rotated, "utf8")).toContain('"new"');
    expect(fs.readFileSync(rotated, "utf8")).not.toContain('"old"');
    expect(readInbox().map((e) => e.job)).toEqual(["newer"]);
  });
});

describe("renderInbox", () => {
  it("prints one line per entry and a placeholder when empty", () => {
    expect(renderInbox([])).toBe("No new inbox entries.");
    const text = renderInbox([
      entry({
        ts: at(5),
        job: "abc",
        role: "review",
        provider: "claude",
        kind: "error",
        text: "boom\n  bad",
      }),
    ]);
    expect(text).toBe("12:00:05  abc  review/claude  error  boom bad");
  });
});
