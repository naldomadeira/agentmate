#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelJob,
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
import { renderList, renderObservation, renderResult } from "./jobs/render.js";
import { JOB_ROLES, type JobMode, type Provider } from "./jobs/store.js";
import { logger } from "./lib/logger.js";
import { VERSION } from "./lib/version.js";

const server = new McpServer({ name: "agents-bridge-mcp", version: VERSION });

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

const jobId = z.string().describe("Job id returned by any bridge_* tool that starts a job");

/**
 * Starts a job; with waitSeconds > 0 also waits that long and returns the result, or a pointer to
 * bridge_wait when the job is still running (the job is never stopped by an expired wait).
 */
async function startAndMaybeWait(options: StartOptions, waitSeconds: number): Promise<string> {
  const job = startJob(options);
  if (waitSeconds <= 0)
    return `Started job ${job.id} (${job.provider}/${job.mode}${job.role === "custom" ? "" : `, ${job.role}`}). Call bridge_wait with this id to collect the result.`;
  const settled = await waitJob(job.id, waitSeconds * 1000);
  if (!isTerminal(settled))
    return `Job ${job.id} is still running after ${waitSeconds}s; call bridge_wait with id ${job.id} to keep waiting.`;
  return renderResult(settled, readResult(job.id).text);
}

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
};

interface Common {
  cwd?: string | undefined;
  model?: string | undefined;
  timeoutMinutes?: number | undefined;
  waitSeconds?: number | undefined;
}

/** Shared body of the role tools: map the tool arguments to a job and honor `waitSeconds`. */
function runRole(
  role: NonNullable<StartOptions["role"]>,
  args: Common & { provider: Provider; mode?: JobMode | undefined },
  fields: RoleFields,
  defaultWaitSeconds = 0,
): Promise<string> {
  const { provider, mode, cwd, model, timeoutMinutes, waitSeconds } = args;
  return startAndMaybeWait(
    { provider, role, fields, mode, cwd, model, timeoutMinutes },
    waitSeconds ?? defaultWaitSeconds,
  );
}

server.registerTool(
  "bridge_start",
  {
    title: "Start a delegated job",
    description:
      "Delegate a free-form task to another agent CLI (codex or claude) as a background job; prefer the role tools (bridge_ask, bridge_review, ...) when one fits. The job keeps running even if this session ends. The worker has no context beyond the briefing you give it.",
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
  guard(({ continue: continueJob, prompt, role, provider, mode, ...rest }) =>
    startAndMaybeWait(
      { provider, prompt, role, mode, continueJob, ...rest },
      rest.waitSeconds ?? 0,
    ),
  ),
);

server.registerTool(
  "bridge_ask",
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
  "bridge_review",
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
  "bridge_research",
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
  "bridge_plan",
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
  "bridge_implement",
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
  "bridge_teamlead",
  {
    title: "Start a team lead",
    description:
      "Put codex or claude in charge of a broad objective: it decomposes the work, delegates subtasks to the other agent, reviews the results and reports back; use it for multi-part work, and follow it with bridge_observe. A codex team lead runs with danger-full-access. The worker has no context beyond the objective, constraints and context you pass.",
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
  "bridge_wait",
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

server.registerTool(
  "bridge_observe",
  {
    title: "Observe a running job",
    description:
      "Non-blocking snapshot of a job's status, recent output and, for a team lead, the jobs it started with their status. Use only when progress was asked for.",
    inputSchema: { id: jobId },
  },
  guard(({ id }) => renderObservation(observeJob(id))),
);

server.registerTool(
  "bridge_result",
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
  "bridge_cancel",
  {
    title: "Cancel a job",
    description: "Stop a running job. Output produced so far is kept.",
    inputSchema: { id: jobId },
  },
  guard(async ({ id }) => summarize(await cancelJob(id))),
);

server.registerTool(
  "bridge_list",
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
  logger.info("agents-bridge-mcp jobs server started on stdio");
}

main().catch((err) => {
  logger.error("Failed to start agents-bridge-mcp jobs server:", err);
  process.exit(1);
});
