import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter, AgentId } from "./types.js";

export const AGENTS: Record<AgentId, AgentAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
};

/** Tuple form, for zod enums and CLI validation. */
export const AGENT_IDS = ["codex", "claude"] as const satisfies readonly AgentId[];

export const getAgent = (id: AgentId): AgentAdapter => AGENTS[id];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && Object.hasOwn(AGENTS, value);
}

/** The agent a team lead delegates to. With two agents it is the other one; Phase 3 refines this. */
export function otherAgent(id: AgentId): AgentId {
  const other = AGENT_IDS.find((candidate) => candidate !== id);
  if (!other) throw new Error(`No agent other than ${id} is registered. Run \`agentmate doctor\`.`);
  return other;
}
