import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { EventLevel, JobEvent } from "../agents/types.js";
import { isAgentId, otherAgent } from "../agents/registry.js";
import { cancelJob, getJob, isTerminal, readResult, startJob, type StartOptions } from "./api.js";
import { parseVerdict } from "./crossreview.js";
import { appendEvent } from "./events.js";
import { appendNotes, createSession, attachJob } from "./sessions.js";
import {
  DEFAULT_MAX_PARTS,
  homeDir,
  readJob,
  updateJob,
  writeResult,
  type Job,
  type JobStatus,
  type Provider,
  type SplitPart,
} from "./store.js";

const execFileAsync = promisify(execFile);

/** How much of a part's result travels to its reviewer as context. */
const CONTEXT_CHARS = 4_000;
/** How much of one part's research result goes into the merged read-only summary. */
const SUMMARY_CHARS = 3_000;
/** How long the workflow sleeps between checks of its children, cancellation and its deadline. */
const SLICE_MS = 250;
const TITLE_CHARS = 60;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A part as the planner described it; `SplitPart` in `job.split` keeps only the progress. */
export interface PlannedPart {
  id: string;
  title: string;
  briefing: string;
  files: string[];
  agent: Provider;
}

export type ParsedPlan = { ok: true; parts: PlannedPart[] } | { ok: false; reason: string };

const FENCED_JSON = /```json[^\S\n]*\n([\s\S]*?)```/gi;
const PART_ID = /^[a-z0-9-]+$/;

/**
 * Reads the parts block of a planner's answer: the last fenced json block, checked for 1..maxParts
 * parts with unique ids, a title and a briefing. A missing or unknown agent is assigned by
 * alternating between the agents, starting with the one that is not the planner.
 */
export function parseSplitPlan(
  text: string,
  options: { maxParts: number; planner: Provider },
): ParsedPlan {
  let block: string | undefined;
  for (const match of text.matchAll(FENCED_JSON)) block = match[1];
  if (block === undefined) return { ok: false, reason: "no fenced json block" };

  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch {
    return { ok: false, reason: "the json block does not parse" };
  }
  const list = (data as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(list)) return { ok: false, reason: "the json block has no parts array" };
  if (list.length < 1 || list.length > options.maxParts)
    return {
      ok: false,
      reason: `${list.length} part(s), expected 1 to ${options.maxParts}`,
    };

  let fallback = otherAgent(options.planner);
  const seen = new Set<string>();
  const parts: PlannedPart[] = [];
  for (const [index, raw] of list.entries()) {
    const part = (raw ?? {}) as Record<string, unknown>;
    const id = part["id"];
    if (typeof id !== "string" || !PART_ID.test(id))
      return {
        ok: false,
        reason: `part ${index + 1} has no valid id (lowercase letters, digits, -)`,
      };
    if (seen.has(id)) return { ok: false, reason: `duplicate part id ${id}` };
    seen.add(id);
    const briefing = part["briefing"];
    if (typeof briefing !== "string" || !briefing.trim())
      return { ok: false, reason: `part ${id} has no briefing` };
    const title = typeof part["title"] === "string" && part["title"].trim() ? part["title"] : id;
    const files = Array.isArray(part["files"])
      ? part["files"].filter((file): file is string => typeof file === "string")
      : [];
    let agent: Provider;
    if (isAgentId(part["agent"])) agent = part["agent"];
    else {
      agent = fallback;
      fallback = otherAgent(fallback);
    }
    parts.push({ id, title: title.trim(), briefing: briefing.trim(), files, agent });
  }
  return { ok: true, parts };
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

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (cause) {
    const failure = cause as { stderr?: string; message: string };
    const detail = failure.stderr?.trim().split("\n")[0] || failure.message;
    throw new Error(detail);
  }
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const code = (value: string | undefined) => (value ? `\`${value}\`` : "-");
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;

interface ReportInput {
  job: Job;
  goal: string;
  acceptance: string | undefined;
  parts: SplitPart[];
  children: Child[];
  outcome: string;
  write: boolean;
  results: Map<string, string>;
  changed: Map<string, boolean>;
  needsHuman: string[];
}

function renderReport(input: ReportInput): string {
  const { job, parts, children, write } = input;
  const finished = parts.filter((part) => input.results.has(part.id));

  const table =
    parts.length > 0
      ? [
          "| Part | Title | Agent | Part job | Review job | Verdict | Branch |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...parts.map(
            (part) =>
              `| ${part.id} | ${cell(part.title)} | ${part.agent} | ${code(part.partJob)} | ${code(part.reviewJob)} | ${part.verdict} | ${write ? code(part.branch) : "-"} |`,
          ),
        ].join("\n")
      : "No part was planned.";

  let integration: string;
  if (finished.length === 0) integration = "No part finished, so there is nothing to integrate.";
  else if (write) {
    const merges = finished.map((part) => {
      const note = !input.changed.get(part.id)
        ? "  # no changes on this branch"
        : part.verdict === "approve"
          ? ""
          : "  # review this part before merging (see Needs human)";
      return `git merge ${part.branch}${note}`;
    });
    const cleanup = finished
      .filter((part) => part.worktree)
      .map((part) => `git worktree remove ${part.worktree}`);
    integration = [
      `Each part is committed on its own branch, created from \`${finished[0]?.base?.slice(0, 12) ?? "HEAD"}\`. From \`${job.cwd}\`, merge them in this order:`,
      `\`\`\`bash\n${merges.join("\n")}\n\`\`\``,
      "Merge conflicts are not resolved automatically: if two parts collide, resolve them by hand or ask an agent. Nothing has been merged, pushed or deleted for you.",
      `After merging, remove the worktrees (and delete the branches with \`git branch -d\`):`,
      `\`\`\`bash\n${cleanup.join("\n")}\n\`\`\``,
    ].join("\n\n");
  } else {
    integration = finished
      .map(
        (part) =>
          `### ${part.id} · ${cell(part.title)} (${part.agent}, review: ${part.verdict})\n\n${clip(input.results.get(part.id) ?? "", SUMMARY_CHARS).trim()}`,
      )
      .join("\n\n");
  }

  const sections = [
    `# Split: ${job.provider} plans ${parts.length || "no"} part(s), the other agent reviews`,
    input.outcome,
    `## Goal\n\n${input.goal}${input.acceptance ? `\n\nAcceptance criteria:\n${input.acceptance}` : ""}`,
    `## Parts\n\n${table}`,
    `## Integration\n\n${integration}`,
  ];
  if (input.needsHuman.length > 0)
    sections.push(`## Needs human\n\n${input.needsHuman.map((line) => `- ${line}`).join("\n")}`);
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

/**
 * Runs a split job to completion: a planner divides the goal into independent parts, the parts run
 * in parallel (research read-only, or implement in one git worktree each), the other agent reviews
 * each finished part, and the report says how to integrate them. Every step is a child job started
 * with `startJob`, so it carries this job as `parentJob` and its session.
 */
export async function runSplit(id: string): Promise<void> {
  const job = readJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);

  const startedAt = Date.now();
  const deadline = startedAt + job.timeoutMs;
  updateJob(id, {
    status: "running",
    workerPid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
  });

  const planner = job.provider;
  const maxParts = job.split?.maxParts ?? DEFAULT_MAX_PARTS;
  const goal = job.fields?.goal ?? job.prompt;
  const acceptance = job.fields?.acceptance;
  const write = job.mode === "write";

  /** Events are a progress aid; failing to record one must never fail the workflow. */
  const emit = (level: EventLevel, kind: JobEvent["kind"], text: string): void => {
    try {
      appendEvent(id, { ts: new Date().toISOString(), job: id, level, kind, text });
    } catch {
      // ignored on purpose
    }
  };
  emit(
    "important",
    "started",
    `${planner} plans up to ${maxParts} parts (${write ? "write, one worktree each" : "read-only"})`,
  );

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  const deadlineMessage = `Exceeded the ${Math.round(job.timeoutMs / 60_000)} minute job deadline.`;

  const parts: SplitPart[] = [];
  const planned = new Map<string, PlannedPart>();
  const children: Child[] = [];
  const results = new Map<string, string>();
  const reviews = new Map<string, string>();
  const changed = new Map<string, boolean>();
  const failures: string[] = [];
  const failedJobs: string[] = [];
  const needsHuman: string[] = [];
  let session = job.session;
  let outcome = "";
  let status: JobStatus = "error";
  let error: string | undefined;

  const saveParts = (): void => {
    try {
      updateJob(id, { split: { maxParts, parts: parts.map((part) => ({ ...part })) } });
    } catch {
      // progress bookkeeping must not fail the workflow
    }
  };
  const note = (text: string): void => {
    if (!session) return;
    try {
      appendNotes(session, text, "split");
    } catch {
      // notes are shared context, not part of the outcome
    }
  };

  const checkLive = (): void => {
    if (controller.signal.aborted) throw new Stop("canceled", "Canceled.");
    if (Date.now() >= deadline) throw new Stop("timeout", deadlineMessage);
  };

  /** Starts one child job in the session; its deadline is what is left of the workflow's. */
  function begin(label: string, options: StartOptions): Job {
    checkLive();
    const remaining = deadline - Date.now();
    let child: Job;
    try {
      child = startJob({
        ...options,
        ...(session ? { sessionId: session } : {}),
        timeoutMinutes: Math.max(remaining / 60_000, 1 / 60),
      });
    } catch (cause) {
      throw new Stop(
        "error",
        `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    children.push({ id: child.id, label });
    emit("important", "started", `${label} started ${child.id}`);
    return child;
  }

  /** Waits until every job is terminal; on cancellation or deadline the unfinished ones are canceled. */
  async function settle(label: string, started: Job[]): Promise<Job[]> {
    const settled = new Map<string, Job>();
    for (;;) {
      for (const child of started) {
        if (settled.has(child.id)) continue;
        const current = getJob(child.id);
        if (isTerminal(current)) {
          settled.set(child.id, current);
          const name = children.find((c) => c.id === child.id)?.label ?? label;
          emit(
            "important",
            current.status === "done" ? "message" : "error",
            `${name} ${current.status === "done" ? "finished" : current.status} ${child.id}`,
          );
        }
      }
      if (settled.size === started.length) return started.map((child) => settled.get(child.id)!);
      const pending = started.filter((child) => !settled.has(child.id));
      const stopWith = controller.signal.aborted
        ? new Stop("canceled", "Canceled.")
        : Date.now() >= deadline
          ? new Stop("timeout", deadlineMessage)
          : null;
      if (stopWith) {
        await Promise.all(pending.map((child) => cancelJob(child.id).catch(() => undefined)));
        throw stopWith;
      }
      await sleep(SLICE_MS);
    }
  }

  const failure = (child: Job) =>
    `job ${child.id} ended ${child.status}${child.error ? `: ${child.error}` : ""}`;

  const workflowBriefing = (part: PlannedPart): string =>
    [
      part.briefing,
      `Files for this part: ${part.files.length > 0 ? part.files.join(", ") : "(not specified; stay within the briefing)"}`,
      `Overall goal (other parts are handled in parallel by other agents; do not do their work): ${goal}`,
      ...(acceptance ? [`Acceptance criteria for the whole goal:\n${acceptance}`] : []),
    ].join("\n\n");

  /** Commits what the implementer left in a part's worktree so the branch carries the work. */
  async function commitPart(part: SplitPart): Promise<boolean> {
    const dir = part.worktree!;
    if (await git(["status", "--porcelain"], dir)) {
      await git(["add", "-A"], dir);
      const identity = await git(["config", "user.email"], dir).catch(() => "");
      const ident = identity
        ? []
        : ["-c", "user.name=AgentMate", "-c", "user.email=agentmate@localhost"];
      await git(
        [...ident, "commit", "-m", `agentmate split ${id}: part ${part.id} (${part.title})`],
        dir,
      );
      return true;
    }
    // The implementer may have committed on its own.
    return (await git(["rev-parse", "HEAD"], dir)) !== part.base;
  }

  try {
    // Every child shares one session; create it when the caller did not bring one.
    if (!session) {
      const created = createSession({
        title: goal.replace(/\s+/g, " ").slice(0, TITLE_CHARS),
        cwd: job.cwd,
      });
      session = created.id;
      attachJob(session, id);
      updateJob(id, { session });
    }

    // Step 1: the planner divides the goal.
    emit("important", "message", `step 1: plan (${planner})`);
    const planChild = begin("plan", {
      provider: planner,
      role: "plan",
      fields: { goal, ...(acceptance ? { acceptance } : {}), maxParts },
      mode: "read-only",
      cwd: job.cwd,
      model: job.model,
    });
    const [planDone] = await settle("plan", [planChild]);
    if (planDone!.status !== "done") {
      checkLive();
      failedJobs.push(planChild.id);
      throw new Stop("error", `plan ${failure(planDone!)}`);
    }
    const plan = parseSplitPlan(readResult(planChild.id).text ?? "", { maxParts, planner });
    if (!plan.ok) {
      failedJobs.push(planChild.id);
      emit("important", "error", `plan rejected: ${plan.reason}`);
      throw new Stop(
        "error",
        `the planner did not return a valid parts block; run \`jobs result ${planChild.id}\``,
      );
    }
    for (const part of plan.parts) {
      planned.set(part.id, part);
      parts.push({
        id: part.id,
        title: part.title,
        agent: part.agent,
        planJob: planChild.id,
        verdict: "none",
      });
    }
    saveParts();
    emit(
      "important",
      "message",
      `plan: ${parts.length} part(s): ${parts.map((part) => `${part.id} (${part.agent})`).join(", ")}`,
    );
    note(
      [
        `Split plan for: ${goal.replace(/\s+/g, " ").slice(0, 200)}`,
        ...plan.parts.map(
          (part) =>
            `- ${part.id} (${part.agent}): ${part.title}${part.files.length > 0 ? ` [${part.files.join(", ")}]` : ""}`,
        ),
      ].join("\n"),
    );

    // Step 2: the parts, in parallel.
    emit(
      "important",
      "message",
      `step 2: ${write ? "implement" : "research"} ${parts.length} part(s)`,
    );
    if (write) {
      checkLive();
      let base: string;
      try {
        base = await git(["rev-parse", "HEAD"], job.cwd);
      } catch (cause) {
        throw new Stop(
          "error",
          `cannot split in write mode: ${(cause as Error).message}. Run it from a git repository with at least one commit, or use read-only mode.`,
        );
      }
      for (const part of parts) {
        const dir = path.join(homeDir(), "worktrees", id, part.id);
        const branch = `agentmate/${id}/${part.id}`;
        try {
          fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
          await git(["worktree", "add", "-b", branch, dir, "HEAD"], job.cwd);
        } catch (cause) {
          throw new Stop(
            "error",
            `git worktree add failed for part ${part.id}: ${(cause as Error).message}. Check \`git worktree list\` in ${job.cwd}.`,
          );
        }
        Object.assign(part, { branch, worktree: dir, base });
        saveParts();
        emit("important", "message", `part ${part.id}: worktree ${dir} on ${branch}`);
      }
    }

    const partChildren = parts.map((part) => {
      const spec = planned.get(part.id)!;
      const brief = workflowBriefing(spec);
      const sameProvider = part.agent === planner;
      const child = write
        ? begin(`part ${part.id}: implement`, {
            provider: part.agent,
            role: "implement",
            fields: {
              task: `${brief}\n\nYou work in your own git worktree (${part.worktree}) on branch ${part.branch}, created from commit ${part.base}. Leave your changes uncommitted: AgentMate commits them on the branch after you finish.`,
            },
            mode: "write",
            cwd: part.worktree!,
            model: sameProvider ? job.model : undefined,
          })
        : begin(`part ${part.id}: research`, {
            provider: part.agent,
            role: "research",
            fields: { topic: brief },
            mode: "read-only",
            cwd: job.cwd,
            model: sameProvider ? job.model : undefined,
          });
      part.partJob = child.id;
      return child;
    });
    saveParts();

    const settledParts = await settle("parts", partChildren);
    for (const [index, part] of parts.entries()) {
      const child = settledParts[index]!;
      if (child.status !== "done") {
        part.error = failure(child);
        failures.push(`part ${part.id} failed: ${part.error}`);
        failedJobs.push(child.id);
        needsHuman.push(`part ${part.id} (${part.agent}) failed: ${part.error}`);
        continue;
      }
      results.set(part.id, readResult(child.id).text ?? "");
      if (write) {
        try {
          const hasChanges = await commitPart(part);
          changed.set(part.id, hasChanges);
          if (!hasChanges) needsHuman.push(`part ${part.id} made no changes on ${part.branch}.`);
        } catch (cause) {
          changed.set(part.id, true);
          needsHuman.push(
            `part ${part.id}: AgentMate could not commit the changes in ${part.worktree} (${(cause as Error).message}); commit them there before merging.`,
          );
        }
      }
    }
    saveParts();

    // Step 3: the other agent reviews each finished part, in parallel.
    const reviewable = parts.filter((part) => results.has(part.id));
    emit("important", "message", `step 3: review ${reviewable.length} finished part(s)`);
    if (reviewable.length > 0) {
      const reviewChildren = reviewable.map((part) => {
        const spec = planned.get(part.id)!;
        const files = spec.files.length > 0 ? ` (files: ${spec.files.join(", ")})` : "";
        const child = begin(`part ${part.id}: review`, {
          provider: otherAgent(part.agent),
          role: "review",
          fields: {
            target: write
              ? `the changes of part "${part.id}" (${part.title}) in this git worktree, branch ${part.branch}, against its base commit ${part.base}: run \`git diff ${part.base}\` (it covers committed and uncommitted changes) and \`git status\` for untracked files`
              : `the research findings of part "${part.id}" (${part.title}), given below as context; check them against the repository`,
            focus: `Whether the part does what its briefing asks and stays within its own files${files}. Briefing: ${spec.briefing}`,
            context: (results.get(part.id) ?? "").slice(0, CONTEXT_CHARS),
          },
          mode: "read-only",
          cwd: part.worktree ?? job.cwd,
        });
        part.reviewJob = child.id;
        return child;
      });
      saveParts();

      const settledReviews = await settle("reviews", reviewChildren);
      for (const [index, part] of reviewable.entries()) {
        const review = settledReviews[index]!;
        if (review.status !== "done") {
          part.error = `review ${failure(review)}`;
          failures.push(`part ${part.id} review failed: ${failure(review)}`);
          failedJobs.push(review.id);
          needsHuman.push(`part ${part.id}: its review failed (${failure(review)}).`);
          continue;
        }
        const text = readResult(review.id).text ?? "";
        reviews.set(part.id, text);
        part.verdict = parseVerdict(text);
        emit("important", "message", `part ${part.id}: review verdict ${part.verdict}`);
        const reviewer = otherAgent(part.agent);
        if (part.verdict === "request-changes")
          needsHuman.push(
            `part ${part.id}: ${reviewer} requested changes; read review job \`${review.id}\` before accepting it.`,
          );
        else if (part.verdict === "none")
          needsHuman.push(
            `part ${part.id}: ${reviewer} gave no clear verdict (no \`Verdict:\` line); read review job \`${review.id}\`.`,
          );
      }
      saveParts();
    }

    // Step 4: outcome and report.
    const approved = parts.filter((part) => part.verdict === "approve").length;
    if (failures.length > 0) {
      status = "error";
      error = `${failures.join("; ")}. Run \`agentmate jobs result ${failedJobs[0]}\`.`;
      outcome = `**Outcome:** stopped with failures: ${error}`;
    } else {
      status = "done";
      outcome = `**Outcome:** ${parts.length} part(s) finished, ${approved} approved by the reviewing agent${needsHuman.length > 0 ? `, ${needsHuman.length} item(s) need a human` : ""}.`;
    }
  } catch (cause) {
    if (cause instanceof Stop) {
      status = cause.status;
      error = cause.status === "canceled" ? undefined : cause.message;
      outcome = `**Outcome:** ${cause.status === "canceled" ? "canceled" : `stopped (${cause.status})`}: ${cause.message}`;
    } else {
      status = "error";
      error = cause instanceof Error ? cause.message : String(cause);
      outcome = `**Outcome:** stopped: ${error}`;
    }
    if (failedJobs.length > 0 && error && !error.includes("jobs result"))
      error = `${error}. Run \`agentmate jobs result ${failedJobs[0]}\`.`;
    emit("important", "error", `${status}: ${error ?? "Canceled."}`);
    // A step that stops the workflow must not leave started children running unattended.
    await Promise.all(children.map((child) => cancelJob(child.id).catch(() => undefined)));
  } finally {
    try {
      writeResult(
        id,
        renderReport({
          job,
          goal,
          acceptance,
          parts,
          children,
          outcome,
          write,
          results,
          changed,
          needsHuman,
        }),
      );
    } catch {
      // a report that cannot be written must not hide the terminal status
    }
    note(
      `Split ${id} ${status}: ${parts.map((part) => `${part.id} ${part.verdict}`).join(", ") || "no parts"}. Report: jobs result ${id}.`,
    );
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
