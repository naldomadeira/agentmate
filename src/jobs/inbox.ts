import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homeDir, TERMINAL, type Job, type JobRole, type Provider } from "./store.js";

/** Past this size the inbox moves to `inbox.1.jsonl` (one generation) and a fresh file starts. */
export const MAX_INBOX_BYTES = 5 * 1024 * 1024;

export type InboxKind = "message" | "finished" | "error";

/** One thing a host agent should hear about: an important event of a job in some directory. */
export interface InboxEntry {
  /** ISO timestamp of the job event. */
  ts: string;
  job: string;
  cwd: string;
  session?: string | undefined;
  provider: Provider;
  role: JobRole;
  kind: InboxKind;
  text: string;
}

export const INBOX_KINDS: readonly string[] = ["message", "finished", "error"];

/** Longest `text` kept in an inbox line and printed for it. */
export const MAX_ENTRY_TEXT = 500;
/** Without a cursor only the last day counts (the hook uses the same window). */
export const FIRST_RUN_WINDOW_MS = 24 * 3_600_000;
/** Job ids remembered per directory as already seen through `mate_wait` / `mate_result`. */
export const MAX_ACKED_JOBS = 200;
/** A rotation lock older than this is a leftover of a crashed process. */
const STALE_LOCK_MS = 30_000;

export const inboxFile = (): string => path.join(homeDir(), "inbox.jsonl");
export const rotatedInboxFile = (): string => path.join(homeDir(), "inbox.1.jsonl");
const lockDir = (): string => path.join(homeDir(), "inbox.lock");
const cursorDir = (): string => path.join(homeDir(), "inbox-cursors");

/** Symlinks resolved where the directory exists; the plain absolute path otherwise. */
function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** True when `dir` is `root` or lies below it (a sibling sharing a name prefix does not). */
function within(root: string, dir: string): boolean {
  const real = realDir(dir);
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Removes a rotation lock left behind by a crashed process. */
function dropStaleLock(lock: string): void {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmdirSync(lock);
  } catch {
    // gone already, or not ours to remove
  }
}

/** Renames a full inbox over `inbox.1.jsonl` under an exclusive lock; skips when someone else rotates. */
function rotateIfFull(): void {
  try {
    if (fs.statSync(inboxFile()).size <= MAX_INBOX_BYTES) return;
  } catch {
    return; // no inbox yet
  }
  const lock = lockDir();
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) return;
      dropStaleLock(lock);
    }
  }
  try {
    // Re-check: the process that held the lock before us may have rotated already.
    if (fs.statSync(inboxFile()).size > MAX_INBOX_BYTES)
      fs.renameSync(inboxFile(), rotatedInboxFile());
  } catch {
    // a racing process already moved it
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // already removed
    }
  }
}

/** Appends one line (0600, text capped at 500 characters); a full file is rotated first. */
export function appendInbox(entry: InboxEntry): void {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  rotateIfFull();
  const line = JSON.stringify({ ...entry, text: clip(String(entry.text ?? ""), MAX_ENTRY_TEXT) });
  fs.appendFileSync(inboxFile(), `${line}\n`, { mode: 0o600 });
}

export interface ReadInboxOptions {
  /** Only entries for this directory or below it. */
  cwd?: string | undefined;
  /** Only entries strictly after this ISO timestamp. */
  since?: string | undefined;
  kinds?: readonly string[] | undefined;
  /** Keep only the newest N entries (after the other filters). */
  limit?: number | undefined;
}

/** Parsed lines of one file; a missing file or a truncated line is not an error. */
function parseFile(file: string): InboxEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: InboxEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as InboxEntry;
      if (entry && typeof entry.ts === "string" && typeof entry.cwd === "string")
        entries.push(entry);
    } catch {
      // a line cut off mid-write
    }
  }
  return entries;
}

/**
 * Entries in file order (`inbox.1.jsonl`, then `inbox.jsonl`), so what was rotated stays visible
 * until it ages out; a missing file or a truncated line is not an error.
 */
export function readInbox(options: ReadInboxOptions = {}): InboxEntry[] {
  const { cwd, since, kinds, limit } = options;
  const root = cwd === undefined ? undefined : realDir(cwd);
  const inside = new Map<string, boolean>();
  const entries = [...parseFile(rotatedInboxFile()), ...parseFile(inboxFile())].filter((entry) => {
    if (since && entry.ts <= since) return false;
    if (kinds && !kinds.includes(entry.kind)) return false;
    if (root === undefined) return true;
    let ok = inside.get(entry.cwd);
    if (ok === undefined) inside.set(entry.cwd, (ok = within(root, entry.cwd)));
    return ok;
  });
  return limit !== undefined && limit >= 0
    ? entries.slice(Math.max(0, entries.length - limit))
    : entries;
}

/** What is stored per directory: the last acknowledged entry, who shares its ts, and ack memory. */
export interface InboxCursor {
  lastTs: string | null;
  /** `job:kind:ts` of the acknowledged entries at `lastTs`; null for a legacy cursor. */
  lastKeys: string[] | null;
  /** Entries with `ts <= lastTs` accounted for at ack time; growth means late appends. Null: legacy. */
  lastCount: number | null;
  /** Jobs whose entries were seen another way (`mate_wait`, `mate_result`); newest last. */
  ackedJobs: string[];
}

const cursorFile = (cwd: string): string =>
  path.join(cursorDir(), `${createHash("sha1").update(realDir(cwd)).digest("hex")}.json`);

function loadCursor(cwd: string): InboxCursor {
  const cursor: InboxCursor = { lastTs: null, lastKeys: null, lastCount: null, ackedJobs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorFile(cwd), "utf8")) as Record<string, unknown>;
    if (typeof parsed["lastTs"] === "string" && parsed["lastTs"]) cursor.lastTs = parsed["lastTs"];
    if (Array.isArray(parsed["lastKeys"]))
      cursor.lastKeys = parsed["lastKeys"].filter((k): k is string => typeof k === "string");
    const count = parsed["lastCount"];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0)
      cursor.lastCount = count;
    if (Array.isArray(parsed["ackedJobs"]))
      cursor.ackedJobs = parsed["ackedJobs"].filter((id): id is string => typeof id === "string");
  } catch {
    // no cursor yet, or a corrupt one
  }
  return cursor;
}

/** Writes through tmp+rename; an older `lastTs` never replaces a newer one already on disk. */
function saveCursor(cwd: string, cursor: InboxCursor): void {
  const current = loadCursor(cwd);
  if (current.lastTs !== null && cursor.lastTs !== null && current.lastTs > cursor.lastTs) return;
  const ackedJobs = [...new Set([...current.ackedJobs, ...cursor.ackedJobs])].slice(
    -MAX_ACKED_JOBS,
  );
  const file = cursorFile(cwd);
  fs.mkdirSync(cursorDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      lastTs: cursor.lastTs,
      lastKeys: cursor.lastKeys ?? [],
      lastCount: cursor.lastCount ?? 0,
      ackedJobs,
    }),
    { mode: 0o600 },
  );
  fs.renameSync(tmp, file);
}

/** The timestamp of the last entry acknowledged for `cwd`, or null if none was. */
export function readCursor(cwd: string): string | null {
  return loadCursor(cwd).lastTs;
}

/** Identifies an entry for tie-breaking at the cursor's timestamp. */
export const entryKey = (entry: InboxEntry): string => `${entry.job}:${entry.kind}:${entry.ts}`;

/**
 * Unread entries in the order they are shown and acknowledged: late appends first (an older ts than
 * the cursor, spotted because the count of entries at or before it grew), then the rest by ts.
 * "Unread" is `ts > lastTs`, or `ts === lastTs` with a key not in `lastKeys`. Mirrored in
 * hooks/inbox-state.mjs.
 */
export function selectUnread(
  entries: InboxEntry[],
  cursor: InboxCursor,
  firstRunSince: string,
): InboxEntry[] {
  let late: InboxEntry[] = [];
  let fresh: InboxEntry[];
  if (cursor.lastTs === null) {
    fresh = entries.filter((entry) => entry.ts > firstRunSince);
  } else {
    const lastTs = cursor.lastTs;
    const keys = new Set(cursor.lastKeys ?? []);
    const unreadTie = (entry: InboxEntry): boolean =>
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

/** The cursor once `shown` (a prefix of `selection`) was delivered; `lastTs` only moves forward. */
export function advanceCursor(
  cursor: InboxCursor,
  entries: InboxEntry[],
  selection: InboxEntry[],
  shown: InboxEntry[],
): InboxCursor {
  let lastTs = cursor.lastTs;
  for (const entry of shown) if (lastTs === null || entry.ts > lastTs) lastTs = entry.ts;
  if (lastTs === null) return cursor;
  const newTs = lastTs;
  const shownKeys = new Set(shown.map(entryKey));
  let lastKeys: string[];
  if (newTs === cursor.lastTs && cursor.lastKeys === null) {
    lastKeys = entries.filter((entry) => entry.ts === newTs).map(entryKey); // legacy: all read
  } else {
    lastKeys = newTs === cursor.lastTs ? [...(cursor.lastKeys ?? [])] : [];
    for (const entry of shown) if (entry.ts === newTs) lastKeys.push(entryKey(entry));
    lastKeys = [...new Set(lastKeys)];
  }
  const held = selection.filter((entry) => entry.ts < newTs && !shownKeys.has(entryKey(entry)));
  const lastCount = entries.filter((entry) => entry.ts <= newTs).length - held.length;
  return {
    lastTs: newTs,
    lastKeys,
    lastCount: Math.max(0, lastCount),
    ackedJobs: cursor.ackedJobs,
  };
}

/**
 * The oldest `limit` unread entries for `cwd` (all of them without a limit) and how many are
 * unread in total. Without a cursor only the last 24 hours count.
 */
export function unreadInbox(
  cwd: string,
  limit?: number,
  now: number = Date.now(),
): { entries: InboxEntry[]; total: number } {
  const entries = readInbox({ cwd });
  const selection = selectUnread(
    entries,
    loadCursor(cwd),
    new Date(now - FIRST_RUN_WINDOW_MS).toISOString(),
  );
  return {
    entries: limit !== undefined && limit >= 0 ? selection.slice(0, limit) : selection,
    total: selection.length,
  };
}

/** Marks `shown` (what `unreadInbox` returned) as read; whatever was not shown stays unread. */
export function ackShown(cwd: string, shown: InboxEntry[], now: number = Date.now()): void {
  if (shown.length === 0) return;
  const entries = readInbox({ cwd });
  const cursor = loadCursor(cwd);
  const selection = selectUnread(
    entries,
    cursor,
    new Date(now - FIRST_RUN_WINDOW_MS).toISOString(),
  );
  saveCursor(cwd, advanceCursor(cursor, entries, selection, shown));
}

/** Marks everything for `cwd` up to and including `ts` as read; the cursor never moves backwards. */
export function ackInbox(cwd: string, ts: string): void {
  const cursor = loadCursor(cwd);
  if (cursor.lastTs !== null && cursor.lastTs >= ts) return;
  const entries = readInbox({ cwd });
  saveCursor(cwd, {
    lastTs: ts,
    lastKeys: entries.filter((entry) => entry.ts === ts).map(entryKey),
    lastCount: entries.filter((entry) => entry.ts <= ts).length,
    ackedJobs: cursor.ackedJobs,
  });
}

/** Remembers that the entries of `jobId` were seen another way, without touching other unread ones. */
export function ackJob(cwd: string, jobId: string): void {
  const cursor = loadCursor(cwd);
  if (cursor.ackedJobs.includes(jobId)) return;
  saveCursor(cwd, { ...cursor, ackedJobs: [...cursor.ackedJobs, jobId] });
}

/**
 * A terminal job just read through `mate_wait` / `mate_result` / `jobs wait|result` needs no inbox
 * entry: acks it for the job's directory and for the one the caller works in. Never throws.
 */
export function ackTerminalJob(job: Pick<Job, "id" | "cwd" | "status">): void {
  if (!TERMINAL.includes(job.status)) return;
  for (const dir of new Set([job.cwd, process.cwd()])) {
    try {
      ackJob(dir, job.id);
    } catch {
      // the inbox is a convenience
    }
  }
}

/** `HH:MM:SS  <job>  <role>/<provider>  <kind>  <text>`, one entry per line (time is UTC). */
export function renderInboxEntry(entry: InboxEntry): string {
  const time = entry.ts.slice(11, 19) || entry.ts;
  const text = clip(entry.text.replace(/\s+/g, " ").trim(), MAX_ENTRY_TEXT);
  return `${time}  ${entry.job}  ${entry.role}/${entry.provider}  ${entry.kind}  ${text}`;
}

/** One line per entry; `remaining` unread entries that did not fit add a closing line. */
export function renderInbox(entries: InboxEntry[], remaining = 0): string {
  if (entries.length === 0) return "No new inbox entries.";
  const lines = entries.map(renderInboxEntry);
  if (remaining > 0) lines.push(`… ${remaining} more unread (run again)`);
  return lines.join("\n");
}

export interface InboxToolOptions {
  cwd?: string | undefined;
  unread?: boolean | undefined;
  ack?: boolean | undefined;
  limit?: number | undefined;
}

/** The text of the `mate_inbox` tool. Workers never read (or move) the host's inbox. */
export function inboxToolText(options: InboxToolOptions = {}): string {
  if (process.env["AGENTMATE_JOB_ID"])
    return "The inbox belongs to the host session that started this job; workers do not read it. Report your result instead.";
  const dir = options.cwd ?? process.cwd();
  const max = options.limit ?? 20;
  if (options.unread === false) {
    const entries = readInbox({ cwd: dir, limit: max });
    const last = entries.at(-1);
    if (options.ack !== false && last) ackInbox(dir, last.ts);
    return renderInbox(entries);
  }
  const { entries, total } = unreadInbox(dir, max);
  if (options.ack !== false) ackShown(dir, entries);
  return renderInbox(entries, total - entries.length);
}
