import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { EventLevel, JobEvent } from "../agents/types.js";
import { availableAgents, isAgentId, otherAgent } from "../agents/registry.js";
import { cancelJob, getJob, isTerminal, readResult, startJob, type StartOptions } from "./api.js";
import { parseVerdict } from "./crossreview.js";
import { appendEvent } from "./events.js";
import { appendNotes, createSession } from "./sessions.js";
import {
  DEFAULT_MAX_PARTS,
  homeDir,
  isCancelRequested,
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
  options: {
    maxParts: number;
    planner: Provider;
    /** The agent that works with the planner; parts and reviews then use only these two. */
    partner?: Provider | undefined;
    /** Agents a part may be assigned to; defaults to every registered agent. */
    allowed?: readonly Provider[] | undefined;
  },
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

  const { planner, partner } = options;
  let fallback = counterpart(planner, planner, partner);
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
    const named = part["agent"];
    if (isAgentId(named) && (!options.allowed || options.allowed.includes(named))) agent = named;
    else {
      agent = fallback;
      fallback = counterpart(fallback, planner, partner);
    }
    parts.push({ id, title: title.trim(), briefing: briefing.trim(), files, agent });
  }
  return { ok: true, parts };
}

/** The agent that pairs with `agent`: the explicit partner of the planner, or the default pairing. */
function counterpart(agent: Provider, planner: Provider, partner?: Provider): Provider {
  if (!partner) return otherAgent(agent);
  return agent === planner ? partner : planner;
}

/** Ends the workflow early with a final status; thrown from a step, caught by the runner. */
class Stop extends Error {
  constructor(
    readonly status: Exclude<JobStatus, "queued" | "running" | "done">,
    message: string,
    /** Replaces the default outcome line, for example to name the step that hit a provider quota. */
    readonly outcome?: string,
  ) {
    super(message);
  }
}

interface Child {
  id: string;
  label: string;
}

/** Every git call gets this long; a hook or a prompt that hangs must not hang the workflow. */
const GIT_TIMEOUT_MS = 60_000;

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (cause) {
    const failure = cause as { stderr?: string; message: string; killed?: boolean };
    if (failure.killed)
      throw new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000} s`);
    // The cause is the `fatal:`/`error:` line; the first line is often just progress ("Preparing worktree").
    const lines = (failure.stderr ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const detail =
      lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1) ?? failure.message;
    throw new Error(detail.replace(/^(fatal|error):\s*/i, ""));
  }
}

/** How a write-mode part's branch ended up after the implementer finished. */
interface CommitResult {
  state: "committed" | "unchanged" | "failed" | "switched";
  /** `failed`: the git error. `switched`: the branch the worktree is on. */
  detail?: string;
}

/** Double-quoted for a shell, so a path with spaces or `$` survives being pasted. */
const quote = (value: string) => `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
const oneLine = (value: string, max = 120) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

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
  commits: Map<string, CommitResult>;
  needsHuman: string[];
}

/** The `## Integration` section of a write-mode split: every created worktree and branch is accounted for. */
function renderWriteIntegration(input: ReportInput): string {
  const created = input.parts.filter((part) => part.worktree && part.branch);
  if (created.length === 0) return "No worktree was created, so there is nothing to integrate.";

  const merge: SplitPart[] = [];
  const discard: SplitPart[] = [];
  const lines = created.flatMap((part): string[] => {
    const commit = input.commits.get(part.id);
    const review = part.reviewJob ? `read review job \`${part.reviewJob}\`` : "read the review";
    switch (commit?.state) {
      case "failed":
        return [`# part ${part.id}: commit failed, work is uncommitted in ${part.worktree}`];
      case "switched":
        return [
          `# part ${part.id}: the worktree is on branch ${commit.detail}, not ${part.branch}; inspect ${part.worktree}`,
        ];
      case "committed":
        if (part.verdict === "approve") {
          merge.push(part);
          return [`git merge ${part.branch}`];
        }
        discard.push(part);
        return [
          part.verdict === "request-changes"
            ? `# git merge ${part.branch}  # request-changes: ${review} before merging`
            : `# git merge ${part.branch}  # no clear verdict: ${review} before merging`,
        ];
      case "unchanged":
        discard.push(part);
        return [`# git merge ${part.branch}  # no changes on this branch`];
      default:
        discard.push(part);
        return [
          `# part ${part.id}: nothing to merge (${oneLine(part.error ?? "it did not finish")})`,
        ];
    }
  });

  const sections = [
    `Each part is committed on its own branch, created from \`${created[0]?.base?.slice(0, 12) ?? "HEAD"}\`. From \`${input.job.cwd}\`, merge the approved parts in this order:`,
    `\`\`\`bash\n${lines.join("\n")}\n\`\`\``,
    "Merge conflicts are not resolved automatically: if two parts collide, resolve them by hand or ask an agent. Nothing has been merged, pushed or deleted for you.",
  ];
  if (merge.length > 0)
    sections.push(
      "After merging, remove the merged worktrees and branches:",
      `\`\`\`bash\n${merge.map((part) => `git worktree remove ${quote(part.worktree!)}\ngit branch -d ${part.branch}`).join("\n")}\n\`\`\``,
    );
  if (discard.length > 0)
    sections.push(
      "These worktrees and branches are not merged (failed, canceled, timed out, unchanged or waiting for a human). Delete them when you no longer need them; the removal is forced and drops anything left in the worktree:",
      `\`\`\`bash\n${discard.map((part) => `git worktree remove --force ${quote(part.worktree!)}\ngit branch -D ${part.branch}`).join("\n")}\n\`\`\``,
    );
  return sections.join("\n\n");
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
  if (write) integration = renderWriteIntegration(input);
  else if (finished.length === 0)
    integration = "No part finished, so there is nothing to integrate.";
  else {
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
  const partner = job.partner;
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
  const commits = new Map<string, CommitResult>();
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

  /** SIGTERM reached this worker, or `cancelJob` marked the job. */
  const stopRequested = (): boolean => controller.signal.aborted || isCancelRequested(id);
  const checkLive = (): void => {
    if (stopRequested()) throw new Stop("canceled", "Canceled.");
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
          // `cancelJob` marks this job before it cancels the children: a canceled child under that mark
          // is the whole workflow being canceled; without it the child was canceled on its own.
          if (current.status === "canceled" && stopRequested())
            throw new Stop("canceled", "Canceled.");
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
      const stopWith = stopRequested()
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
  /** Children that ended `quota_exhausted`; their error already carries the reset and hand-off hint. */
  const quotaHits: { label: string; job: Job }[] = [];
  const noteQuota = (label: string, child: Job): void => {
    if (child.status === "quota_exhausted" && child.error) quotaHits.push({ label, job: child });
  };

  const workflowBriefing = (part: PlannedPart): string =>
    [
      part.briefing,
      `Files for this part: ${part.files.length > 0 ? part.files.join(", ") : "(not specified; stay within the briefing)"}`,
      `Overall goal (other parts are handled in parallel by other agents; do not do their work): ${goal}`,
      ...(acceptance ? [`Acceptance criteria for the whole goal:\n${acceptance}`] : []),
    ].join("\n\n");

  /**
   * Commits what the implementer left in a part's worktree so the branch carries the work. Hooks and
   * signing are off for this commit: it is bookkeeping, and the user's hooks would reject it. A worktree
   * the implementer moved to another branch is left alone.
   */
  async function commitPart(part: SplitPart): Promise<CommitResult> {
    const dir = part.worktree!;
    try {
      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
      if (current !== part.branch) {
        needsHuman.push(
          `part ${part.id}: the implementer switched the worktree ${dir} to branch ${current} (expected ${part.branch}), so AgentMate did not commit; inspect it there.`,
        );
        return { state: "switched", detail: current };
      }
      if (await git(["status", "--porcelain"], dir)) {
        await git(["add", "-A"], dir);
        const identity = await git(["config", "user.email"], dir).catch(() => "");
        const ident = identity
          ? []
          : ["-c", "user.name=AgentMate", "-c", "user.email=agentmate@localhost"];
        await git(
          [
            "-c",
            "commit.gpgsign=false",
            ...ident,
            "commit",
            "--no-verify",
            "-m",
            `agentmate split ${id}: part ${part.id} (${part.title})`,
          ],
          dir,
        );
        return { state: "committed" };
      }
      // The implementer may have committed on its own.
      if ((await git(["rev-parse", "HEAD"], dir)) !== part.base) return { state: "committed" };
      needsHuman.push(`part ${part.id} made no changes on ${part.branch}.`);
      return { state: "unchanged" };
    } catch (cause) {
      const detail = (cause as Error).message;
      needsHuman.push(
        `part ${part.id}: AgentMate could not commit the changes in ${dir} (${detail}); commit them there before merging.`,
      );
      return { state: "failed", detail };
    }
  }

  try {
    // Write mode needs a repository with a commit and a clean tree: each part starts from this commit
    // in its own worktree, and uncommitted changes would silently be left out of every part.
    let base = "";
    if (write) {
      try {
        base = await git(["rev-parse", "HEAD"], job.cwd);
      } catch {
        const isRepo = await git(["rev-parse", "--git-dir"], job.cwd).then(
          () => true,
          () => false,
        );
        throw new Stop(
          "error",
          `${job.cwd} ${isRepo ? "has no commits yet; task splitting in write mode needs a commit to start from" : "is not a git repository; task splitting in write mode needs one"}. Run \`agentmate jobs result ${id}\``,
        );
      }
      if (await git(["status", "--porcelain"], job.cwd).catch(() => ""))
        throw new Stop(
          "error",
          "the working tree has uncommitted changes; commit or stash them first, because each part starts from HEAD in its own worktree",
        );
    }

    // Every child shares one session; create it when the caller did not bring one.
    if (!session) {
      const created = createSession({
        title: goal.replace(/\s+/g, " ").slice(0, TITLE_CHARS),
        cwd: job.cwd,
      });
      session = created.id;
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
      partner,
    });
    const [planDone] = await settle("plan", [planChild]);
    if (planDone!.status !== "done") {
      checkLive();
      failedJobs.push(planChild.id);
      noteQuota("plan", planDone!);
      if (quotaHits.length > 0)
        throw new Stop(
          "error",
          planDone!.error!,
          `**Outcome:** stopped: plan (job ${planChild.id}) hit the ${planDone!.provider} quota. ${planDone!.error}`,
        );
      throw new Stop("error", `plan ${failure(planDone!)}`);
    }
    const plan = parseSplitPlan(readResult(planChild.id).text ?? "", {
      maxParts,
      planner,
      partner,
      allowed: partner ? [planner, partner] : [...new Set([planner, ...availableAgents()])],
    });
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
      for (const part of parts) {
        const dir = path.join(homeDir(), "worktrees", id, part.id);
        const branch = `agentmate/${id}/${part.id}`;
        try {
          fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
          await git(["worktree", "add", "-b", branch, dir, base], job.cwd);
        } catch (cause) {
          // The other parts go on; this one is reported and not run. `worktree add -b` may already have
          // created the branch, which belongs to this job alone, so it is removed instead of orphaned.
          await git(["branch", "-D", branch], job.cwd).catch(() => undefined);
          const message = (cause as Error).message;
          part.error = `git worktree add failed: ${message}`;
          failures.push(`part ${part.id} could not start: git worktree add failed`);
          needsHuman.push(
            `part ${part.id}: git worktree add failed (${message}), so the part was not run. Check \`git worktree list\` in ${job.cwd}.`,
          );
          emit("important", "error", `part ${part.id}: git worktree add failed: ${message}`);
          continue;
        }
        Object.assign(part, { branch, worktree: dir, base });
        saveParts();
        emit("important", "message", `part ${part.id}: worktree ${dir} on ${branch}`);
      }
    }

    // A part whose worktree could not be created has no child.
    const runnable = parts.filter((part) => !write || part.worktree);
    const partChildren = runnable.map((part) => {
      const spec = planned.get(part.id)!;
      const brief = workflowBriefing(spec);
      const sameProvider = part.agent === planner;
      const child = write
        ? begin(`part ${part.id}: implement`, {
            provider: part.agent,
            role: "implement",
            fields: {
              task: `${brief}\n\nYou work in your own git worktree (${part.worktree}) on branch ${part.branch}, created from commit ${part.base}. Stay on that branch and leave your changes uncommitted: AgentMate commits them on the branch after you finish.`,
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
    for (const [index, part] of runnable.entries()) {
      const child = settledParts[index]!;
      if (child.status !== "done") {
        part.error = failure(child);
        noteQuota(`part ${part.id}`, child);
        failures.push(`part ${part.id} failed: ${part.error}`);
        failedJobs.push(child.id);
        needsHuman.push(`part ${part.id} (${part.agent}) failed: ${part.error}`);
        continue;
      }
      results.set(part.id, readResult(child.id).text ?? "");
      if (write) commits.set(part.id, await commitPart(part));
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
          provider: counterpart(part.agent, planner, partner),
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
          noteQuota(`part ${part.id}: review`, review);
          failures.push(`part ${part.id} review failed: ${failure(review)}`);
          failedJobs.push(review.id);
          needsHuman.push(`part ${part.id}: its review failed (${failure(review)}).`);
          continue;
        }
        const text = readResult(review.id).text ?? "";
        reviews.set(part.id, text);
        part.verdict = parseVerdict(text);
        emit("important", "message", `part ${part.id}: review verdict ${part.verdict}`);
        const reviewer = counterpart(part.agent, planner, partner);
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
      error = `${failures.join("; ")}. Run \`agentmate jobs result ${failedJobs[0] ?? id}\`.`;
      outcome = `**Outcome:** stopped with failures: ${error}`;
      const hit = quotaHits[0];
      if (hit) {
        // A quota ends the workflow with the child's own hint so the reader can hand the work off.
        error = hit.job.error!;
        outcome = `**Outcome:** stopped with failures: ${quotaHits
          .map((q) => `${q.label} (job ${q.job.id}) hit the ${q.job.provider} quota`)
          .join("; ")}. ${error}`;
      }
    } else {
      status = "done";
      outcome = `**Outcome:** ${parts.length} part(s) finished, ${approved} approved by the reviewing agent${needsHuman.length > 0 ? `, ${needsHuman.length} item(s) need a human` : ""}.`;
    }
  } catch (cause) {
    if (cause instanceof Stop) {
      status = cause.status;
      error = cause.status === "canceled" ? undefined : cause.message;
      outcome =
        cause.outcome ??
        `**Outcome:** ${cause.status === "canceled" ? "canceled" : `stopped (${cause.status})`}: ${cause.message}`;
    } else {
      status = "error";
      error = cause instanceof Error ? cause.message : String(cause);
      outcome = `**Outcome:** stopped: ${error}`;
    }
    if (failedJobs.length > 0 && error && quotaHits.length === 0 && !error.includes("jobs result"))
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
          commits,
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
