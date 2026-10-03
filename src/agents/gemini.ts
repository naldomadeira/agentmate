import {
  eventErrorText,
  isAssistantMessage,
  messageText,
  parseGeminiOutput,
} from "../lib/gemini-output-parser.js";
import type { Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const MAX_EVENT_TEXT = 500;
const MAX_COMMAND_TEXT = 200;
/** Tools whose use means a file is being changed (`write_file`, `replace`, and edit variants). */
const FILE_TOOLS = /write_file|replace|edit/i;
const PATH_KEYS = ["file_path", "path", "absolute_path"] as const;

/**
 * Read-only and research jobs run in `default`, where headless mode denies tools that need approval
 * (reads stay allowed, shell and web do not); write jobs in `auto_edit`, which approves file edits but
 * still denies the shell; a write-mode team lead in `yolo`, because it must run the AgentMate CLI.
 * A read-only team lead never gets `yolo` (`startJob` refuses one, and this keeps `default` if a job
 * reaches the adapter anyway). `plan` would be read-only too but is still experimental.
 */
function approvalMode(job: Job): "default" | "auto_edit" | "yolo" {
  if (job.mode !== "write") return "default";
  return job.role === "teamlead" ? "yolo" : "auto_edit";
}

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function toolEvent(parsed: Record<string, unknown>): JobEvent | null {
  const name = str(parsed["name"]) || str(parsed["tool_name"]) || str(parsed["tool"]);
  if (!name) return null;
  const args = [parsed["args"], parsed["input"], parsed["parameters"]].find(isObject) ?? {};
  if (FILE_TOOLS.test(name)) {
    const path = PATH_KEYS.map((key) => str(args[key])).find(Boolean) ?? "";
    if (path)
      return event({
        level: "status",
        kind: "file",
        text: `${name} ${path}`.slice(0, MAX_EVENT_TEXT),
        data: { path, kind: name },
      });
  }
  if (name === "run_shell_command") {
    const command = str(args["command"]);
    return event({
      level: "fyi",
      kind: "command",
      text: command.slice(0, MAX_COMMAND_TEXT),
      data: { command },
    });
  }
  return event({ level: "fyi", kind: "command", text: name.slice(0, MAX_COMMAND_TEXT) });
}

/**
 * Experimental: written against the documented Gemini CLI headless format and tested with a fake
 * binary, never against the real CLI. Headless Gemini denies shell and web tools (`shell` and `web`
 * are false) and `--resume` is unverified (`resume` is false).
 *
 * Assistant text arrives in chunks; each adapter instance buffers it and emits one `message` event
 * when the `result` line closes the turn, so a long answer does not become dozens of events. The
 * buffer is per instance, reset by `init`, `result` and `resetStream()`.
 */
export function createGeminiAdapter(): AgentAdapter {
  let pendingText = "";

  const adapter: AgentAdapter = {
    id: "gemini",
    displayName: "Gemini CLI",
    binary: () => process.env["AGENTMATE_GEMINI_BIN"] ?? "gemini",
    capabilities: { write: true, web: false, resume: false, shell: false, streaming: "jsonl" },
    // Headless Gemini allows the shell a team lead delegates through only in `yolo` mode.
    teamleadNeedsWrite: true,
    teamleadWriteReason:
      "A Gemini team lead needs mode write: delegation requires the shell, which Gemini only allows in yolo mode.",
    versionArgs: ["--version"],

    resetStream(): void {
      pendingText = "";
    },

    buildInvocation(job: Job, resumeSessionId?: string): Invocation {
      // `-p` takes the prompt as its value, but a prompt that starts with `-` could still be read as a
      // flag, so it is prefixed with a space (the model does not care).
      const prompt = job.prompt.startsWith("-") ? ` ${job.prompt}` : job.prompt;
      const args = ["-p", prompt, "--output-format", "stream-json"];
      if (job.model) args.push("--model", job.model);
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      args.push("--approval-mode", approvalMode(job));
      return { command: adapter.binary(), args };
    },

    parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
      const r = parseGeminiOutput(stdout);
      const outcome: Outcome = {
        text: r.resultText,
        sessionId: r.sessionId,
        errors: r.errors,
        ...(r.partial ? { partial: true } : {}),
      };
      if (r.rawText && exitCode !== 0) {
        // Plain text is a fallback answer only after a clean exit; after a failure it is the error.
        outcome.errors.push(`gemini exited ${exitCode}: ${r.resultText.slice(0, MAX_EVENT_TEXT)}`);
        outcome.text = "";
      } else if (exitCode !== 0 && !r.completed && !r.rawText) {
        outcome.errors.push(`gemini exited ${exitCode} without a final result`);
        if (outcome.text) outcome.partial = true;
      }
      if (exitCode !== 0 && !outcome.text && stderr.trim()) outcome.errors.push(stderr.trim());
      return outcome;
    },

    /** Reads one line of `--output-format stream-json`; see `createGeminiAdapter` for how messages are batched. */
    parseStreamLine(line: string): JobEvent[] {
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value)) return [];
        parsed = value;
      } catch {
        return [];
      }
      switch (parsed["type"]) {
        case "init":
          pendingText = "";
          return [];
        case "message":
          if (isAssistantMessage(parsed)) {
            const text = messageText(parsed);
            if (text) pendingText += text;
          }
          return [];
        case "tool_use": {
          const tool = toolEvent(parsed);
          return tool ? [tool] : [];
        }
        case "error": {
          const text = eventErrorText(parsed) || "gemini reported an error";
          // A warning is progress noise, not a failure: it must not wake the host like an error does.
          if (str(parsed["severity"]).toLowerCase() === "warning")
            return [
              event({
                level: "status",
                kind: "error",
                text: `warning: ${text}`.slice(0, MAX_EVENT_TEXT),
              }),
            ];
          return [
            event({ level: "important", kind: "error", text: text.slice(0, MAX_EVENT_TEXT) }),
          ];
        }
        case "result": {
          const events: JobEvent[] = [];
          const text = (str(parsed["response"]) || pendingText).trim();
          pendingText = "";
          if (text)
            events.push(
              event({ level: "important", kind: "message", text: text.slice(0, MAX_EVENT_TEXT) }),
            );
          if (parsed["error"] !== undefined || parsed["status"] === "error") {
            const failure = eventErrorText(parsed) || "gemini reported an error";
            events.push(
              event({ level: "important", kind: "error", text: failure.slice(0, MAX_EVENT_TEXT) }),
            );
          }
          return events;
        }
        default:
          return [];
      }
    },
  };
  return adapter;
}

export const geminiAdapter: AgentAdapter = createGeminiAdapter();
