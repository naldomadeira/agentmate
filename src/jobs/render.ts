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

export function renderObservation({ job, stdoutTail, stderrTail }: Observation): string {
  const sections = [summarize(job)];
  if (stdoutTail.trim()) sections.push(`stdout (tail):\n${stdoutTail.trim()}`);
  if (stderrTail.trim()) sections.push(`stderr (tail):\n${stderrTail.trim()}`);
  if (sections.length === 1) sections.push("No output yet.");
  return sections.join("\n\n");
}

export function renderList(jobs: Job[]): string {
  if (jobs.length === 0) return "No jobs.";
  return jobs
    .map(
      (job) =>
        `${job.id}  ${job.status.padEnd(8)} ${job.provider}/${job.mode}  ${elapsedSeconds(job)}s  ${job.prompt.replace(/\s+/g, " ").slice(0, 60)}`,
    )
    .join("\n");
}
