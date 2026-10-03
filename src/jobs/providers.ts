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
  "Bash(git status *)",
];
const RESEARCH_CLAUDE_TOOLS = ["WebSearch", "WebFetch"];
/** Lets a claude team lead run the bridge CLI to delegate to codex. */
const TEAMLEAD_CLAUDE_TOOLS = [
  "Bash(npx -y agents-bridge-mcp *)",
  "Bash(npx agents-bridge-mcp *)",
  "Bash(agents-bridge-mcp *)",
];

/** `AGENTS_BRIDGE_CODEX_BIN` / `AGENTS_BRIDGE_CLAUDE_BIN` point at an alternative executable. */
export function binary(provider: Provider): string {
  return process.env[`AGENTS_BRIDGE_${provider.toUpperCase()}_BIN`] ?? provider;
}

/** Tools claude may use without prompting. In write mode this only adds to `acceptEdits`. */
function claudeAllowedTools(job: Job): string[] {
  const tools = job.mode === "write" ? [] : [...READ_ONLY_CLAUDE_TOOLS];
  if (job.role === "research") tools.push(...RESEARCH_CLAUDE_TOOLS);
  if (job.role === "teamlead") tools.push(...TEAMLEAD_CLAUDE_TOOLS);
  return tools;
}

/** The team lead must spawn `node` processes and write job state outside the repo, which workspace-write blocks. */
function codexSandbox(job: Job): string {
  if (job.role === "teamlead") return "danger-full-access";
  return job.mode === "write" ? "workspace-write" : "read-only";
}

export function buildInvocation(job: Job, resumeSessionId?: string): Invocation {
  const command = binary(job.provider);
  if (job.provider === "codex") {
    const args = resumeSessionId
      ? ["exec", "resume", resumeSessionId, "--json"]
      : ["exec", "--json", "--skip-git-repo-check"];
    if (job.model) args.push("--model", job.model);
    // `exec resume` does not accept --sandbox; the resumed thread keeps its original one.
    if (!resumeSessionId) args.push("--sandbox", codexSandbox(job));
    args.push(job.prompt);
    return { command, args };
  }
  const args = ["-p", "--output-format", "json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (job.model) args.push("--model", job.model);
  if (job.mode === "write") args.push("--permission-mode", "acceptEdits");
  for (const tool of claudeAllowedTools(job)) args.push("--allowedTools", tool);
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
