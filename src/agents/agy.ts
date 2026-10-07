import {
  agyErrorMessage,
  eventBody,
  parseAgyOutput,
  payloadFailure,
} from "../lib/agy-output-parser.js";
import type { Effort, Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const MAX_EVENT_TEXT = 500;
const MAX_COMMAND_TEXT = 200;
/** Tools whose use means a file is being changed (`write_to_file`, `replace_file_content`, and edit variants). */
const FILE_TOOLS = /write|replace|edit|create/i;
/** Parameter names that hold the path a file tool works on, in the order they are tried. */
const PATH_KEYS = ["TargetFile", "AbsolutePath", "FilePath", "Path", "file_path", "path"] as const;

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A tool's parameters as an object; agy may also send them as a JSON string. */
function parametersOf(info: Record<string, unknown>): Record<string, unknown> {
  const raw = info["parameters"];
  if (isObject(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) return parsed;
    } catch {
      // a plain string is shown as it is by the caller
    }
  }
  return {};
}

const basename = (filePath: string): string => filePath.split(/[\\/]/).pop() || filePath;

/** The one parameter of a tool step worth showing, short: a command line, a query, a file name or the first string. */
function hintOf(parameters: Record<string, unknown>): string {
  const command = str(parameters["CommandLine"]);
  if (command) return command;
  const query = str(parameters["Query"]);
  if (query) return query;
  for (const key of PATH_KEYS) {
    const value = str(parameters[key]);
    if (value) return basename(value);
  }
  return Object.values(parameters).find((v): v is string => typeof v === "string" && !!v) ?? "";
}

const AGY_EFFORTS: readonly string[] = ["low", "medium", "high"];
const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;

/**
 * agy names the effort inside the model id (`gemini-3.1-pro-high`), so an effort replaces the id's
 * effort suffix or is appended to an id without one. Without an effort the id is passed as given.
 */
export function agyModelId(model: string, effort: Effort | undefined): string {
  if (!effort) return model;
  return `${model.replace(AGY_EFFORT_SUFFIX, "")}-${effort}`;
}

/**
 * Experimental: written against the stream-json format the author's agy-staff plugin reads (`init`,
 * `step_update` and a final `result` event, each carrying its payload under its own name) and
 * tested with a fake binary, never against the real CLI.
 *
 * Without `--dangerously-skip-permissions`, headless agy denies tool calls that its profile does not
 * allow. Read-only jobs therefore pass no permission flag and rely on that profile, so their results
 * can be thin until the user installs an allowlist; write jobs (and the write-only team lead, which
 * must run the AgentMate CLI) skip permissions. Shell is declared `false`, so a reviewer gets the diff
 * inline instead of running `git diff`.
 *
 * A tool step arrives as `ACTIVE` and again as `DONE`; each step becomes one event, when first seen,
 * and a failing `DONE` adds a `status` error event. Agent text arrives in deltas; the adapter buffers
 * it for a `result` that carries no `response`. The state is per instance, reset by `init`, `result`
 * and `resetStream()`.
 */
export function createAgyAdapter(): AgentAdapter {
  let pendingText = "";
  const seenSteps = new Set<string>();

  const reset = (): void => {
    pendingText = "";
    seenSteps.clear();
  };

  /** Events for one tool step update. */
  function toolEvents(step: Record<string, unknown>, conversation: string): JobEvent[] {
    const info = isObject(step["tool_info"]) ? step["tool_info"] : {};
    const name = str(step["tool_name"]) || str(info["name"]) || "unknown";
    const parameters = parametersOf(info);
    const events: JobEvent[] = [];

    const key = `${conversation}:${String(step["step_index"])}`;
    if (!seenSteps.has(key)) {
      seenSteps.add(key);
      const path = PATH_KEYS.map((k) => str(parameters[k])).find(Boolean) ?? "";
      if (FILE_TOOLS.test(name) && path)
        events.push(
          event({
            level: "status",
            kind: "file",
            text: `${name} ${path}`.slice(0, MAX_EVENT_TEXT),
            data: { path, kind: name },
          }),
        );
      else if (str(parameters["CommandLine"])) {
        const command = str(parameters["CommandLine"]);
        events.push(
          event({
            level: "fyi",
            kind: "command",
            text: command.slice(0, MAX_COMMAND_TEXT),
            data: { command },
          }),
        );
      } else {
        const hint = hintOf(parameters) || str(info["parameters"]);
        events.push(
          event({
            level: "fyi",
            kind: "command",
            text: (hint ? `${name} ${hint}` : name).slice(0, MAX_COMMAND_TEXT),
          }),
        );
      }
    }

    // A tool that failed is progress noise, not a failed job: it stays at `status`.
    const failure = agyErrorMessage(info["error"]) || agyErrorMessage(step["error"]);
    if (failure && step["state"] !== "ACTIVE")
      events.push(
        event({
          level: "status",
          kind: "error",
          text: `${name} failed: ${failure}`.slice(0, MAX_EVENT_TEXT),
        }),
      );
    return events;
  }

  const adapter: AgentAdapter = {
    id: "agy",
    displayName: "Antigravity CLI (agy)",
    binary: () => process.env["AGENTMATE_AGY_BIN"] ?? "agy",
    capabilities: { write: true, web: false, resume: true, shell: false, streaming: "jsonl" },
    // Headless agy allows the shell only with --dangerously-skip-permissions, which needs write mode.
    teamleadNeedsWrite: true,
    teamleadWriteReason:
      "An agy team lead needs mode write: delegation requires the shell, which agy only allows with --dangerously-skip-permissions.",
    versionArgs: ["--version"],

    resetStream: reset,

    effortError: ({ effort, model }) => {
      if (!effort) return null;
      if (!AGY_EFFORTS.includes(effort))
        return `agy model ids carry low, medium or high, not ${effort}. Pick one of those.`;
      if (!model)
        return `agy carries the effort in the model id (gemini-3.1-pro-high), so effort ${effort} needs a model. Pass model too, e.g. gemini-3.1-pro.`;
      return null;
    },

    buildInvocation(job: Job, resumeSessionId?: string): Invocation {
      // `-p` takes the prompt as its value, but a prompt that starts with `-` could still be read as a
      // flag, so it is prefixed with a space (the model does not care).
      const prompt = job.prompt.startsWith("-") ? ` ${job.prompt}` : job.prompt;
      const minutes = Math.max(1, Math.ceil(job.timeoutMs / 60_000));
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--add-dir",
        job.cwd,
        "--print-timeout",
        `${minutes}m`,
      ];
      if (job.model) args.push("--model", agyModelId(job.model, job.effort));
      if (resumeSessionId) args.push("--conversation", resumeSessionId);
      if (job.mode === "write") args.push("--dangerously-skip-permissions");
      return { command: adapter.binary(), args };
    },

    parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
      const r = parseAgyOutput(stdout, exitCode);
      const outcome: Outcome = {
        text: r.resultText,
        sessionId: r.sessionId,
        errors: r.errors,
        ...(r.partial ? { partial: true } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      };
      if (exitCode !== 0 && !outcome.text && stderr.trim()) outcome.errors.push(stderr.trim());
      return outcome;
    },

    /** Reads one line of `--output-format stream-json`; see `createAgyAdapter` for the state it keeps. */
    parseStreamLine(line: string): JobEvent[] {
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value)) return [];
        parsed = value;
      } catch {
        return [];
      }
      switch (parsed["event"]) {
        case "init":
          reset();
          return [];
        case "step_update": {
          const step = parsed["step_update"];
          if (!isObject(step)) return [];
          const conversation = str(step["conversation_id"]);
          if (step["step_type"] === "tool") return toolEvents(step, conversation);
          if (step["step_type"] === "agent_response") pendingText += str(step["text_delta"]);
          return [];
        }
        case "result": {
          const body = eventBody(parsed);
          if (body === parsed) return [];
          const events: JobEvent[] = [];
          const text = (str(body["response"]) || pendingText).trim();
          reset();
          if (text)
            events.push(
              event({ level: "important", kind: "message", text: text.slice(0, MAX_EVENT_TEXT) }),
            );
          const failure = payloadFailure(body);
          if (failure)
            events.push(
              event({ level: "important", kind: "error", text: failure.slice(0, MAX_EVENT_TEXT) }),
            );
          return events;
        }
        default:
          return [];
      }
    },
  };
  return adapter;
}

export const agyAdapter: AgentAdapter = createAgyAdapter();
