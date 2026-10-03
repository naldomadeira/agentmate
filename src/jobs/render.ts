import type { JobEvent } from "../agents/types.js";
import { elapsedSeconds, summarize, type Observation } from "./api.js";
import { TERMINAL, type Job } from "./store.js";

const MAX_RESULT_CHARS = 80_000;

export function renderResult(job: Job, text: string | null): string {
  const head = summarize(job);
  if (!TERMINAL.includes(job.status)) {
    return `${head}\n\nStill ${job.status}. Call wait again, or observe for a progress snapshot.`;
  }
  if (job.status !== "done") {
    const hint =
      job.status === "timeout" && job.sessionId
        ? `\nThe session is resumable: start a new job with continue=${job.id}.`
        : "";
    return `${head}${text ? `\n\nPartial output:\n${text}` : ""}${hint}`;
  }
  const body = text ?? "(no output)";
  return `${head}\n\n${body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n\n…[truncated]` : body}`;
}

/** `HH:MM:SS  level     kind     text`, one event per line (time is UTC, from the ISO stamp). */
export function renderEvent(event: JobEvent): string {
  const time = event.ts.slice(11, 19) || event.ts;
  const text = event.text.replace(/\s+/g, " ").trim();
  return `${time}  ${event.level.padEnd(9)} ${event.kind.padEnd(8)} ${text}`;
}

export function renderEvents(events: JobEvent[]): string {
  return events.length > 0 ? events.map(renderEvent).join("\n") : "No events.";
}

export function renderObservation({
  job,
  children,
  events,
  stdoutTail,
  stderrTail,
}: Observation): string {
  const sections = [summarize(job)];
  if (children.length > 0)
    sections.push(`children:\n${children.map((child) => `  ${listLine(child)}`).join("\n")}`);
  if (events.length > 0) sections.push(`events:\n${events.map(renderEvent).join("\n")}`);
  if (stdoutTail.trim()) sections.push(`stdout (tail):\n${stdoutTail.trim()}`);
  if (stderrTail.trim()) sections.push(`stderr (tail):\n${stderrTail.trim()}`);
  if (sections.length === 1) sections.push("No output yet.");
  return sections.join("\n\n");
}

function listLine(job: Job): string {
  const prompt = job.prompt.replace(/\s+/g, " ").slice(0, 60);
  return `${job.id}  ${job.status.padEnd(8)} ${job.role.padEnd(9)} ${job.provider}/${job.mode}  ${elapsedSeconds(job)}s  ${prompt}`;
}

/** Newest first; a job whose parent is also listed is indented beneath it, oldest child first. */
export function renderList(jobs: Job[]): string {
  if (jobs.length === 0) return "No jobs.";
  const listed = new Set(jobs.map((job) => job.id));
  const childrenOf = (id: string) =>
    jobs
      .filter((job) => job.parentJob === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lines: string[] = [];
  const add = (job: Job, indent: string): void => {
    lines.push(`${indent}${listLine(job)}`);
    for (const child of childrenOf(job.id)) add(child, `${indent}  `);
  };
  for (const job of jobs) if (!job.parentJob || !listed.has(job.parentJob)) add(job, "");
  return lines.join("\n");
}
