import type { EventLevel, JobEvent } from "../agents/types.js";
import { otherAgent } from "../agents/registry.js";
import { cancelJob, isTerminal, readResult, startJob, waitJob, type StartOptions } from "./api.js";
import { appendEvent } from "./events.js";
import {
  DEFAULT_MAX_ROUNDS,
  readJob,
  updateJob,
  writeResult,
  type Job,
  type JobStatus,
  type Verdict,
  type WorkflowRound,
} from "./store.js";

/** How much of the implementer's report travels to the reviewer as context. */
const CONTEXT_CHARS = 4_000;
/** Review findings are passed on the command line, so they are bounded. */
const FINDINGS_CHARS = 20_000;
/** How long one wait on a child lasts before the workflow re-checks cancellation and its deadline. */
const SLICE_MS = 1_000;

const REVIEW_TARGET =
  "the uncommitted working-tree diff (`git diff`, plus `git status` for untracked files)";

/** Matches `Verdict: approve`, `**Verdict:** request-changes` and similar; the last match wins. */
const VERDICT_LINE = /^\s*\**Verdict:\**\s*(approve|request-changes)(?![\w-])/gim;

/** The reviewer's verdict: its last verdict line, or `none` when it gave no clear one. */
export function parseVerdict(text: string): Verdict {
  let verdict: Verdict = "none";
  for (const match of text.matchAll(VERDICT_LINE)) verdict = match[1]!.toLowerCase() as Verdict;
  return verdict;
}

/** Ends the workflow early with a final status; thrown from a step, caught by the runner. */
class Stop extends Error {
  constructor(
    readonly status: Exclude<JobStatus, "queued" | "running" | "done">,
    message: string,
  ) {
    super(message);
  }
}

interface Child {
  id: string;
  label: string;
}

interface ReportInput {
  job: Job;
  reviewer: string;
  rounds: WorkflowRound[];
  children: Child[];
  outcome: string;
  finalReview: string | null;
  changes: string | null;
  needsHuman: string | null;
}

function renderReport(input: ReportInput): string {
  const { job, rounds, children } = input;
  const task = job.fields?.task ?? job.prompt;
  const acceptance = job.fields?.acceptance;
  const table =
    rounds.length > 0
      ? [
          "| Round | Implement job | Review job | Verdict |",
          "| --- | --- | --- | --- |",
          ...rounds.map(
            (round, index) =>
              `| ${index + 1} | \`${round.implementJob}\` | \`${round.reviewJob}\` | ${round.verdict} |`,
          ),
        ].join("\n")
      : "No round finished.";
  const sections = [
    `# Cross-review: ${job.provider} implements, ${input.reviewer} reviews`,
    input.outcome,
    `## Task\n\n${task}${acceptance ? `\n\nAcceptance criteria:\n${acceptance}` : ""}`,
    `## Rounds\n\n${table}`,
    `## Final review\n\n${input.finalReview?.trim() || "(no review ran)"}`,
    `## Changes\n\n${input.changes?.trim() || "(no implement result)"}`,
  ];
  if (input.needsHuman) sections.push(`## Needs human\n\n${input.needsHuman}`);
  sections.push(
    `## Next steps\n\n${
      children.length > 0
        ? children
            .map((child) => `- \`jobs result ${child.id}\` (${child.label}), or \`mate_result\``)
            .join("\n")
        : "- No child job was started."
    }`,
  );
  return `${sections.join("\n\n")}\n`;
}

const briefFindings = (text: string) =>
  text.length > FINDINGS_CHARS ? `${text.slice(0, FINDINGS_CHARS)}\n…[truncated]` : text;

/**
 * Runs a crossreview job to completion: the implementer edits, the other agent reviews the
 * uncommitted diff, and the loop stops on approval, on a missing verdict or when the rounds run out.
 * Every step is a child job started with `startJob`, so it carries this job as `parentJob`.
 */
export async function runCrossreview(id: string): Promise<void> {
  const job = readJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);

  const startedAt = Date.now();
  const deadline = startedAt + job.timeoutMs;
  updateJob(id, {
    status: "running",
    workerPid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
  });

  const implementer = job.provider;
  const reviewer = otherAgent(implementer);
  const maxRounds = job.workflow?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const task = job.fields?.task ?? job.prompt;
  const acceptance = job.fields?.acceptance;

  /** Events are a progress aid; failing to record one must never fail the workflow. */
  const emit = (level: EventLevel, kind: JobEvent["kind"], text: string): void => {
    try {
      appendEvent(id, { ts: new Date().toISOString(), job: id, level, kind, text });
    } catch {
      // ignored on purpose
    }
  };
  emit("important", "started", `${implementer} implements, ${reviewer} reviews (max ${maxRounds})`);

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  const deadlineMessage = `Exceeded the ${Math.round(job.timeoutMs / 60_000)} minute job deadline.`;

  const rounds: WorkflowRound[] = [];
  const children: Child[] = [];
  let finalReview: string | null = null;
  let changes: string | null = null;
  let outcome = "";
  let needsHuman: string | null = null;
  let status: JobStatus = "error";
  let error: string | undefined;

  const saveRounds = (): void => {
    try {
      updateJob(id, { workflow: { maxRounds, rounds: [...rounds] } });
    } catch {
      // progress bookkeeping must not fail the workflow
    }
  };

  /** Starts one child job, waits for it, and returns its result; anything but `done` stops the workflow. */
  async function step(
    label: string,
    options: StartOptions,
    onStarted?: (childId: string) => void,
  ): Promise<{ job: Job; text: string }> {
    if (controller.signal.aborted) throw new Stop("canceled", "Canceled.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Stop("timeout", deadlineMessage);

    let child: Job;
    try {
      child = startJob({ ...options, timeoutMinutes: Math.max(remaining / 60_000, 1 / 60) });
    } catch (cause) {
      throw new Stop(
        "error",
        `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    children.push({ id: child.id, label });
    onStarted?.(child.id);
    emit("important", "started", `${label} started ${child.id}`);

    let settled = child;
    for (;;) {
      settled = await waitJob(child.id, SLICE_MS);
      if (isTerminal(settled)) break;
      if (controller.signal.aborted) {
        await cancelJob(child.id);
        throw new Stop("canceled", "Canceled.");
      }
      if (Date.now() >= deadline) {
        await cancelJob(child.id);
        throw new Stop("timeout", deadlineMessage);
      }
    }
    if (settled.status !== "done") {
      if (controller.signal.aborted) throw new Stop("canceled", "Canceled.");
      if (Date.now() >= deadline) throw new Stop("timeout", deadlineMessage);
      throw new Stop(
        "error",
        `${label} job ${child.id} ended ${settled.status}${settled.error ? `: ${settled.error}` : ""}`,
      );
    }
    emit("important", "message", `${label} finished ${child.id}`);
    return { job: settled, text: readResult(child.id).text ?? "" };
  }

  try {
    let previousImplement: Job | undefined;
    let findings = "";
    for (let round = 1; round <= maxRounds; round++) {
      const implementOptions: StartOptions =
        round === 1 || !previousImplement
          ? {
              provider: implementer,
              role: "implement",
              fields: { task, ...(acceptance ? { acceptance } : {}) },
              mode: "write",
              cwd: job.cwd,
              model: job.model,
            }
          : {
              provider: implementer,
              role: "implement",
              fields: {
                task: `Address these review findings, then summarize what changed.\n\nReview findings:\n${briefFindings(findings)}`,
                ...(acceptance ? { acceptance } : {}),
              },
              mode: "write",
              cwd: job.cwd,
              model: job.model,
              continueJob: previousImplement.id,
            };
      const implement = await step(`round ${round}: implement`, implementOptions);
      previousImplement = implement.job;
      changes = implement.text;

      let reviewId = "";
      let review: { job: Job; text: string };
      try {
        review = await step(
          `round ${round}: review`,
          {
            provider: reviewer,
            role: "review",
            fields: {
              target: REVIEW_TARGET,
              focus: `Whether the change fulfils this task${acceptance ? " and its acceptance criteria" : ""}: ${task}${acceptance ? `\n\nAcceptance criteria:\n${acceptance}` : ""}`,
              context: implement.text.slice(0, CONTEXT_CHARS),
            },
            mode: "read-only",
            cwd: job.cwd,
          },
          (childId) => {
            reviewId = childId;
          },
        );
      } catch (failure) {
        if (reviewId) {
          rounds.push({ implementJob: implement.job.id, reviewJob: reviewId, verdict: "none" });
          saveRounds();
        }
        throw failure;
      }
      finalReview = review.text;
      const verdict = parseVerdict(review.text);
      rounds.push({ implementJob: implement.job.id, reviewJob: review.job.id, verdict });
      saveRounds();

      if (verdict === "approve") {
        emit("important", "message", `round ${round}: review verdict approve`);
        outcome = `**Outcome:** approved by ${reviewer} in round ${round} of ${maxRounds}.`;
        status = "done";
        break;
      }
      if (verdict === "none") {
        emit(
          "important",
          "message",
          `round ${round}: review verdict none (no clear verdict, stopping for a human)`,
        );
        outcome = `**Outcome:** stopped in round ${round} of ${maxRounds}: ${reviewer} gave no clear verdict.`;
        needsHuman = `${reviewer} did not end its review with \`Verdict: approve\` or \`Verdict: request-changes\`, so the workflow stopped instead of looping blindly. Read the final review above and the review job \`${review.job.id}\`, then decide whether to accept the changes, fix them by hand or run another cross-review.`;
        status = "done";
        break;
      }
      emit("important", "message", `round ${round}: review verdict request-changes`);
      if (round === maxRounds) {
        emit("important", "message", `round budget exhausted after ${maxRounds} round(s)`);
        outcome = `**Outcome:** round budget exhausted: ${reviewer} still requested changes after ${maxRounds} round(s). The latest changes are in the working tree; review the open findings under Final review before accepting them.`;
        status = "done";
        break;
      }
      findings = review.text;
    }
  } catch (failure) {
    if (failure instanceof Stop) {
      status = failure.status;
      error = failure.status === "canceled" ? undefined : failure.message;
      outcome = `**Outcome:** ${failure.status === "canceled" ? "canceled" : `stopped (${failure.status})`}: ${failure.message}`;
    } else {
      status = "error";
      error = failure instanceof Error ? failure.message : String(failure);
      outcome = `**Outcome:** stopped: ${error}`;
    }
    emit(
      "important",
      "error",
      `${status}: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  } finally {
    try {
      writeResult(
        id,
        renderReport({
          job,
          reviewer,
          rounds,
          children,
          outcome,
          finalReview,
          changes,
          needsHuman,
        }),
      );
    } catch {
      // a report that cannot be written must not hide the terminal status
    }
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    emit(
      "important",
      "finished",
      status === "done" ? `done · ${seconds}s` : (error ?? `${status} · ${seconds}s`),
    );
    updateJob(id, {
      status,
      ...(error ? { error } : {}),
      finishedAt: new Date().toISOString(),
    });
  }
}
