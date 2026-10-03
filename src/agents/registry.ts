import fs from "node:fs";
import path from "node:path";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import type { AgentAdapter, AgentId } from "./types.js";

export const AGENTS: Record<AgentId, AgentAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
};

/** Tuple form, for zod enums and CLI validation. */
export const AGENT_IDS = ["codex", "claude", "gemini"] as const satisfies readonly AgentId[];

export const getAgent = (id: AgentId): AgentAdapter => AGENTS[id];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && Object.hasOwn(AGENTS, value);
}

/**
 * The static default partner of an agent: codex and claude pair with each other and gemini pairs
 * with claude. It does not look at what is installed; workflows use `firstAvailableOther`.
 */
export function otherAgent(id: AgentId): AgentId {
  return id === "claude" ? "codex" : "claude";
}

const isFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * `spawn` runs the binary without a shell, so on Windows only a file with no extension or a `.exe`
 * can start; `.cmd` and `.bat` shims would fail at spawn time and are not accepted.
 */
const WINDOWS_EXTENSIONS = ["", ".exe"] as const;

const hasSeparator = (binary: string): boolean => binary.includes("/") || binary.includes(path.sep);

/** Whether `binary` is an existing file, as a path (relative to `cwd`) or as a name found in a `PATH` directory. No process is spawned. */
function binaryExists(binary: string, cwd: string): boolean {
  if (!binary) return false;
  if (hasSeparator(binary)) return isFile(path.resolve(cwd, binary));
  const extensions = process.platform === "win32" ? WINDOWS_EXTENSIONS : [""];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) if (isFile(path.join(dir, binary + extension))) return true;
  }
  return false;
}

/**
 * The command to spawn for `binary` in a job that runs in `cwd`. A path with a separator that is
 * relative (`./bin/codex`) is resolved against `cwd`; a bare name is left to the `PATH` lookup.
 * `isAgentAvailable` takes the same `cwd`, so the check and the spawn look at the same file.
 */
export function resolveBinary(binary: string, cwd: string): string {
  return hasSeparator(binary) && !path.isAbsolute(binary) ? path.resolve(cwd, binary) : binary;
}

/**
 * True when the agent's CLI (`AGENTMATE_<ID>_BIN` or its default name) can be found. A relative
 * `AGENTMATE_<ID>_BIN` path is resolved against `cwd`, which defaults to `process.cwd()`;
 * `startJob` passes the job's cwd, the directory the worker spawns the CLI in.
 */
export function isAgentAvailable(id: AgentId, cwd: string = process.cwd()): boolean {
  return binaryExists(getAgent(id).binary(), cwd);
}

/** The installed agents, in registry order. */
export function availableAgents(cwd?: string): AgentId[] {
  return AGENT_IDS.filter((id) => isAgentAvailable(id, cwd));
}

/**
 * The first installed agent, in registry order, that differs from `id` (and is in `among` when given),
 * or undefined when there is none.
 */
export function installedOther(
  id: AgentId,
  among: readonly AgentId[] = AGENT_IDS,
  cwd?: string,
): AgentId | undefined {
  return AGENT_IDS.find(
    (candidate) =>
      candidate !== id && among.includes(candidate) && isAgentAvailable(candidate, cwd),
  );
}

/**
 * The default partner of `id` in a workflow: the first installed agent, in registry order, that
 * differs from it, else the static pairing `otherAgent(id)` (which `assertAgentAvailable` then
 * rejects with the install message).
 */
export function firstAvailableOther(id: AgentId, cwd?: string): AgentId {
  return installedOther(id, AGENT_IDS, cwd) ?? otherAgent(id);
}

/** Throws the actionable error for an agent whose CLI is missing; returns when it is installed. */
export function assertAgentAvailable(id: AgentId, cwd?: string): void {
  if (isAgentAvailable(id, cwd)) return;
  throw new Error(
    `Agent ${id} is not installed (binary "${getAgent(id).binary()}" not found on PATH). Install it or set AGENTMATE_${id.toUpperCase()}_BIN.`,
  );
}
