import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homeDir, type JobRole, type Provider } from "./store.js";

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

export const inboxFile = (): string => path.join(homeDir(), "inbox.jsonl");
const rotatedFile = (): string => path.join(homeDir(), "inbox.1.jsonl");
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

/** Appends one line (0600); a file past the size cap is first renamed over `inbox.1.jsonl`. */
export function appendInbox(entry: InboxEntry): void {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(inboxFile()).size > MAX_INBOX_BYTES) fs.renameSync(inboxFile(), rotatedFile());
  } catch {
    // no inbox yet, or a racing process already rotated it
  }
  fs.appendFileSync(inboxFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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

/** Entries oldest first (newest last); a missing file or a truncated line is not an error. */
export function readInbox(options: ReadInboxOptions = {}): InboxEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(inboxFile(), "utf8");
  } catch {
    return [];
  }
  const { cwd, since, kinds, limit } = options;
  const root = cwd === undefined ? undefined : realDir(cwd);
  const entries: InboxEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: InboxEntry;
    try {
      entry = JSON.parse(line) as InboxEntry;
    } catch {
      continue; // a line cut off mid-write
    }
    if (!entry || typeof entry.ts !== "string" || typeof entry.cwd !== "string") continue;
    if (since && entry.ts <= since) continue;
    if (kinds && !kinds.includes(entry.kind)) continue;
    if (root !== undefined && !within(root, entry.cwd)) continue;
    entries.push(entry);
  }
  return limit !== undefined && limit >= 0
    ? entries.slice(Math.max(0, entries.length - limit))
    : entries;
}

const cursorFile = (cwd: string): string =>
  path.join(cursorDir(), `${createHash("sha1").update(realDir(cwd)).digest("hex")}.json`);

/** The timestamp of the last entry acknowledged for `cwd`, or null if none was. */
export function readCursor(cwd: string): string | null {
  try {
    const { lastTs } = JSON.parse(fs.readFileSync(cursorFile(cwd), "utf8")) as { lastTs?: unknown };
    return typeof lastTs === "string" && lastTs ? lastTs : null;
  } catch {
    return null;
  }
}

/** Entries for `cwd` after its cursor; with `limit`, the newest N. */
export function unreadInbox(cwd: string, limit?: number): InboxEntry[] {
  return readInbox({ cwd, since: readCursor(cwd) ?? undefined, limit });
}

/** Moves the cursor of `cwd` to `ts`; it never moves backwards. */
export function ackInbox(cwd: string, ts: string): void {
  const current = readCursor(cwd);
  if (current !== null && current >= ts) return;
  fs.mkdirSync(cursorDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cursorFile(cwd), JSON.stringify({ lastTs: ts }), { mode: 0o600 });
}

/** `HH:MM:SS  <job>  <role>/<provider>  <kind>  <text>`, one entry per line (time is UTC). */
export function renderInboxEntry(entry: InboxEntry): string {
  const time = entry.ts.slice(11, 19) || entry.ts;
  const text = entry.text.replace(/\s+/g, " ").trim();
  return `${time}  ${entry.job}  ${entry.role}/${entry.provider}  ${entry.kind}  ${text}`;
}

export function renderInbox(entries: InboxEntry[]): string {
  return entries.length > 0 ? entries.map(renderInboxEntry).join("\n") : "No new inbox entries.";
}
