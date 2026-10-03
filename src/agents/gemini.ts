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
 * (reads stay allowed); write jobs in `auto_edit`, which approves file edits; a team lead in `yolo`,
 * because it must run the AgentMate CLI. `plan` would be read-only too but is still experimental.
 */
function approvalMode(job: Job): "default" | "auto_edit" | "yolo" {
  if (job.role === "teamlead") return "yolo";
  return job.mode === "write" ? "auto_edit" : "default";
}

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Assistant text arrives in chunks; one `message` event is emitted when the `result` line closes the
 * turn, so a long answer does not become dozens of events. A worker process runs one job, so this
 * module-level buffer is never shared; `init` and `result` reset it.
 */
let pendingText = "";

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

/** Experimental: written against the documented Gemini CLI headless format and tested with a fake binary. */
export const geminiAdapter: AgentAdapter = {
  id: "gemini",
  displayName: "Gemini CLI",
  binary: () => process.env["AGENTMATE_GEMINI_BIN"] ?? "gemini",
  capabilities: { write: true, web: true, resume: true, streaming: "jsonl" },
  versionArgs: ["--version"],

  buildInvocation(job: Job, resumeSessionId?: string): Invocation {
    const args = ["-p", job.prompt, "--output-format", "stream-json"];
    if (job.model) args.push("--model", job.model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push("--approval-mode", approvalMode(job));
    return { command: geminiAdapter.binary(), args };
  },

  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
    const r = parseGeminiOutput(stdout);
    const outcome: Outcome = {
      text: r.resultText,
      sessionId: r.sessionId,
      errors: r.errors,
      ...(r.partial ? { partial: true } : {}),
    };
    if (exitCode !== 0 && !outcome.text && stderr.trim()) outcome.errors.push(stderr.trim());
    return outcome;
  },

  /** Reads one line of `--output-format stream-json`; see `pendingText` for how messages are batched. */
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
        return [event({ level: "important", kind: "error", text: text.slice(0, MAX_EVENT_TEXT) })];
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
