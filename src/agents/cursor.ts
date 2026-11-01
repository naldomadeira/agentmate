import { cursorAssistantText, parseCursorOutput } from "../lib/cursor-output-parser.js";
import type { Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const MAX_EVENT_TEXT = 500;
const MAX_COMMAND_TEXT = 200;

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Cursor CLI (`cursor-agent -p`). Experimental: written against the documented headless format and
 * tested with a fake binary, never against the real CLI (it was not installed when this was added).
 *
 * Without `--force` headless Cursor proposes changes but does not apply them, which is what read-only
 * jobs want, together with `--mode ask`; write jobs pass `--force`. Shell is not offered to read-only
 * jobs (`shell: false`, the reviewer gets the diff inline). Resume (`--resume <chatId>`) is unverified,
 * so `resume` is false and `continueJob` refuses it instead of passing an untested flag.
 */
export function createCursorAdapter(): AgentAdapter {
  const adapter: AgentAdapter = {
    id: "cursor",
    displayName: "Cursor CLI",
    binary: () => process.env["AGENTMATE_CURSOR_BIN"] ?? "cursor-agent",
    capabilities: { write: true, web: false, resume: false, shell: false, streaming: "jsonl" },
    teamleadNeedsWrite: true,
    teamleadWriteReason:
      "A Cursor team lead needs mode write: delegation requires the shell, which Cursor only runs with --force.",
    versionArgs: ["--version"],

    effortError: ({ effort }) =>
      effort
        ? `cursor has no reasoning effort setting in headless mode, so effort ${effort} cannot be applied. Pick an effort-tagged model id instead, or drop effort.`
        : null,

    buildInvocation(job: Job, resumeSessionId?: string): Invocation {
      const prompt = job.prompt.startsWith("-") ? ` ${job.prompt}` : job.prompt;
      const args = ["-p", prompt, "--output-format", "stream-json"];
      if (job.model) args.push("--model", job.model);
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (job.mode === "write") args.push("--force");
      else args.push("--mode", "ask");
      return { command: adapter.binary(), args };
    },

    parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
      const r = parseCursorOutput(stdout, exitCode);
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

    parseStreamLine(line: string): JobEvent[] {
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value)) return [];
        parsed = value;
      } catch {
        return [];
      }
      const type = str(parsed["type"]);
      if (type === "assistant") {
        const text = cursorAssistantText(parsed).trim();
        return text
          ? [event({ level: "important", kind: "message", text: text.slice(0, MAX_EVENT_TEXT) })]
          : [];
      }
      if (type === "error")
        return [
          event({
            level: "important",
            kind: "error",
            text: (
              str(parsed["message"]) ||
              str(parsed["error"]) ||
              "cursor reported an error"
            ).slice(0, MAX_EVENT_TEXT),
          }),
        ];
      if (type === "result" && (parsed["is_error"] === true || str(parsed["subtype"]) === "error"))
        return [
          event({
            level: "important",
            kind: "error",
            text: (str(parsed["result"]) || "cursor reported an error").slice(0, MAX_EVENT_TEXT),
          }),
        ];
      if (type !== "tool_call" || str(parsed["subtype"]) !== "started") return [];
      const call = isObject(parsed["tool_call"]) ? parsed["tool_call"] : {};
      // The call is `{ <name>ToolCall: { args: {...} } }`, for example `shellToolCall` or `editToolCall`.
      const key = Object.keys(call)[0] ?? "";
      const body = isObject(call[key]) ? call[key] : {};
      const input = isObject(body["args"]) ? body["args"] : {};
      const name = key.replace(/ToolCall$/, "") || "tool";
      if (name === "shell") {
        const command = str(input["command"]);
        return [
          event({
            level: "fyi",
            kind: "command",
            text: command.slice(0, MAX_COMMAND_TEXT) || name,
            data: { command },
          }),
        ];
      }
      if (name === "edit" || name === "write" || name === "delete") {
        const path = str(input["path"]);
        if (path)
          return [
            event({
              level: "status",
              kind: "file",
              text: `${name} ${path}`.slice(0, MAX_EVENT_TEXT),
              data: { path, kind: name },
            }),
          ];
      }
      return [event({ level: "fyi", kind: "command", text: name.slice(0, MAX_COMMAND_TEXT) })];
    },
  };
  return adapter;
}

export const cursorAdapter: AgentAdapter = createCursorAdapter();
