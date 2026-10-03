import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { userFacing } from "../lib/errors.js";
import { binary } from "../jobs/providers.js";
import { homeDir, isAlive, listJobIds, readJob, type Provider } from "../jobs/store.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 5_000;
/** `claude mcp list` health-checks every server, which is slow. */
const MCP_LIST_TIMEOUT_MS = 15_000;
/** A running job younger than this may still be starting, so it is not judged stale. */
const STALE_GRACE_MS = 10_000;
const MIN_NODE_MAJOR = 18;

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const ok = (name: string, detail: string): Check => ({ name, status: "ok", detail });
const warn = (name: string, detail: string, hint: string): Check => ({
  name,
  status: "warn",
  detail,
  hint,
});
const fail = (name: string, detail: string, hint: string): Check => ({
  name,
  status: "fail",
  detail,
  hint,
});

/** Runs a command with a short deadline; null when it is missing, fails or times out. */
async function run(command: string, args: string[], timeout: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

function checkNode(): Check {
  const major = Number.parseInt(process.versions.node, 10);
  return major >= MIN_NODE_MAJOR
    ? ok("node", `v${process.versions.node}`)
    : fail("node", `v${process.versions.node}`, `Install Node.js ${MIN_NODE_MAJOR} or newer.`);
}

const INSTALL_HINTS: Record<Provider, string> = {
  codex: "Install the Codex CLI (npm install -g @openai/codex) to delegate to codex.",
  claude: "Install Claude Code (https://claude.com/claude-code) to delegate to claude.",
};

async function checkProvider(provider: Provider): Promise<Check> {
  const version = await run(binary(provider), ["--version"], VERSION_TIMEOUT_MS);
  if (version === null)
    return warn(provider, "not found on PATH or not responding", INSTALL_HINTS[provider]);
  return ok(provider, version.split("\n")[0] ?? version);
}

function checkStateDir(): Check {
  const dir = homeDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return ok("state directory", dir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      "state directory",
      `${dir} is not writable (${reason})`,
      "Fix its permissions or set AGENTMATE_HOME to a writable directory.",
    );
  }
}

function checkJobs(): Check {
  const jobs = listJobIds()
    .map((id) => readJob(id))
    .filter((job) => job !== null);
  const running = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const stale = running.filter(
    (job) =>
      Date.now() - Date.parse(job.createdAt) > STALE_GRACE_MS &&
      (job.workerPid ? !isAlive(job.workerPid) : true),
  );
  const detail = `${jobs.length} job${jobs.length === 1 ? "" : "s"}, ${running.length} running, ${stale.length} stale${stale.length > 0 ? `: ${stale.map((job) => job.id).join(", ")}` : ""}`;
  return stale.length > 0
    ? warn(
        "jobs",
        detail,
        "Run `agentmate jobs list`; stale jobs are marked as errors when read with `jobs result <id>`.",
      )
    : ok("jobs", detail);
}

async function checkLegacyClaude(claudeAvailable: boolean): Promise<Check> {
  const name = "legacy claude registration";
  if (!claudeAvailable) return ok(name, "skipped (claude not available)");
  const list = await run(binary("claude"), ["mcp", "list"], MCP_LIST_TIMEOUT_MS);
  if (list === null) return warn(name, "could not run `claude mcp list`", "Run it manually.");
  return /(?:agents-bridge-mcp|agentmate) serve codex/.test(list)
    ? warn(
        name,
        "the synchronous `serve codex` server is registered in Claude Code",
        "Remove it with `claude mcp remove codex` and install the plugin instead.",
      )
    : ok(name, "none");
}

function checkLegacyCodex(): Check {
  const name = "legacy codex registration";
  const config = path.join(
    process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"),
    "config.toml",
  );
  let text: string;
  try {
    text = fs.readFileSync(config, "utf8");
  } catch {
    return ok(name, "none");
  }
  return /(?:agents-bridge-mcp|agentmate)["',\s]+serve["',\s]+claude/.test(text)
    ? warn(
        name,
        `the synchronous \`serve claude\` server is registered in ${config}`,
        "Remove that [mcp_servers] entry and install the plugin instead.",
      )
    : ok(name, "none");
}

/** Never throws: every probe degrades to a warning. */
export async function collectChecks(): Promise<Check[]> {
  const [codex, claude] = await Promise.all([checkProvider("codex"), checkProvider("claude")]);
  return [
    checkNode(),
    codex,
    claude,
    checkStateDir(),
    checkJobs(),
    await checkLegacyClaude(claude.status === "ok"),
    checkLegacyCodex(),
  ];
}

export function renderChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => {
      const line = `${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`;
      return c.hint && c.status !== "ok"
        ? `${line}\n${" ".repeat(8 + width)}hint: ${c.hint}`
        : line;
    })
    .join("\n");
}

/** 1 when any check failed; warnings alone are fine. */
export const exitCodeFor = (checks: Check[]) => (checks.some((c) => c.status === "fail") ? 1 : 0);

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Check the installation: Node, codex and claude CLIs, job state, legacy setups",
  },
  run: userFacing(async () => {
    const checks = await collectChecks();
    console.log(renderChecks(checks));
    process.exitCode = exitCodeFor(checks);
  }),
});
