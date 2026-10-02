#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelJob,
  listJobs,
  observeJob,
  readResult,
  startJob,
  summarize,
  waitJob,
} from "./jobs/api.js";
import { renderList, renderObservation, renderResult } from "./jobs/render.js";
import { logger } from "./lib/logger.js";

const server = new McpServer({ name: "agents-bridge-mcp", version: "0.1.0" });

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

const jobId = z.string().describe("Job id returned by bridge_start");

server.registerTool(
  "bridge_start",
  {
    title: "Start a delegated job",
    description:
      "Delegate a task to another agent CLI (codex or claude) as a background job and return immediately with a job id. The job keeps running even if this session ends. Collect it with bridge_wait / bridge_result. Default mode is read-only; use write only when the task must edit files.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]).describe("Which agent CLI runs the task"),
      prompt: z.string().describe("The full task briefing; the worker has no other context"),
      cwd: z.string().optional().describe("Working directory (defaults to the server cwd)"),
      model: z.string().optional().describe("Model override passed to the CLI"),
      mode: z.enum(["read-only", "write"]).optional().describe("read-only (default) or write"),
      timeoutMinutes: z
        .number()
        .positive()
        .max(120)
        .optional()
        .describe("Job deadline, default 60, max 120"),
      continue: z.string().optional().describe("Id of a finished job whose session to resume"),
    },
  },
  guard(({ provider, prompt, cwd, model, mode, timeoutMinutes, continue: continueJob }) => {
    const job = startJob({ provider, prompt, cwd, model, mode, timeoutMinutes, continueJob });
    return `Started job ${job.id} (${job.provider}/${job.mode}). Call bridge_wait with this id to collect the result.`;
  }),
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
      "Non-blocking snapshot of a job's status and recent output. Use only when progress was asked for.",
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
    description: "List recent jobs, newest first.",
    inputSchema: {
      cwd: z.string().optional().describe("Only jobs started in this directory"),
      limit: z.number().int().positive().max(100).optional(),
    },
  },
  guard(({ cwd, limit }) => renderList(listJobs({ cwd, limit }))),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  logger.info("agents-bridge-mcp jobs server started on stdio");
}

main().catch((err) => {
  logger.error("Failed to start agents-bridge-mcp jobs server:", err);
  process.exit(1);
});
