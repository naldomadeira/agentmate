import { parseClaudeOutput } from "../lib/claude-output-parser.js";
import { parseCodexOutput } from "../lib/codex-output-parser.js";
import type { Job, Provider } from "./store.js";

export interface Invocation {
  command: string;
  args: string[];
}

export interface Outcome {
  text: string;
  sessionId: string | null;
  errors: string[];
}

const READ_ONLY_CLAUDE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
];

/** `AGENTS_BRIDGE_CODEX_BIN` / `AGENTS_BRIDGE_CLAUDE_BIN` point at an alternative executable. */
function binary(provider: Provider): string {
  return process.env[`AGENTS_BRIDGE_${provider.toUpperCase()}_BIN`] ?? provider;
}

export function buildInvocation(job: Job, resumeSessionId?: string): Invocation {
  const command = binary(job.provider);
  if (job.provider === "codex") {
    const args = resumeSessionId
      ? ["exec", "resume", resumeSessionId, "--json"]
      : ["exec", "--json"];
    if (job.model) args.push("--model", job.model);
    // `exec resume` does not accept --sandbox; the resumed thread keeps its original one.
    if (!resumeSessionId)
      args.push("--sandbox", job.mode === "write" ? "workspace-write" : "read-only");
    args.push(job.prompt);
    return { command, args };
  }
  const args = ["-p", "--output-format", "json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (job.model) args.push("--model", job.model);
  if (job.mode === "write") args.push("--permission-mode", "acceptEdits");
  else for (const tool of READ_ONLY_CLAUDE_TOOLS) args.push("--allowedTools", tool);
  args.push(job.prompt);
  return { command, args };
}

export function parseOutcome(
  provider: Provider,
  stdout: string,
  stderr: string,
  exitCode: number,
): Outcome {
  const outcome: Outcome =
    provider === "codex"
      ? (() => {
          const r = parseCodexOutput(stdout);
          return { text: r.agentMessage, sessionId: r.threadId, errors: r.errors };
        })()
      : (() => {
          const r = parseClaudeOutput(stdout);
          return { text: r.resultText, sessionId: r.sessionId, errors: r.errors };
        })();
  if (exitCode !== 0 && !outcome.text && stderr.trim()) outcome.errors.push(stderr.trim());
  return outcome;
}
