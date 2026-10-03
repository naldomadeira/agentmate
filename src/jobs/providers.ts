import { getAgent } from "../agents/registry.js";
import type { Job, Provider } from "./store.js";

export type { Invocation, Outcome } from "../agents/types.js";
import type { Invocation, Outcome } from "../agents/types.js";

/** Compatibility facade over the agent registry; new code should use `getAgent` directly. */

/** `AGENTMATE_CODEX_BIN` / `AGENTMATE_CLAUDE_BIN` point at an alternative executable. */
export function binary(provider: Provider): string {
  return getAgent(provider).binary();
}

export function buildInvocation(job: Job, resumeSessionId?: string): Invocation {
  return getAgent(job.provider).buildInvocation(job, resumeSessionId);
}

export function parseOutcome(
  provider: Provider,
  stdout: string,
  stderr: string,
  exitCode: number,
): Outcome {
  return getAgent(provider).parseOutcome(stdout, stderr, exitCode);
}
