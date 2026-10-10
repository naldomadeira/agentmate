import type { JobEvent } from "../agents/types.js";
import { getAgent, installedOther } from "../agents/registry.js";
import { elapsedSeconds, summarize, type Observation } from "./api.js";
import type { ModelCatalog } from "./models.js";
import type { Session } from "./sessions.js";
import { TERMINAL, type Job } from "./store.js";

const MAX_RESULT_CHARS = 80_000;
const NOTES_MARKER = "\n\n---\n## Shared session notes (";
const CONTEXT_MARKER = "\n\n---\n## Session context (";
const MAX_CONTEXT_DISPLAY_CHARS = 2_000;

export function renderResult(job: Job, text: string | null): string {
  const head = summarize(job);
  if (!TERMINAL.includes(job.status)) {
    return `${head}\n\nStill ${job.status}. Call wait again, or observe for a progress snapshot.`;
  }
  if (job.status !== "done") {
    const other = job.status === "quota_exhausted" ? installedOther(job.provider) : undefined;
    const hint =
      job.status === "timeout" && job.sessionId && getAgent(job.provider).capabilities.resume
        ? `\nThe session is resumable: start a new job with continue=${job.id}.`
        : job.status === "quota_exhausted"
          ? other
            ? `\nHand off: start the same job with provider ${other}.`
            : "\nHand off: no other agent CLI is installed; retry after the quota resets."
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
  // Skip the session context and shared-notes blocks that sessions put after the role prompt.
  let own = job.prompt;
  const ctx = own.indexOf(CONTEXT_MARKER);
  if (ctx >= 0) own = own.slice(0, ctx);
  const notes = own.indexOf(NOTES_MARKER);
  if (notes >= 0) own = own.slice(0, notes);
  const prompt = own.replace(/\s+/g, " ").slice(0, 60);
  const session = job.session ? `session ${job.session}  ` : "";
  const model =
    job.model || job.effort
      ? `${[job.model ?? "default", job.effort].filter(Boolean).join("·")}  `
      : "";
  return `${job.id}  ${job.status.padEnd(8)} ${job.role.padEnd(11)} ${job.provider}/${job.mode}  ${elapsedSeconds(job)}s  ${model}${session}${prompt}`;
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

export interface StatusRunning {
  id: string;
  provider: string;
  model: string;
  elapsed_seconds: number;
  cwd: string;
}

export interface StatusUnread {
  total: number;
  failed: number;
}

/** Keeps the status bar legible: the family name a person recognizes, not the full id
 *  (`gpt-5.6-terra` → `terra`, `claude-sonnet-4-6` → `sonnet`, `gemini-3.1-pro-high` → `3.1-pro`). */
export function shortModel(model: string | undefined): string {
  const value = model ?? "default";
  const gpt = /^gpt-[\d.]+-([a-z]+)$/.exec(value);
  if (gpt?.[1]) return gpt[1];
  const claude = /^claude-([a-z]+)-/.exec(value);
  if (claude?.[1]) return claude[1];
  const gemini = /^gemini-([\d.]+-[a-z]+)/.exec(value);
  if (gemini?.[1]) return gemini[1];
  return value.length <= 10 ? value : `${value.slice(0, 9)}…`;
}

/** Terminal states that mean the work did not land: shown apart from the plain unread count. */
export function isFailedStatus(status: Job["status"] | undefined): boolean {
  return status === "error" || status === "timeout" || status === "quota_exhausted";
}

export function statusRunning(job: Job): StatusRunning {
  return {
    id: job.id,
    provider: job.provider,
    model: shortModel(job.usage?.model ?? job.model),
    elapsed_seconds: elapsedSeconds(job),
    cwd: job.cwd,
  };
}

function statusElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

/** One compact status-bar line, or the empty string while this directory is idle. */
export function renderStatusLine(running: StatusRunning[], unread: StatusUnread): string {
  if (running.length === 0 && unread.total === 0) return "";
  let line = "mate";
  if (running.length > 0) {
    const shown = running
      .slice(0, 3)
      .map((job) => `${job.provider}/${job.model} ${statusElapsed(job.elapsed_seconds)}`)
      .join(" · ");
    line += ` ▶${running.length} ${shown}`;
  }
  if (unread.total > 0) line += `${running.length > 0 ? " ·" : ""} ✓${unread.total} unread`;
  if (unread.failed > 0) line += ` ✗${unread.failed}`;
  return line;
}

/** One provider's catalog as a small table, or why it has none. */
export function renderModels(catalog: ModelCatalog): string {
  const lines = [`Provider: ${catalog.provider}`];
  if (!catalog.available) {
    lines.push(`Available: false`);
    if (catalog.note) lines.push(`Note: ${catalog.note}`);
    return lines.join("\n");
  }
  lines.push(`Source: ${catalog.source}`);
  if (catalog.note) lines.push(`Note: ${catalog.note}`);
  lines.push("");
  lines.push("ID | Label | Efforts | Default Effort");
  lines.push("---|-------|---------|---------------");
  for (const m of catalog.models) {
    const efforts = m.efforts ? m.efforts.join(", ") : "-";
    const defaultEffort = m.defaultEffort || "-";
    const label = m.label || "-";
    lines.push(`${m.id} | ${label} | ${efforts} | ${defaultEffort}`);
  }
  return lines.join("\n");
}

function renderContext(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) return "(no context)";
  if (trimmed.length <= MAX_CONTEXT_DISPLAY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_CONTEXT_DISPLAY_CHARS)}\n\n…[truncated, ${trimmed.length} characters total]`;
}

/** A session, its context, its notes (the tail the workers see) and the jobs started in it, newest first. */
export function renderSession(session: Session, notes: string, jobs: Job[], context = ""): string {
  const sections = [
    `session ${session.id} · ${session.title}`,
    `cwd: ${session.cwd}\ncreated: ${session.createdAt} · updated: ${session.updatedAt}`,
    `context:\n${renderContext(context)}`,
    `jobs:\n${renderList([...jobs].reverse())
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}`,
    `notes:\n${notes.trim() ? notes.trim() : "(no notes)"}`,
  ];
  return sections.join("\n\n");
}

/** One line per session, newest first. */
export function renderSessionList(
  sessions: Session[],
  jobCounts: ReadonlyMap<string, number> = new Map(),
): string {
  if (sessions.length === 0) return "No sessions.";
  return sessions
    .map(
      (session) =>
        `${session.id}  ${jobCounts.get(session.id) ?? 0} job(s)  ${session.updatedAt.slice(0, 19)}Z  ${session.cwd}  ${session.title}`,
    )
    .join("\n");
}
