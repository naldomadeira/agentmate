import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgent } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";

const execFileAsync = promisify(execFile);

/** The most diff characters that travel inline in a briefing. */
export const INLINE_DIFF_CHARS = 30_000;
const GIT_TIMEOUT_MS = 60_000;

/** True when the agent can run shell commands (such as `git diff`) headless. */
export const canRunShell = (agent: AgentId): boolean => getAgent(agent).capabilities.shell;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/** A code fence longer than any backtick run inside `text`, so a diff of a markdown file cannot close it. */
function fenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
}

/**
 * The change in `cwd` as a briefing section for a reviewer that cannot run the shell: the output of
 * `git diff` against `base` (default `HEAD`, so staged and unstaged changes are both covered), capped
 * at 30 000 characters, followed by the names of untracked files, which `git diff` leaves out. A
 * failure to compute it is reported inside the section instead of thrown, because the review can
 * still read files.
 */
export async function inlineDiff(cwd: string, base?: string): Promise<string> {
  const note = "The reviewer may not run shell commands, so the diff is given here.";
  let diff: string;
  try {
    try {
      diff = await git(["diff", base ?? "HEAD"], cwd);
    } catch (cause) {
      // A repository without commits has no HEAD to diff against.
      if (base) throw cause;
      diff = await git(["diff"], cwd);
    }
  } catch (cause) {
    const reason = (cause as { stderr?: string; message: string }).stderr?.trim().split("\n")[0];
    return `Diff: ${note} It could not be computed (${reason || (cause as Error).message}); read the changed files directly.`;
  }
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], cwd).then(
    (out) => out.split("\n").filter(Boolean),
    () => [],
  );
  const truncated = diff.length > INLINE_DIFF_CHARS;
  const shown = truncated ? diff.slice(0, INLINE_DIFF_CHARS) : diff;
  const fence = fenceFor(shown);
  const sections = [
    `Diff: ${note}${truncated ? ` It is cut at ${INLINE_DIFF_CHARS} characters; read the files for the rest.` : ""}`,
    shown.trim()
      ? `${fence}diff\n${shown.trimEnd()}\n${fence}`
      : "(git diff is empty: there are no tracked changes)",
  ];
  if (untracked.length > 0)
    sections.push(`Untracked files (not in the diff): ${untracked.slice(0, 50).join(", ")}`);
  return sections.join("\n\n");
}
