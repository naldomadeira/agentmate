#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { EventLevel } from "./agents/types.js";
import {
  cancelJob,
  getJob,
  isTerminal,
  listJobs,
  observeJob,
  readResult,
  startJob,
  summarize,
  waitJob,
  type RoleFields,
  type StartOptions,
} from "./jobs/api.js";
import { readEvents } from "./jobs/events.js";
import {
  renderEvents,
  renderList,
  renderObservation,
  renderResult,
  renderSession,
  renderSessionList,
} from "./jobs/render.js";
import {
  appendNotes,
  createSession,
  getSession,
  listSessions,
  readNotes,
  sessionJobs,
} from "./jobs/sessions.js";
import { JOB_ROLES, type JobMode, type Provider } from "./jobs/store.js";
import { logger } from "./lib/logger.js";
import { VERSION } from "./lib/version.js";

const server = new McpServer({ name: "agentmate", version: VERSION });

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

/** Turns a thrown error into a tool error instead of failing the whole request. */
const guard =
  <A>(fn: (args: A) => Promise<string> | string) =>
  async (args: A) => {
    try {
      return text(await fn(args));
    } catch (error) {
      return text(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

const jobId = z.string().describe("Job id returned by any mate_* tool that starts a job");

/**
 * Starts a job; with waitSeconds > 0 also waits that long and returns the result, or a pointer to
 * mate_wait when the job is still running (the job is never stopped by an expired wait).
 */
async function startAndMaybeWait(options: StartOptions, waitSeconds: number): Promise<string> {
  const job = startJob(options);
  if (waitSeconds <= 0)
    return `Started job ${job.id} (${job.provider}/${job.mode}${job.role === "custom" ? "" : `, ${job.role}`}). Call mate_wait with this id to collect the result.`;
  const settled = await waitJob(job.id, waitSeconds * 1000);
  if (!isTerminal(settled))
    return `Job ${job.id} is still running after ${waitSeconds}s; call mate_wait with id ${job.id} to keep waiting.`;
  return renderResult(settled, readResult(job.id).text);
}

const sessionArg = z
  .string()
  .optional()
  .describe(
    "Id of a session (mate_session_start): its short shared notes prefix the worker's briefing and the job is recorded in it",
  );

const provider = z.enum(["codex", "claude"]).describe("Which agent CLI runs the task");
const context = z.string().optional().describe("Background the worker needs; it sees nothing else");

/** Optional arguments shared by every job-starting tool. */
const common = {
  cwd: z.string().optional().describe("Working directory (defaults to the server cwd)"),
  model: z.string().optional().describe("Model override passed to the CLI"),
  timeoutMinutes: z
    .number()
    .positive()
    .max(120)
    .optional()
    .describe("Job deadline, default 60, max 120"),
  waitSeconds: z
    .number()
    .min(0)
    .max(300)
    .optional()
    .describe("Wait up to this long for the result (0 = return only the job id)"),
  session: sessionArg,
};

interface Common {
  cwd?: string | undefined;
  model?: string | undefined;
  timeoutMinutes?: number | undefined;
  waitSeconds?: number | undefined;
  session?: string | undefined;
}

/** Shared body of the role tools: map the tool arguments to a job and honor `waitSeconds`. */
function runRole(
  role: NonNullable<StartOptions["role"]>,
  args: Common & {
    provider: Provider;
    mode?: JobMode | undefined;
    maxRounds?: number | undefined;
    maxParts?: number | undefined;
  },
  fields: RoleFields,
  defaultWaitSeconds = 0,
): Promise<string> {
  const { provider, mode, maxRounds, maxParts, cwd, model, timeoutMinutes, waitSeconds, session } =
    args;
  return startAndMaybeWait(
    {
      provider,
      role,
      fields,
      mode,
      maxRounds,
      maxParts,
      cwd,
      model,
      timeoutMinutes,
      sessionId: session,
    },
    waitSeconds ?? defaultWaitSeconds,
  );
}

server.registerTool(
  "mate_start",
  {
    title: "Start a delegated job",
    description:
      "Delegate a free-form task to another agent CLI (codex or claude) as a background job; prefer the role tools (mate_ask, mate_review, ...) when one fits. The job keeps running even if this session ends. The worker has no context beyond the briefing you give it.",
    inputSchema: {
      provider,
      prompt: z.string().describe("The full task briefing; the worker has no other context"),
      role: z
        .enum(JOB_ROLES)
        .optional()
        .describe(
          "custom (default) sends the prompt as is; other roles wrap it in that role's brief",
        ),
      mode: z.enum(["read-only", "write"]).optional().describe("read-only (default) or write"),
      continue: z.string().optional().describe("Id of a finished job whose session to resume"),
      ...common,
    },
  },
  guard(({ continue: continueJob, prompt, role, provider, mode, session, ...rest }) =>
    startAndMaybeWait(
      { provider, prompt, role, mode, continueJob, sessionId: session, ...rest },
      rest.waitSeconds ?? 0,
    ),
  ),
);

server.registerTool(
  "mate_ask",
  {
    title: "Ask the other agent",
    description:
      "Ask codex or claude a direct question and get the answer in this call; use it for a second opinion or a quick fact check. The worker has no context beyond the question and context you pass.",
    inputSchema: {
      provider,
      question: z.string().describe("A self-contained question"),
      context,
      ...common,
    },
  },
  guard(({ question, context, ...args }) => runRole("ask", args, { question, context }, 120)),
);

server.registerTool(
  "mate_review",
  {
    title: "Request a code review",
    description:
      "Have codex or claude review a diff, files or a description, read-only, with findings ordered by severity and a verdict; use it before merging or after a large change. The worker has no context beyond the target, focus and context you pass.",
    inputSchema: {
      provider,
      target: z
        .string()
        .describe("Diff range (e.g. main..HEAD), files or a description of the change"),
      focus: z.string().optional().describe("What to scrutinize most"),
      context,
      ...common,
    },
  },
  guard(({ target, focus, context, ...args }) =>
    runRole("review", args, { target, focus, context }),
  ),
);

server.registerTool(
  "mate_research",
  {
    title: "Research a topic",
    description:
      "Have codex or claude investigate a topic read-only and report findings, compared options and a recommendation; use it when you need evidence before deciding. The worker has no context beyond the briefing you pass.",
    inputSchema: {
      provider,
      topic: z.string().describe("What to investigate"),
      questions: z.array(z.string()).optional().describe("Specific questions to answer"),
      scope: z.string().optional().describe("Boundaries, e.g. directories or sources to use"),
      context,
      ...common,
    },
  },
  guard(({ topic, questions, scope, context, ...args }) =>
    runRole("research", args, { topic, questions, scope, context }),
  ),
);

server.registerTool(
  "mate_plan",
  {
    title: "Plan or critique a plan",
    description:
      "Have codex or claude write a step-by-step plan for a goal, or critique an existing plan when existingPlan is given, read-only; use it before non-trivial work. The worker has no context beyond the briefing you pass.",
    inputSchema: {
      provider,
      goal: z.string().describe("What the plan must achieve"),
      constraints: z.string().optional().describe("Limits the plan must respect"),
      existingPlan: z.string().optional().describe("A plan to critique instead of creating one"),
      context,
      ...common,
    },
  },
  guard(({ goal, constraints, existingPlan, context, ...args }) =>
    runRole("plan", args, { goal, constraints, existingPlan, context }),
  ),
);

server.registerTool(
  "mate_implement",
  {
    title: "Delegate an implementation",
    description:
      "Have codex or claude implement a scoped task by editing files in the working directory (write mode); use it only when the user authorized edits, and run one write job at a time. The worker has no context beyond the task, acceptance criteria and context you pass.",
    inputSchema: {
      provider,
      task: z.string().describe("A complete, scoped description of the change"),
      acceptance: z.string().optional().describe("Criteria that define done"),
      context,
      ...common,
    },
  },
  guard(({ task, acceptance, context, ...args }) =>
    runRole("implement", { ...args, mode: "write" }, { task, acceptance, context }),
  ),
);

server.registerTool(
  "mate_teamlead",
  {
    title: "Start a team lead",
    description:
      "Put codex or claude in charge of a broad objective: it decomposes the work, delegates subtasks to the other agent, reviews the results and reports back; use it for multi-part work, and follow it with mate_observe. A codex team lead runs with danger-full-access. The worker has no context beyond the objective, constraints and context you pass.",
    inputSchema: {
      provider,
      objective: z.string().describe("The broad goal the team lead owns"),
      constraints: z.string().optional().describe("Limits the team must respect"),
      context,
      mode: z
        .enum(["read-only", "write"])
        .optional()
        .describe("read-only (default) forbids write delegations; write allows one at a time"),
      ...common,
    },
  },
  guard(({ objective, constraints, context, ...args }) =>
    runRole("teamlead", args, { objective, constraints, context }),
  ),
);

server.registerTool(
  "mate_crossreview",
  {
    title: "Implement and cross-review",
    description:
      "Have one agent implement a scoped change and the other agent review it, looping on the reviewer's findings, without relaying anything by hand; use it for one well-scoped change you want implemented by one agent and reviewed by the other. WARNING: it edits files, because the provider you name runs in write mode in the working directory (the other agent only reads and reviews the uncommitted diff); use it only when the user authorized edits, and run one write job per working tree. It stops when the reviewer approves, gives no clear verdict (then a human decides) or maxRounds is used up; the report lists the rounds, the final review and the changes. Only a top-level session can start it; follow it with mate_observe. The workers have no context beyond the task and acceptance criteria you pass.",
    inputSchema: {
      provider: z
        .enum(["codex", "claude"])
        .describe("The agent that implements; the other one reviews"),
      task: z.string().describe("A complete, scoped description of the change"),
      acceptance: z.string().optional().describe("Criteria that define done"),
      maxRounds: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Most implement-and-review rounds, default 2"),
      cwd: common.cwd,
      model: z.string().optional().describe("Model override for the implementer only"),
      timeoutMinutes: z
        .number()
        .positive()
        .max(120)
        .optional()
        .describe("Deadline for the whole workflow, default 60, max 120"),
      waitSeconds: common.waitSeconds,
      session: sessionArg,
    },
  },
  guard(({ task, acceptance, maxRounds, ...args }) =>
    runRole("crossreview", { ...args, mode: "write", maxRounds }, { task, acceptance }),
  ),
);

server.registerTool(
  "mate_split",
  {
    title: "Split a task across both agents",
    description:
      "Split a broad goal into independent parts that run in parallel and are cross-reviewed, without relaying anything by hand: the provider plans 1 to maxParts parts with closed interfaces and no overlapping files, each part goes to one of the two agents, and the other agent reviews each finished part. In read-only mode (default) the parts are research jobs on the working directory; in write mode each part is implemented in its own git worktree and branch (agentmate/<split-id>/<part>) created from HEAD, which needs a git repository with a commit and edits files, so use write only when the user authorized edits. The report lists the parts with their verdicts, the ordered `git merge` commands (nothing is merged for you; conflicts are not resolved) and what needs a human. Creates a session when none is given and records the plan in its notes. Only a top-level session can start it; follow it with mate_observe. The workers have no context beyond the goal and acceptance criteria you pass.",
    inputSchema: {
      provider: z
        .enum(["codex", "claude"])
        .describe("The agent that plans; the parts use both agents"),
      goal: z.string().describe("The broad goal to split, with the files and constraints involved"),
      acceptance: z.string().optional().describe("Criteria that define done for the whole goal"),
      maxParts: z
        .number()
        .int()
        .min(2)
        .max(4)
        .optional()
        .describe("Most parts the plan may have, 2 to 4, default 3"),
      mode: z
        .enum(["read-only", "write"])
        .optional()
        .describe("read-only (default) researches the parts; write implements each in a worktree"),
      cwd: common.cwd,
      session: sessionArg,
      model: z.string().optional().describe("Model override for the planner and same-agent parts"),
      timeoutMinutes: z
        .number()
        .positive()
        .max(120)
        .optional()
        .describe("Deadline for the whole workflow, default 60, max 120"),
      waitSeconds: common.waitSeconds,
    },
  },
  guard(({ goal, acceptance, ...args }) => runRole("split", args, { goal, acceptance })),
);

const sessionId = z.string().describe("Session id returned by mate_session_start");
const SESSION_HINT =
  "A session is shared context across jobs and agents. Pass its id as `session` to any mate_* job tool; every worker in the session reads the notes in its briefing, so keep notes short and factual.";

server.registerTool(
  "mate_session_start",
  {
    title: "Start a session",
    description: `Create a session: shared context across jobs and agents. Its notes (mate_session_notes) are read by every worker started with that session, so keep them short and factual. ${SESSION_HINT}`,
    inputSchema: {
      title: z.string().min(1).describe("A short name for the work, e.g. the feature or bug"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory the session is about (defaults to the server cwd)"),
    },
  },
  guard(({ title, cwd }) => {
    const session = createSession({ title, cwd: cwd ?? process.cwd() });
    return `Started session ${session.id} (${session.title}). Pass session=${session.id} to the mate_* job tools and add notes with mate_session_notes. Notes are read by every worker in the session, so keep them short and factual.`;
  }),
);

server.registerTool(
  "mate_session_show",
  {
    title: "Show a session",
    description:
      "Show a session: its title, the tail of its shared notes (what workers read) and the jobs started in it.",
    inputSchema: { id: sessionId },
  },
  guard(({ id }) => renderSession(getSession(id), readNotes(id), sessionJobs(id))),
);

server.registerTool(
  "mate_session_notes",
  {
    title: "Add session notes",
    description:
      "Append a note to a session. Notes are read by every worker started in the session (the last 4000 characters), so keep them short and factual: decisions, constraints, file locations, findings that later jobs need.",
    inputSchema: {
      id: sessionId,
      text: z.string().min(1).describe("The note; short and factual"),
      author: z.string().optional().describe('Who writes it, default "host"'),
    },
  },
  guard(({ id, text, author }) => {
    appendNotes(id, text, author ?? "host");
    return `Added a note to session ${id}.`;
  }),
);

server.registerTool(
  "mate_session_list",
  {
    title: "List sessions",
    description:
      "List recent sessions, newest first; pass cwd to list only those about one directory.",
    inputSchema: {
      cwd: z.string().optional().describe("Only sessions about this directory"),
      limit: z.number().int().positive().max(100).optional(),
    },
  },
  guard(({ cwd, limit }) => renderSessionList(listSessions({ cwd, limit }))),
);

server.registerTool(
  "mate_wait",
  {
    title: "Wait for a job",
    description:
      "Block until the job finishes or the wait expires. Expiring does not stop the job; call again to keep waiting. Returns the result when done.",
    inputSchema: {
      id: jobId,
      timeoutSeconds: z.number().positive().max(300).optional().describe("Max wait, default 45"),
    },
  },
  guard(async ({ id, timeoutSeconds }) => {
    const job = await waitJob(id, (timeoutSeconds ?? 45) * 1000);
    return renderResult(job, readResult(id).text);
  }),
);

const eventLevels = z
  .array(z.enum(["important", "status", "fyi"]))
  .optional()
  .describe(
    "Event levels to include: important (messages, errors, finish), status (files changed), fyi (commands run)",
  );

server.registerTool(
  "mate_observe",
  {
    title: "Observe a running job",
    description:
      "Non-blocking snapshot of a job's status, its recent important and status events (not raw output) and, for a team lead, the jobs it started with their status. Pass raw to also get the stdout/stderr tails, or levels to widen the events. Use only when progress was asked for.",
    inputSchema: {
      id: jobId,
      raw: z.boolean().optional().describe("Also include the raw stdout/stderr tails"),
      levels: eventLevels,
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Newest N events, default 30"),
    },
  },
  guard(({ id, raw, levels, limit }) =>
    renderObservation(observeJob(id, { raw, levels: levels as EventLevel[] | undefined, limit })),
  ),
);

server.registerTool(
  "mate_events",
  {
    title: "Read a job's events",
    description:
      "Read a job's event log, oldest first, one line per event; filter by level, or pass since (an ISO timestamp) to read only what is new. Cheaper than raw output.",
    inputSchema: {
      id: jobId,
      since: z.string().optional().describe("Only events after this ISO timestamp"),
      levels: eventLevels,
      limit: z.number().int().positive().max(500).optional().describe("Newest N events"),
    },
  },
  guard(({ id, since, levels, limit }) => {
    getJob(id);
    return renderEvents(
      readEvents(id, { since, levels: levels as EventLevel[] | undefined, limit }),
    );
  }),
);

server.registerTool(
  "mate_result",
  {
    title: "Read a job result",
    description: "Return the stored result of a job without waiting.",
    inputSchema: { id: jobId },
  },
  guard(({ id }) => {
    const { job, text: body } = readResult(id);
    return renderResult(job, body);
  }),
);

server.registerTool(
  "mate_cancel",
  {
    title: "Cancel a job",
    description: "Stop a running job. Output produced so far is kept.",
    inputSchema: { id: jobId },
  },
  guard(async ({ id }) => summarize(await cancelJob(id))),
);

server.registerTool(
  "mate_list",
  {
    title: "List jobs",
    description:
      "List recent jobs, newest first, with children indented under their team lead; pass parent to list only the jobs one team lead started.",
    inputSchema: {
      cwd: z.string().optional().describe("Only jobs started in this directory"),
      limit: z.number().int().positive().max(100).optional(),
      parent: z.string().optional().describe("Only jobs started by this job's worker"),
    },
  },
  guard(({ cwd, limit, parent }) => renderList(listJobs({ cwd, limit, parent }))),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  logger.info("agentmate jobs server started on stdio");
}

main().catch((err) => {
  logger.error("Failed to start agentmate jobs server:", err);
  process.exit(1);
});
