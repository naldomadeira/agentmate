import { defineCommand } from "citty";
import {
  askJob,
  cancelJob,
  getJob,
  isTerminal,
  listJobs,
  observeJob,
  readResult,
  startJob,
  summarize,
  waitJob,
} from "../jobs/api.js";
import { isAgentId } from "../agents/registry.js";
import type { EventLevel } from "../agents/types.js";
import { readEvents } from "../jobs/events.js";
import { ackTerminalJob } from "../jobs/inbox.js";
import { userFacing } from "../lib/errors.js";
import {
  renderEvent,
  renderEvents,
  renderList,
  renderObservation,
  renderResult,
} from "../jobs/render.js";
import {
  JOB_ROLES,
  MAX_PARTS_LIMIT,
  MAX_ROUNDS_LIMIT,
  MIN_MAX_PARTS,
  TERMINAL,
  type JobMode,
  type JobRole,
  type Provider,
} from "../jobs/store.js";

/** Exit codes: 0 done, 1 failed or canceled, 2 wait expired with the job still running. */
const STILL_RUNNING = 2;

const idArg = { id: { type: "positional", required: true, description: "Job id" } } as const;

const parseProvider = (value: string, name = "provider"): Provider => {
  if (!isAgentId(value))
    throw new Error(`${name} must be codex or claude (or gemini/agy, experimental)`);
  return value;
};

/** Parses `90s` / `10m` (bare numbers are minutes) into milliseconds. */
function parseDuration(value: string): number {
  const match = /^(\d+)(s|m)?$/.exec(value);
  if (!match) throw new Error("duration must look like 90s or 10m");
  return Number(match[1]) * (match[2] === "s" ? 1_000 : 60_000);
}

const EVENT_LEVELS: readonly EventLevel[] = ["important", "status", "fyi"];

/** Parses `--level important,status`; undefined means "use the default". */
function parseLevels(value: string | undefined): EventLevel[] | undefined {
  if (value === undefined) return undefined;
  const levels = value
    .split(",")
    .map((level) => level.trim())
    .filter(Boolean);
  const bad = levels.find((level) => !EVENT_LEVELS.includes(level as EventLevel));
  if (bad || levels.length === 0)
    throw new Error(`level must be a comma list of: ${EVENT_LEVELS.join(", ")}`);
  return levels as EventLevel[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
        provider: {
          type: "positional",
          required: true,
          description: "codex, claude, gemini or agy (experimental)",
        },
        prompt: { type: "positional", required: true, description: "Task briefing" },
        cwd: { type: "string", description: "Working directory" },
        model: { type: "string", description: "Model override" },
        mode: { type: "string", description: "read-only (default) or write" },
        role: {
          type: "string",
          description: `Job role: ${JOB_ROLES.join(", ")} (default custom, the prompt is sent as is)`,
        },
        timeout: { type: "string", description: "Job deadline in minutes (max 120)" },
        continue: { type: "string", description: "Finished job id whose session to resume" },
        "max-rounds": {
          type: "string",
          description: "crossreview only: most implement-and-review rounds, 1 to 5 (default 2)",
        },
        "max-parts": {
          type: "string",
          description: "split only: most parts the plan may have, 2 to 4 (default 3)",
        },
        session: {
          type: "string",
          description: "Session id (sessions start): its notes prefix the briefing",
        },
        partner: {
          type: "string",
          description:
            "teamlead, crossreview and split only: the agent that works with the provider (default: the first installed other agent); must differ from it",
        },
      },
      run: userFacing(({ args }) => {
        const provider = parseProvider(args.provider);
        if (args.mode && args.mode !== "read-only" && args.mode !== "write")
          throw new Error("mode must be read-only or write");
        if (args.role && !JOB_ROLES.includes(args.role as JobRole))
          throw new Error(`role must be one of: ${JOB_ROLES.join(", ")}`);
        const timeoutMinutes = args.timeout === undefined ? undefined : Number(args.timeout);
        if (
          timeoutMinutes !== undefined &&
          !(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0)
        )
          throw new Error("timeout must be a positive number of minutes");
        const maxRoundsArg = args["max-rounds"];
        const maxRounds = maxRoundsArg === undefined ? undefined : Number(maxRoundsArg);
        if (
          maxRounds !== undefined &&
          !(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= MAX_ROUNDS_LIMIT)
        )
          throw new Error(`max-rounds must be a whole number from 1 to ${MAX_ROUNDS_LIMIT}`);
        if (maxRounds !== undefined && args.role !== "crossreview")
          throw new Error("max-rounds applies only with --role crossreview");
        const maxPartsArg = args["max-parts"];
        const maxParts = maxPartsArg === undefined ? undefined : Number(maxPartsArg);
        if (
          maxParts !== undefined &&
          !(Number.isInteger(maxParts) && maxParts >= MIN_MAX_PARTS && maxParts <= MAX_PARTS_LIMIT)
        )
          throw new Error(
            `max-parts must be a whole number from ${MIN_MAX_PARTS} to ${MAX_PARTS_LIMIT}`,
          );
        if (maxParts !== undefined && args.role !== "split")
          throw new Error("max-parts applies only with --role split");
        const partner =
          args.partner === undefined ? undefined : parseProvider(args.partner, "partner");
        if (partner !== undefined && partner === provider)
          throw new Error(`partner must differ from the provider (both are ${provider})`);
        const job = startJob({
          provider,
          partner,
          prompt: args.prompt,
          maxRounds,
          maxParts,
          sessionId: args.session,
          role: args.role as JobRole | undefined,
          cwd: args.cwd,
          model: args.model,
          mode: args.mode as JobMode | undefined,
          timeoutMinutes,
          continueJob: args.continue,
        });
        console.log(job.id);
      }),
    }),
    ask: defineCommand({
      meta: {
        name: "ask",
        description:
          "Ask codex, claude, gemini or agy a question and print the answer; exit 2 if still running",
      },
      args: {
        provider: {
          type: "positional",
          required: true,
          description: "codex, claude, gemini or agy (experimental)",
        },
        question: { type: "positional", required: true, description: "The question" },
        wait: { type: "string", description: "Max wait, e.g. 90s or 2m (default 120s)" },
        cwd: { type: "string", description: "Working directory" },
        model: { type: "string", description: "Model override" },
      },
      run: userFacing(async ({ args }) => {
        const { job, text } = await askJob(
          {
            provider: parseProvider(args.provider),
            role: "ask",
            fields: { question: args.question },
            cwd: args.cwd,
            model: args.model,
          },
          parseDuration(args.wait ?? "120s"),
        );
        console.log(renderResult(job, text));
        process.exitCode = exitFor(job.status);
      }),
    }),
    wait: defineCommand({
      meta: { name: "wait", description: "Wait for a job; exit 2 if it is still running" },
      args: {
        ...idArg,
        timeout: { type: "string", description: "Max wait, e.g. 10m or 90s (default 10m)" },
      },
      run: userFacing(async ({ args }) => {
        const job = await waitJob(args.id, parseDuration(args.timeout ?? "10m"));
        ackTerminalJob(job);
        console.log(renderResult(job, readResult(args.id).text));
        process.exitCode = exitFor(job.status);
      }),
    }),
    observe: defineCommand({
      meta: {
        name: "observe",
        description:
          "Snapshot of a job's status and recent events (--raw adds stdout/stderr tails)",
      },
      args: {
        ...idArg,
        raw: { type: "boolean", description: "Also print the raw stdout/stderr tails" },
        level: {
          type: "string",
          description: "Event levels to show, comma-separated (default important,status)",
        },
      },
      run: userFacing(({ args }) => {
        console.log(
          renderObservation(
            observeJob(args.id, { raw: args.raw, levels: parseLevels(args.level) }),
          ),
        );
      }),
    }),
    events: defineCommand({
      meta: {
        name: "events",
        description: "Print a job's events; --follow streams new ones until the job ends",
      },
      args: {
        ...idArg,
        since: { type: "string", description: "Only events after this ISO timestamp" },
        level: {
          type: "string",
          description: "Levels to show, comma-separated: important,status,fyi (default all)",
        },
        follow: { type: "boolean", description: "Poll every second until the job is terminal" },
      },
      run: userFacing(async ({ args }) => {
        const levels = parseLevels(args.level);
        const read = () => readEvents(args.id, { since: args.since, levels });
        if (!args.follow) {
          getJob(args.id);
          console.log(renderEvents(read()));
          return;
        }
        let printed = 0;
        const flush = () => {
          const events = read();
          for (const event of events.slice(printed)) console.log(renderEvent(event));
          printed = events.length;
        };
        for (;;) {
          const job = getJob(args.id);
          flush();
          if (isTerminal(job)) {
            flush();
            process.exitCode = exitFor(job.status);
            return;
          }
          await sleep(1_000);
        }
      }),
    }),
    result: defineCommand({
      meta: { name: "result", description: "Print a job's stored result" },
      args: idArg,
      run: userFacing(({ args }) => {
        const { job, text } = readResult(args.id);
        ackTerminalJob(job);
        console.log(renderResult(job, text));
        process.exitCode = exitFor(job.status);
      }),
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Cancel a running job" },
      args: idArg,
      run: userFacing(async ({ args }) => {
        console.log(summarize(await cancelJob(args.id)));
      }),
    }),
    list: defineCommand({
      meta: { name: "list", description: "List recent jobs" },
      args: {
        cwd: { type: "string", description: "Only jobs from this directory" },
        parent: { type: "string", description: "Only jobs started by this job's worker" },
      },
      run: userFacing(({ args }) => {
        console.log(renderList(listJobs({ cwd: args.cwd, parent: args.parent })));
      }),
    }),
  },
});
