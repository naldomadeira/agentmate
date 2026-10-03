import fs from "node:fs";
import path from "node:path";
import type { EventLevel, JobEvent } from "../agents/types.js";
import { appendInbox, INBOX_KINDS, type InboxKind } from "./inbox.js";
import { jobDir, readJob } from "./store.js";

export const eventsFile = (id: string) => path.join(jobDir(id), "events.jsonl");

/** Appends one event as a JSON line; the job directory already exists once the job is written. */
export function appendEvent(id: string, event: JobEvent): void {
  fs.appendFileSync(eventsFile(id), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  if (event.level === "important" && INBOX_KINDS.includes(event.kind)) copyToInbox(id, event);
}

/** Important messages, errors and finishes also land in the inbox; this path never throws. */
function copyToInbox(id: string, event: JobEvent): void {
  try {
    const job = readJob(id);
    if (!job) return;
    appendInbox({
      ts: event.ts,
      job: id,
      cwd: job.cwd,
      ...(job.session ? { session: job.session } : {}),
      provider: job.provider,
      role: job.role,
      kind: event.kind as InboxKind,
      text: event.text,
    });
  } catch {
    // The inbox is a convenience; the job and its event log must not fail because of it.
  }
}

export interface ReadEventsOptions {
  /** Only events strictly after this ISO timestamp. */
  since?: string | undefined;
  levels?: readonly EventLevel[] | undefined;
  /** Keep only the newest N events (after the other filters). */
  limit?: number | undefined;
}

/** Events oldest first; a missing file or a truncated last line is not an error. */
export function readEvents(id: string, options: ReadEventsOptions = {}): JobEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile(id), "utf8");
  } catch {
    return [];
  }
  const events: JobEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as JobEvent);
    } catch {
      // A line cut off mid-write (or corrupted) is skipped.
    }
  }
  const { since, levels, limit } = options;
  const filtered = events.filter(
    (event) => (!since || event.ts > since) && (!levels || levels.includes(event.level)),
  );
  return limit !== undefined && limit >= 0
    ? filtered.slice(Math.max(0, filtered.length - limit))
    : filtered;
}
