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
 * The default partner of an agent in a workflow: codex and claude pair with each other and gemini
 * pairs with claude. Pass `partner` to a workflow to choose another.
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

/** Whether `binary` is an existing file, as a path or as a name found in a `PATH` directory. No process is spawned. */
function binaryExists(binary: string): boolean {
  if (!binary) return false;
  if (binary.includes("/") || binary.includes(path.sep)) return isFile(path.resolve(binary));
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) if (isFile(path.join(dir, binary + extension))) return true;
  }
  return false;
}

/** True when the agent's CLI (`AGENTMATE_<ID>_BIN` or its default name) can be found. */
export function isAgentAvailable(id: AgentId): boolean {
  return binaryExists(getAgent(id).binary());
}

/** The installed agents, in registry order. */
export function availableAgents(): AgentId[] {
  return AGENT_IDS.filter(isAgentAvailable);
}

/** Throws the actionable error for an agent whose CLI is missing; returns when it is installed. */
export function assertAgentAvailable(id: AgentId): void {
  if (isAgentAvailable(id)) return;
  throw new Error(
    `Agent ${id} is not installed (binary "${getAgent(id).binary()}" not found on PATH). Install it or set AGENTMATE_${id.toUpperCase()}_BIN.`,
  );
}
