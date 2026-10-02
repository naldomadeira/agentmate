import { defineCommand } from "citty";
import {
  cancelJob,
  listJobs,
  observeJob,
  readResult,
  startJob,
  summarize,
  waitJob,
} from "../jobs/api.js";
import { renderList, renderObservation, renderResult } from "../jobs/render.js";
import { TERMINAL, type JobMode, type Provider } from "../jobs/store.js";

/** Exit codes: 0 done, 1 failed or canceled, 2 wait expired with the job still running. */
const STILL_RUNNING = 2;

const idArg = { id: { type: "positional", required: true, description: "Job id" } } as const;

function exitFor(status: string): number {
  if (status === "done") return 0;
  return TERMINAL.includes(status as never) ? 1 : STILL_RUNNING;
}

export default defineCommand({
  meta: { name: "jobs", description: "Run and manage background delegation jobs" },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: "Start a job and print its id" },
      args: {
        provider: { type: "positional", required: true, description: "codex or claude" },
        prompt: { type: "positional", required: true, description: "Task briefing" },
        cwd: { type: "string", description: "Working directory" },
        model: { type: "string", description: "Model override" },
        mode: { type: "string", description: "read-only (default) or write" },
        timeout: { type: "string", description: "Job deadline in minutes (max 120)" },
        continue: { type: "string", description: "Finished job id whose session to resume" },
      },
      run({ args }) {
        if (args.provider !== "codex" && args.provider !== "claude")
          throw new Error("provider must be codex or claude");
        if (args.mode && args.mode !== "read-only" && args.mode !== "write")
          throw new Error("mode must be read-only or write");
        const job = startJob({
          provider: args.provider as Provider,
          prompt: args.prompt,
          cwd: args.cwd,
          model: args.model,
          mode: args.mode as JobMode | undefined,
          timeoutMinutes: args.timeout ? Number(args.timeout) : undefined,
          continueJob: args.continue,
        });
        console.log(job.id);
      },
    }),
    wait: defineCommand({
      meta: { name: "wait", description: "Wait for a job; exit 2 if it is still running" },
      args: {
        ...idArg,
        timeout: { type: "string", description: "Max wait, e.g. 10m or 90s (default 10m)" },
      },
      async run({ args }) {
        const match = /^(\d+)(s|m)?$/.exec(args.timeout ?? "10m");
        if (!match) throw new Error("timeout must look like 90s or 10m");
        const ms = Number(match[1]) * (match[2] === "s" ? 1_000 : 60_000);
        const job = await waitJob(args.id, ms);
        console.log(renderResult(job, readResult(args.id).text));
        process.exitCode = exitFor(job.status);
      },
    }),
    observe: defineCommand({
      meta: { name: "observe", description: "Snapshot of a job's status and recent output" },
      args: idArg,
      run({ args }) {
        console.log(renderObservation(observeJob(args.id)));
      },
    }),
    result: defineCommand({
      meta: { name: "result", description: "Print a job's stored result" },
      args: idArg,
      run({ args }) {
        const { job, text } = readResult(args.id);
        console.log(renderResult(job, text));
        process.exitCode = exitFor(job.status);
      },
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Cancel a running job" },
      args: idArg,
      async run({ args }) {
        console.log(summarize(await cancelJob(args.id)));
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List recent jobs" },
      args: { cwd: { type: "string", description: "Only jobs from this directory" } },
      run({ args }) {
        console.log(renderList(listJobs({ cwd: args.cwd })));
      },
    }),
  },
});
