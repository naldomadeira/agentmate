import { parseClaudeOutput } from "../lib/claude-output-parser.js";
import { VERSION } from "../lib/version.js";
import type { Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const READ_ONLY_CLAUDE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status *)",
];
const RESEARCH_CLAUDE_TOOLS = ["WebSearch", "WebFetch"];
/**
 * Claude write jobs run in `acceptEdits`, where Bash is denied in `-p`; these let an implementer run
 * verification and stage or commit its work. Extend the list with `AGENTMATE_CLAUDE_WRITE_TOOLS`,
 * a comma-separated list of extra permission patterns (for example `Bash(cargo *),Bash(go *)`) that
 * is appended to these defaults for every claude write job.
 */
const WRITE_CLAUDE_TOOLS = [
  ...READ_ONLY_CLAUDE_TOOLS,
  "Bash(pnpm *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(yarn *)",
  "Bash(bun *)",
  "Bash(make *)",
  "Bash(git add *)",
  "Bash(git commit *)",
];
/** Never reachable by a read-only job, whatever the user's own settings allow. */
const READ_ONLY_DENIED_CLAUDE_TOOLS = ["Edit", "Write", "NotebookEdit"];
/** Lets a claude team lead run the AgentMate CLI's `jobs` subcommand, pinned to this version, to delegate to codex. */
const TEAMLEAD_CLAUDE_TOOLS = [
  `Bash(npx -y agentmate@${VERSION} jobs *)`,
  `Bash(npx agentmate@${VERSION} jobs *)`,
  "Bash(agentmate jobs *)",
];

function extraWriteTools(): string[] {
  return (process.env["AGENTMATE_CLAUDE_WRITE_TOOLS"] ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Tools claude may use without prompting. In write mode this only adds to `acceptEdits`. */
function claudeAllowedTools(job: Job): string[] {
  const tools =
    job.mode === "write"
      ? [...WRITE_CLAUDE_TOOLS, ...extraWriteTools()]
      : [...READ_ONLY_CLAUDE_TOOLS];
  if (job.role === "research") tools.push(...RESEARCH_CLAUDE_TOOLS);
  if (job.role === "teamlead") tools.push(...TEAMLEAD_CLAUDE_TOOLS);
  return tools;
}

const MAX_EVENT_TEXT = 500;
const MAX_COMMAND_TEXT = 200;
/** Tools whose use means a file is being changed. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** `Grep TODO`, `Read src/a.ts`, `WebSearch vitest`: the tool name plus its most telling argument. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const arg = str(input["pattern"]) || str(input["file_path"]) || str(input["query"]);
  return (arg ? `${name} ${arg}` : name).slice(0, MAX_COMMAND_TEXT);
}

function toolEvent(block: Record<string, unknown>): JobEvent | null {
  const name = str(block["name"]);
  if (!name) return null;
  const input =
    block["input"] && typeof block["input"] === "object"
      ? (block["input"] as Record<string, unknown>)
      : {};
  if (FILE_TOOLS.has(name)) {
    const path = str(input["file_path"]) || str(input["notebook_path"]);
    if (!path) return null;
    return event({
      level: "status",
      kind: "file",
      text: `${name} ${path}`.slice(0, MAX_EVENT_TEXT),
      data: { path, kind: name },
    });
  }
  if (name === "Bash") {
    const command = str(input["command"]);
    return event({
      level: "fyi",
      kind: "command",
      text: command.slice(0, MAX_COMMAND_TEXT),
      data: { command },
    });
  }
  return event({ level: "fyi", kind: "command", text: toolSummary(name, input) });
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  binary: () => process.env["AGENTMATE_CLAUDE_BIN"] ?? "claude",
  capabilities: { write: true, web: true, resume: true, streaming: "jsonl" },
  versionArgs: ["--version"],

  buildInvocation(job: Job, resumeSessionId?: string): Invocation {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (job.model) args.push("--model", job.model);
    if (job.mode === "write") args.push("--permission-mode", "acceptEdits");
    // `--allowedTools <tool>` is variadic and would swallow the positional prompt, so each is `=`-joined.
    for (const tool of claudeAllowedTools(job)) args.push(`--allowedTools=${tool}`);
    // Allow-lists only add; the user's own settings may still allow edits, so a read-only job denies them.
    if (job.mode === "read-only")
      for (const tool of READ_ONLY_DENIED_CLAUDE_TOOLS) args.push(`--disallowedTools=${tool}`);
    args.push(job.prompt);
    return { command: claudeAdapter.binary(), args };
  },

  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
    const r = parseClaudeOutput(stdout);
    const outcome: Outcome = { text: r.resultText, sessionId: r.sessionId, errors: r.errors };
    if (exitCode !== 0 && !outcome.text && stderr.trim()) outcome.errors.push(stderr.trim());
    return outcome;
  },

  /** Reads one line of `--output-format stream-json`; only assistant text, tool use and error results matter. */
  parseStreamLine(line: string): JobEvent[] {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      parsed = value as Record<string, unknown>;
    } catch {
      return [];
    }
    if (parsed["type"] === "result") {
      if (parsed["is_error"] !== true) return [];
      const text =
        str(parsed["result"]).trim() || str(parsed["subtype"]) || "claude reported an error";
      return [event({ level: "important", kind: "error", text: text.slice(0, MAX_EVENT_TEXT) })];
    }
    if (parsed["type"] !== "assistant") return [];
    const message = parsed["message"];
    const content =
      message && typeof message === "object" ? (message as Record<string, unknown>)["content"] : [];
    if (!Array.isArray(content)) return [];
    const events: JobEvent[] = [];
    for (const block of content as unknown[]) {
      if (!block || typeof block !== "object") continue;
      const part = block as Record<string, unknown>;
      if (part["type"] === "text") {
        const text = str(part["text"]);
        if (text.trim())
          events.push(
            event({ level: "important", kind: "message", text: text.slice(0, MAX_EVENT_TEXT) }),
          );
      } else if (part["type"] === "tool_use") {
        const toolEventResult = toolEvent(part);
        if (toolEventResult) events.push(toolEventResult);
      }
    }
    return events;
  },
};
