import { parseClaudeOutput } from "../lib/claude-output-parser.js";
import { parseCodexOutput } from "../lib/codex-output-parser.js";
import { VERSION } from "../lib/version.js";
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

/** `AGENTMATE_CODEX_BIN` / `AGENTMATE_CLAUDE_BIN` point at an alternative executable. */
export function binary(provider: Provider): string {
  return process.env[`AGENTMATE_${provider.toUpperCase()}_BIN`] ?? provider;
}

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
  // `--allowedTools <tool>` is variadic and would swallow the positional prompt, so each is `=`-joined.
  for (const tool of claudeAllowedTools(job)) args.push(`--allowedTools=${tool}`);
  // Allow-lists only add; the user's own settings may still allow edits, so a read-only job denies them.
  if (job.mode === "read-only")
    for (const tool of READ_ONLY_DENIED_CLAUDE_TOOLS) args.push(`--disallowedTools=${tool}`);
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
