// Shared by the AgentMate hooks: reads the inbox and its per-directory cursor.
// The layout and the unread rules mirror src/jobs/inbox.ts (copied on purpose, hooks cannot
// import src; test/inbox.test.ts pins both sides). Plain Node ESM, no dependencies.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const FIRST_RUN_WINDOW_MS = 24 * 3_600_000;
export const MAX_ACKED_JOBS = 200;

export function homeDir() {
  const env = process.env.AGENTMATE_HOME;
  return env && env.trim() ? env : join(homedir(), ".agentmate");
}

export function realDir(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `dir` is `root` or lies below it (a sibling sharing a name prefix does not). */
export function within(root, dir) {
  if (typeof dir !== "string" || !dir) return false;
  const real = realDir(dir);
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

export const sha1 = (text) => createHash("sha1").update(text).digest("hex");

export const cursorPath = (dir, root) => join(dir, "inbox-cursors", `${sha1(root)}.json`);

export const entryKey = (entry) => `${entry.job}:${entry.kind}:${entry.ts}`;

/** The cursor of `root`: legacy files with only `lastTs` read as `lastKeys`/`lastCount` null. */
export function readCursor(dir, root) {
  const cursor = { lastTs: null, lastKeys: null, lastCount: null, ackedJobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(dir, root), "utf8"));
    if (typeof parsed?.lastTs === "string" && parsed.lastTs) cursor.lastTs = parsed.lastTs;
    if (Array.isArray(parsed?.lastKeys))
      cursor.lastKeys = parsed.lastKeys.filter((key) => typeof key === "string");
    if (Number.isInteger(parsed?.lastCount) && parsed.lastCount >= 0)
      cursor.lastCount = parsed.lastCount;
    if (Array.isArray(parsed?.ackedJobs))
      cursor.ackedJobs = parsed.ackedJobs.filter((id) => typeof id === "string");
  } catch {
    // no cursor yet, or a corrupt one
  }
  return cursor;
}

/** Entries below `root` in file order (rotated file first). Null when no inbox file exists. */
export function readEntries(dir, root) {
  const entries = [];
  const cache = new Map();
  let found = false;
  for (const name of ["inbox.1.jsonl", "inbox.jsonl"]) {
    let raw;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    found = true;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a line cut off mid-write
      }
      if (!entry || typeof entry.ts !== "string" || typeof entry.cwd !== "string") continue;
      let inside = cache.get(entry.cwd);
      if (inside === undefined) cache.set(entry.cwd, (inside = within(root, entry.cwd)));
      if (inside) entries.push(entry);
    }
  }
  return found ? entries : null;
}

/**
 * The unread entries, in the order they are shown and acknowledged: first the late appends (an
 * older ts than the cursor, spotted because the count of entries at or before it grew), then the
 * rest by ts. Without a cursor only entries after `firstRunSince` count.
 */
export function selectUnread(entries, cursor, firstRunSince) {
  let late = [];
  let fresh;
  if (cursor.lastTs === null) {
    fresh = entries.filter((entry) => entry.ts > firstRunSince);
  } else {
    const lastTs = cursor.lastTs;
    const keys = new Set(cursor.lastKeys ?? []);
    const unreadTie = (entry) =>
      entry.ts === lastTs && cursor.lastKeys !== null && !keys.has(entryKey(entry));
    fresh = entries.filter((entry) => entry.ts > lastTs || unreadTie(entry));
    if (cursor.lastCount !== null) {
      const old = entries.filter((entry) => entry.ts <= lastTs);
      const grown = old.length - cursor.lastCount;
      if (grown > 0) late = old.slice(old.length - grown).filter((entry) => !unreadTie(entry));
    }
  }
  fresh = fresh
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.ts < b.entry.ts ? -1 : a.entry.ts > b.entry.ts ? 1 : a.index - b.index,
    )
    .map(({ entry }) => entry);
  const acked = new Set(cursor.ackedJobs);
  return [...late, ...fresh].filter((entry) => !acked.has(entry.job));
}

/**
 * The cursor after `shown` (a prefix of `selection`) was delivered. `lastTs` moves forward to the
 * last shown entry and never back; entries that are still unread but sort before it stay counted
 * out of `lastCount`, so they come back as late appends.
 */
export function advanceCursor(cursor, entries, selection, shown) {
  let lastTs = cursor.lastTs;
  for (const entry of shown) if (lastTs === null || entry.ts > lastTs) lastTs = entry.ts;
  if (lastTs === null) return cursor;
  const shownKeys = new Set(shown.map(entryKey));
  let lastKeys;
  if (lastTs === cursor.lastTs && cursor.lastKeys === null) {
    lastKeys = entries.filter((entry) => entry.ts === lastTs).map(entryKey); // legacy: all read
  } else {
    lastKeys = [...(lastTs === cursor.lastTs ? (cursor.lastKeys ?? []) : [])];
    for (const entry of shown) if (entry.ts === lastTs) lastKeys.push(entryKey(entry));
    lastKeys = [...new Set(lastKeys)];
  }
  const held = selection.filter((entry) => entry.ts < lastTs && !shownKeys.has(entryKey(entry)));
  const lastCount = entries.filter((entry) => entry.ts <= lastTs).length - held.length;
  return { lastTs, lastKeys, lastCount: Math.max(0, lastCount), ackedJobs: cursor.ackedJobs };
}

/** Writes the cursor through tmp+rename unless a newer one is already on disk; keeps its ackedJobs. */
export function writeCursor(dir, root, cursor) {
  const current = readCursor(dir, root);
  if (current.lastTs !== null && cursor.lastTs !== null && current.lastTs > cursor.lastTs) return;
  const ackedJobs = [...new Set([...current.ackedJobs, ...cursor.ackedJobs])].slice(
    -MAX_ACKED_JOBS,
  );
  const file = cursorPath(dir, root);
  mkdirSync(join(dir, "inbox-cursors"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      lastTs: cursor.lastTs,
      lastKeys: cursor.lastKeys ?? [],
      lastCount: cursor.lastCount ?? 0,
      ackedJobs,
    }),
    { mode: 0o600 },
  );
  renameSync(tmp, file);
}
