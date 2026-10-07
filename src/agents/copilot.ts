import { copilotErrorText, eventData, parseCopilotOutput } from "../lib/copilot-output-parser.js";
import type { Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const MAX_EVENT_TEXT = 500;
const MAX_COMMAND_TEXT = 200;

/**
 * Copilot permission patterns (`copilot help permissions`). `shell(git diff)` approves that git
 * subcommand with any arguments; `shell(pnpm:*)` approves every pnpm command.
 */
const READ_ONLY_COPILOT_TOOLS = [
  "shell(git diff)",
  "shell(git log)",
  "shell(git show)",
  "shell(git status)",
];
/**
 * What a write job may run without prompting, besides editing files: verification and staging or
 * committing its work. Extend it with `AGENTMATE_COPILOT_WRITE_TOOLS`, a comma-separated list of
 * extra patterns (for example `shell(cargo:*),shell(go:*)`).
 */
const WRITE_COPILOT_TOOLS = [
  ...READ_ONLY_COPILOT_TOOLS,
  "write",
  "shell(pnpm:*)",
  "shell(npm:*)",
  "shell(npx:*)",
  "shell(yarn:*)",
  "shell(bun:*)",
  "shell(make:*)",
  "shell(git add)",
  "shell(git commit)",
];
/** A team lead delegates through the AgentMate CLI, run directly or through npx. */
const TEAMLEAD_COPILOT_TOOLS = ["shell(agentmate:*)", "shell(npx:*)"];
/** Tools whose use changes a file; their `path` argument becomes a `file` event. */
const FILE_TOOLS = new Set(["edit", "create", "write", "str_replace_editor"]);

function extraWriteTools(): string[] {
  return (process.env["AGENTMATE_COPILOT_WRITE_TOOLS"] ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Tools copilot may use without prompting; in `-p` everything else is refused. */
export function copilotAllowedTools(job: Job): string[] {
  // A review with commands allowed runs any shell command to verify its claims; file tools stay denied.
  if (job.role === "review" && job.allowCommands) return ["shell"];
  const tools =
    job.mode === "write"
      ? [...WRITE_COPILOT_TOOLS, ...extraWriteTools()]
      : [...READ_ONLY_COPILOT_TOOLS];
  if (job.role === "teamlead") tools.push(...TEAMLEAD_COPILOT_TOOLS);
  return tools;
}

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const args = (data: Record<string, unknown>): Record<string, unknown> => {
  const value = data["arguments"];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

/**
 * GitHub Copilot CLI (`copilot -p`). Its JSONL carries the session id on the final `result`, which
 * `--resume` continues. Model availability depends on the Copilot plan and policies, so `model` is
 * passed through and an unavailable one fails with Copilot's own message; `auto` (the default)
 * takes no reasoning effort.
 */
export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  binary: () => process.env["AGENTMATE_COPILOT_BIN"] ?? "copilot",
  capabilities: { write: true, web: false, resume: true, shell: true, streaming: "jsonl" },
  teamleadNeedsWrite: false,
  versionArgs: ["--version"],

  effortError: ({ effort, model }) =>
    effort && (!model || model === "auto")
      ? `copilot's auto model takes no reasoning effort, so effort ${effort} needs a model. Pass model too (one your Copilot plan enables), or drop effort.`
      : null,

  buildInvocation(job: Job, resumeSessionId?: string): Invocation {
    // `-p` takes the prompt as its value, but a prompt that starts with `-` could still be read as a
    // flag, so it is prefixed with a space (the model does not care).
    const prompt = job.prompt.startsWith("-") ? ` ${job.prompt}` : job.prompt;
    const args = ["-p", prompt, "--output-format", "json", "--no-auto-update"];
    // Without these a worker gets the GitHub MCP servers (with the signed-in account) and the
    // user's personal skills; AGENTMATE_COPILOT_INHERIT=1 keeps them.
    if (process.env["AGENTMATE_COPILOT_INHERIT"] !== "1")
      args.push("--disable-builtin-mcps", "--excluded-tools=skill");
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (job.model) args.push("--model", job.model);
    if (job.effort) args.push("--reasoning-effort", job.effort);
    // Variadic flags are `=`-joined so none can swallow the next argument.
    for (const tool of copilotAllowedTools(job)) args.push(`--allow-tool=${tool}`);
    // Denials win over every allow, so a read-only job never edits, whatever the user configured.
    if (job.mode === "read-only") args.push("--deny-tool=write");
    return { command: copilotAdapter.binary(), args };
  },

  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
    const r = parseCopilotOutput(stdout, exitCode);
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

  /** Assistant messages, shell commands, file edits and errors; deltas and telemetry are skipped. */
  parseStreamLine(line: string): JobEvent[] {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      parsed = value as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = str(parsed["type"]);
    const data = eventData(parsed);
    if (type === "error" || type.endsWith(".error"))
      return [
        event({
          level: "important",
          kind: "error",
          text: copilotErrorText(parsed).slice(0, MAX_EVENT_TEXT),
        }),
      ];
    if (type === "assistant.message") {
      const text = str(data["content"]).trim();
      return text
        ? [event({ level: "important", kind: "message", text: text.slice(0, MAX_EVENT_TEXT) })]
        : [];
    }
    if (type !== "tool.execution_start") return [];
    const tool = str(data["toolName"]);
    const input = args(data);
    if (tool === "bash" || tool === "shell") {
      const command = str(input["command"]);
      return [
        event({
          level: "fyi",
          kind: "command",
          text: command.slice(0, MAX_COMMAND_TEXT) || tool,
          data: { command },
        }),
      ];
    }
    if (FILE_TOOLS.has(tool)) {
      const path = str(input["path"]) || str(input["file_path"]);
      if (path)
        return [
          event({
            level: "status",
            kind: "file",
            text: `${tool} ${path}`.slice(0, MAX_EVENT_TEXT),
            data: { path, kind: tool },
          }),
        ];
    }
    return [event({ level: "fyi", kind: "command", text: tool.slice(0, MAX_COMMAND_TEXT) })];
  },
};
