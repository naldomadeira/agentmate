import { grokErrorText, parseGrokOutput } from "../lib/grok-output-parser.js";
import type { Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const MAX_EVENT_TEXT = 500;
const MAX_COMMAND_TEXT = 200;

/** Tools that change files or reach outside the repository; a read-only job never gets them. */
const READ_ONLY_DENIED_TOOLS = ["write", "search_replace", "run_terminal_command", "image_edit"];
/** Tools whose use changes a file; their path argument becomes a `file` event. */
const FILE_TOOLS = new Set(["write", "search_replace"]);

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * xAI Grok Build (`grok -p`). Written against the real CLI (1.0.70): the streaming-json output carries
 * `text` chunks, ACP-style tool calls and a final `end` with the session id, which `--resume` continues.
 *
 * Read-only jobs deny the write and shell tools (so `shell` is false: a reviewer gets the diff inline).
 * Write jobs run with `--always-approve`, because headless Grok has no other way to approve edits and
 * shell; Grok is therefore the least restricted write agent, and `allowPush` is not offered for it.
 * Assistant text arrives in chunks: the adapter buffers it and emits one `message` event per turn
 * segment (flushed at each tool call and at `end`).
 */
export function createGrokAdapter(): AgentAdapter {
  let pendingText = "";

  const flush = (): JobEvent[] => {
    const text = pendingText.trim();
    pendingText = "";
    return text
      ? [event({ level: "important", kind: "message", text: text.slice(0, MAX_EVENT_TEXT) })]
      : [];
  };

  const adapter: AgentAdapter = {
    id: "grok",
    displayName: "Grok Build CLI",
    binary: () => process.env["AGENTMATE_GROK_BIN"] ?? "grok",
    capabilities: { write: true, web: true, resume: true, shell: false, streaming: "jsonl" },
    // A team lead delegates through the shell, which a read-only Grok job does not have.
    teamleadNeedsWrite: true,
    teamleadWriteReason:
      "A Grok team lead needs mode write: delegation requires the shell, which read-only Grok jobs deny.",
    versionArgs: ["--version"],

    effortError: () => null,

    resetStream(): void {
      pendingText = "";
    },

    buildInvocation(job: Job, resumeSessionId?: string): Invocation {
      // `-p` takes the prompt as its value, but a prompt that starts with `-` could still be read as a
      // flag, so it is prefixed with a space (the model does not care).
      const prompt = job.prompt.startsWith("-") ? ` ${job.prompt}` : job.prompt;
      const args = ["-p", prompt, "--output-format", "streaming-json"];
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (job.model) args.push("--model", job.model);
      if (job.effort) args.push("--reasoning-effort", job.effort);
      if (job.mode === "write") args.push("--always-approve");
      else args.push(`--disallowed-tools=${READ_ONLY_DENIED_TOOLS.join(",")}`);
      return { command: adapter.binary(), args };
    },

    parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
      const r = parseGrokOutput(stdout, exitCode);
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

    /** Messages (batched), shell commands, file edits and errors; thoughts, usage and updates are skipped. */
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
        case "text":
          pendingText += str(parsed["data"]);
          return [];
        case "error":
          return [
            event({
              level: "important",
              kind: "error",
              text: grokErrorText(parsed).slice(0, MAX_EVENT_TEXT),
            }),
          ];
        case "end":
          return flush();
        case "tool_call": {
          const events = flush();
          const tool = str(parsed["toolName"]) || str(parsed["title"]);
          const input = isObject(parsed["rawInput"]) ? parsed["rawInput"] : {};
          if (tool === "run_terminal_command") {
            const command = str(input["command"]);
            events.push(
              event({
                level: "fyi",
                kind: "command",
                text: command.slice(0, MAX_COMMAND_TEXT) || tool,
                data: { command },
              }),
            );
          } else if (FILE_TOOLS.has(tool)) {
            const path = str(input["target_file"]) || str(input["file_path"]) || str(input["path"]);
            events.push(
              path
                ? event({
                    level: "status",
                    kind: "file",
                    text: `${tool} ${path}`.slice(0, MAX_EVENT_TEXT),
                    data: { path, kind: tool },
                  })
                : event({ level: "fyi", kind: "command", text: tool }),
            );
          } else if (tool) {
            events.push(
              event({ level: "fyi", kind: "command", text: tool.slice(0, MAX_COMMAND_TEXT) }),
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

export const grokAdapter: AgentAdapter = createGrokAdapter();
