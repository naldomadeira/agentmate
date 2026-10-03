import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "../src/jobs/events.js";
import {
  ackInbox,
  ackJob,
  ackShown,
  ackTerminalJob,
  appendInbox,
  inboxFile,
  inboxToolText,
  readCursor,
  readInbox,
  renderInbox,
  renderInboxEntry,
  rotatedInboxFile,
  unreadInbox,
  type InboxEntry,
} from "../src/jobs/inbox.js";
import { writeJob, type Job } from "../src/jobs/store.js";

let base: string;
let repo: string;
let sub: string;
let elsewhere: string;
const saved = process.env["AGENTMATE_HOME"];
const savedJob = process.env["AGENTMATE_JOB_ID"];

beforeEach(() => {
  delete process.env["AGENTMATE_JOB_ID"];
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
  if (savedJob === undefined) delete process.env["AGENTMATE_JOB_ID"];
  else process.env["AGENTMATE_JOB_ID"] = savedJob;
  fs.rmSync(base, { recursive: true, force: true });
});

// Relative to now: with no cursor only the last 24 hours count as unread.
const T0 = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
const at = (n: number) => new Date(T0 + n * 1000).toISOString();

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
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["j1", "j2"]);

    ackInbox(repo, at(1));
    expect(readCursor(repo)).toBe(at(1));
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["j2"]);
    expect(unreadInbox(elsewhere).entries.map((e) => e.job)).toEqual(["j3"]);

    ackInbox(repo, at(2));
    expect(unreadInbox(repo)).toEqual({ entries: [], total: 0 });
    appendInbox(entry({ ts: at(4), job: "j4", cwd: repo }));
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["j4"]);

    const dir = path.join(base, "state", "inbox-cursors");
    expect(fs.readdirSync(dir)).toHaveLength(1);
    // The cursor never moves backwards.
    ackInbox(repo, at(1));
    expect(readCursor(repo)).toBe(at(2));
  });

  it("returns the OLDEST N unread entries with the total, and acks only through the last shown", () => {
    for (let n = 1; n <= 5; n++) appendInbox(entry({ ts: at(n), job: `j${n}` }));

    const first = unreadInbox(repo, 2);
    expect(first.entries.map((e) => e.job)).toEqual(["j1", "j2"]);
    expect(first.total).toBe(5);
    ackShown(repo, first.entries);
    expect(readCursor(repo)).toBe(at(2));

    const second = unreadInbox(repo, 2);
    expect(second.entries.map((e) => e.job)).toEqual(["j3", "j4"]);
    expect(second.total).toBe(3);
    ackShown(repo, second.entries);

    const last = unreadInbox(repo, 2);
    expect(last.entries.map((e) => e.job)).toEqual(["j5"]);
    expect(last.total).toBe(1);
    ackShown(repo, last.entries);
    expect(unreadInbox(repo).total).toBe(0);
  });

  it("delivers entries sharing the cursor millisecond once, even when only some were acked", () => {
    appendInbox(entry({ ts: at(1), job: "a" }));
    appendInbox(entry({ ts: at(1), job: "b" }));
    appendInbox(entry({ ts: at(1), job: "c" }));

    const first = unreadInbox(repo, 1);
    expect(first.entries.map((e) => e.job)).toEqual(["a"]);
    expect(first.total).toBe(3);
    ackShown(repo, first.entries);
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["b", "c"]);

    // A new tie that arrives after the ack is still unread.
    appendInbox(entry({ ts: at(1), job: "d" }));
    const rest = unreadInbox(repo);
    expect(rest.entries.map((e) => e.job)).toEqual(["b", "c", "d"]);
    ackShown(repo, rest.entries);
    expect(unreadInbox(repo).total).toBe(0);
  });

  it("delivers a late append whose ts is below the cursor exactly once", () => {
    appendInbox(entry({ ts: at(5), job: "new" }));
    ackShown(repo, unreadInbox(repo).entries);
    expect(unreadInbox(repo).total).toBe(0);

    // Another process finished its append after the ack, with an older event timestamp.
    appendInbox(entry({ ts: at(3), job: "late" }));
    const seen = unreadInbox(repo);
    expect(seen.entries.map((e) => e.job)).toEqual(["late"]);
    ackShown(repo, seen.entries);
    expect(unreadInbox(repo).total).toBe(0);
    expect(readCursor(repo)).toBe(at(5));

    // Late entries of other directories do not disturb this cursor.
    appendInbox(entry({ ts: at(2), job: "far", cwd: elsewhere }));
    expect(unreadInbox(repo).total).toBe(0);
  });

  it("keeps late appends unread when the page was too small to show them all", () => {
    appendInbox(entry({ ts: at(9), job: "base" }));
    ackShown(repo, unreadInbox(repo).entries);
    appendInbox(entry({ ts: at(3), job: "late-1" }));
    appendInbox(entry({ ts: at(4), job: "late-2" }));

    const one = unreadInbox(repo, 1);
    expect(one.entries.map((e) => e.job)).toEqual(["late-1"]);
    expect(one.total).toBe(2);
    ackShown(repo, one.entries);
    const two = unreadInbox(repo, 1);
    expect(two.entries.map((e) => e.job)).toEqual(["late-2"]);
    ackShown(repo, two.entries);
    expect(unreadInbox(repo).total).toBe(0);
  });

  it("still reads a legacy cursor that only has lastTs", () => {
    appendInbox(entry({ ts: at(1), job: "old" }));
    appendInbox(entry({ ts: at(2), job: "tie" }));
    appendInbox(entry({ ts: at(3), job: "fresh" }));
    ackInbox(repo, at(2));
    const dir = path.join(base, "state", "inbox-cursors");
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.writeFileSync(file, JSON.stringify({ lastTs: at(2) }));

    expect(readCursor(repo)).toBe(at(2));
    const seen = unreadInbox(repo);
    expect(seen.entries.map((e) => e.job)).toEqual(["fresh"]);
    ackShown(repo, seen.entries);
    expect(unreadInbox(repo).total).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      lastTs: at(3),
      lastKeys: [`fresh:finished:${at(3)}`],
    });
  });

  it("writes the cursor through tmp+rename and leaves no temp file behind", () => {
    appendInbox(entry({ ts: at(1) }));
    ackShown(repo, unreadInbox(repo).entries);
    const dir = path.join(base, "state", "inbox-cursors");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(fs.statSync(path.join(dir, fs.readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
  });

  it("without a cursor only the last 24 hours are unread, while readInbox keeps all history", () => {
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    appendInbox(entry({ ts: old, job: "ancient" }));
    appendInbox(entry({ ts: at(1), job: "recent" }));
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["recent"]);
    expect(readInbox({ cwd: repo }).map((e) => e.job)).toEqual(["ancient", "recent"]);
  });

  it("ackJob hides one job's entries without skipping other unread ones", () => {
    appendInbox(entry({ ts: at(1), job: "seen-via-wait" }));
    appendInbox(entry({ ts: at(2), job: "other" }));
    appendInbox(entry({ ts: at(3), job: "seen-via-wait", kind: "message" }));

    ackJob(repo, "seen-via-wait");
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["other"]);
    expect(unreadInbox(repo).total).toBe(1);

    // Later acks keep the memory; at most 200 ids are remembered.
    ackShown(repo, unreadInbox(repo).entries);
    expect(unreadInbox(repo).total).toBe(0);
    for (let n = 0; n < 205; n++) ackJob(repo, `j${n}`);
    const dir = path.join(base, "state", "inbox-cursors");
    const cursor = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf8"));
    expect(cursor.ackedJobs).toHaveLength(200);
    expect(cursor.ackedJobs.at(-1)).toBe("j204");
  });

  it("ackTerminalJob acks a finished job for its cwd and the host cwd, but not a running one", () => {
    appendInbox(entry({ ts: at(1), job: "done-job" }));
    appendInbox(entry({ ts: at(2), job: "run-job" }));
    const job = (id: string, status: "done" | "running") =>
      ({ id, cwd: repo, status }) as unknown as Parameters<typeof ackTerminalJob>[0];

    ackTerminalJob(job("run-job", "running"));
    expect(unreadInbox(repo).total).toBe(2);
    ackTerminalJob(job("done-job", "done"));
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["run-job"]);
  });

  it("tolerates a corrupt cursor file", () => {
    ackInbox(repo, at(1));
    const dir = path.join(base, "state", "inbox-cursors");
    for (const file of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, file), "{nope");
    expect(readCursor(repo)).toBeNull();
  });

  it("rotates the file to inbox.1.jsonl once it passes 5 MB, keeping one generation, and reads both", () => {
    appendInbox(entry({ ts: at(1), job: "old" }));
    fs.appendFileSync(inboxFile(), `${" ".repeat(5 * 1024 * 1024 + 1)}\n`);
    appendInbox(entry({ ts: at(2), job: "new" }));

    const rotated = rotatedInboxFile();
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.readFileSync(rotated, "utf8")).toContain('"old"');
    // Rotated entries stay visible until they age out.
    expect(readInbox().map((e) => e.job)).toEqual(["old", "new"]);
    expect(unreadInbox(repo).entries.map((e) => e.job)).toEqual(["old", "new"]);
    expect(fs.existsSync(path.join(base, "state", "inbox.lock"))).toBe(false);

    // A second rotation overwrites the previous generation.
    fs.appendFileSync(inboxFile(), `${" ".repeat(5 * 1024 * 1024 + 1)}\n`);
    appendInbox(entry({ ts: at(3), job: "newer" }));
    expect(fs.readFileSync(rotated, "utf8")).toContain('"new"');
    expect(fs.readFileSync(rotated, "utf8")).not.toContain('"old"');
    expect(readInbox().map((e) => e.job)).toEqual(["new", "newer"]);
  });

  it("skips rotation while another process holds the lock, and takes over a stale lock", () => {
    appendInbox(entry({ ts: at(1), job: "old" }));
    fs.appendFileSync(inboxFile(), `${" ".repeat(5 * 1024 * 1024 + 1)}\n`);
    const lock = path.join(base, "state", "inbox.lock");
    fs.mkdirSync(lock);

    appendInbox(entry({ ts: at(2), job: "during-lock" }));
    expect(fs.existsSync(rotatedInboxFile())).toBe(false);
    expect(fs.existsSync(lock)).toBe(true); // not ours: left alone
    expect(readInbox().map((e) => e.job)).toEqual(["old", "during-lock"]);

    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    appendInbox(entry({ ts: at(3), job: "after-stale" }));
    expect(fs.existsSync(rotatedInboxFile())).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(readInbox().map((e) => e.job)).toEqual(["old", "during-lock", "after-stale"]);
  });

  it("caps an entry's text at 500 characters when it is appended", () => {
    appendInbox(entry({ text: "x".repeat(5000) }));
    const [stored] = readInbox();
    expect(stored!.text.length).toBe(500);
    expect(stored!.text.endsWith("…")).toBe(true);
  });

  it("does not copy events of child jobs (workflow steps, team lead children) to the inbox", () => {
    seedJob("parent-1");
    seedJob("child-1", { parentJob: "parent-1" });
    const finish = (id: string) =>
      appendEvent(id, { ts: at(1), job: id, level: "important", kind: "finished", text: "done" });
    finish("child-1");
    finish("parent-1");
    expect(readInbox().map((e) => e.job)).toEqual(["parent-1"]);
  });
});

describe("inboxToolText (mate_inbox)", () => {
  it("lists the oldest entries, says how many more are unread, and acks only what it showed", () => {
    for (let n = 1; n <= 3; n++) appendInbox(entry({ ts: at(n), job: `j${n}` }));

    const first = inboxToolText({ cwd: repo, limit: 2 });
    expect(first).toContain("j1");
    expect(first).toContain("j2");
    expect(first).not.toContain("j3");
    expect(first).toContain("… 1 more unread (run again)");

    const second = inboxToolText({ cwd: repo, limit: 2 });
    expect(second).toContain("j3");
    expect(second).not.toContain("more unread");
    expect(inboxToolText({ cwd: repo })).toBe("No new inbox entries.");
  });

  it("does not acknowledge with ack: false", () => {
    appendInbox(entry({ ts: at(1), job: "j1" }));
    expect(inboxToolText({ cwd: repo, ack: false })).toContain("j1");
    expect(inboxToolText({ cwd: repo })).toContain("j1");
  });

  it("refuses inside a worker (AGENTMATE_JOB_ID set) with a note and leaves the cursor alone", () => {
    appendInbox(entry({ ts: at(1), job: "j1" }));
    process.env["AGENTMATE_JOB_ID"] = "worker-1";
    const text = inboxToolText({ cwd: repo });
    expect(text).toMatch(/host/i);
    expect(text).not.toContain("j1");
    expect(readCursor(repo)).toBeNull();
    delete process.env["AGENTMATE_JOB_ID"];
    expect(unreadInbox(repo).total).toBe(1);
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
    expect(text).toBe(`${at(5).slice(11, 19)}  abc  review/claude  error  boom bad`);
  });

  it("caps a long text at 500 characters", () => {
    const line = renderInboxEntry(entry({ text: "y".repeat(2000) }));
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(560);
  });

  it("adds a line when more entries are unread", () => {
    expect(renderInbox([entry()], 4)).toMatch(/\n… 4 more unread \(run again\)$/);
  });
});
