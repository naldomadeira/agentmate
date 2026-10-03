import type { Job } from "../jobs/store.js";

export type AgentId = "codex" | "claude" | "gemini";

export interface AgentCapabilities {
  /** Supports `write` mode. */
  write: boolean;
  /** Can search the web while read-only. */
  web: boolean;
  /** Can continue a previous session. */
  resume: boolean;
  /** Emits events while it runs (`jsonl`) or only at the end (`none`). */
  streaming: "jsonl" | "none";
}

export interface Invocation {
  command: string;
  args: string[];
}

export interface Outcome {
  text: string;
  sessionId: string | null;
  errors: string[];
  /** `text` is what a stream printed before it ended without a final result. */
  partial?: boolean;
}

export type EventLevel = "important" | "status" | "fyi";

export interface JobEvent {
  /** ISO timestamp. */
  ts: string;
  job: string;
  level: EventLevel;
  kind: "queued" | "started" | "message" | "file" | "command" | "finished" | "error";
  /** One readable line, truncated at 500 characters. */
  text: string;
  /** For example `{ path, kind }` or `{ command, exitCode }`. */
  data?: Record<string, unknown>;
}

/** How the runtime talks to one agent CLI; the runtime holds no per-agent branching outside adapters. */
export interface AgentAdapter {
  id: AgentId;
  /** Human name, such as "Codex CLI". */
  displayName: string;
  /** Honors `AGENTMATE_<ID>_BIN`. */
  binary(): string;
  capabilities: AgentCapabilities;
  buildInvocation(job: Job, resumeSessionId?: string): Invocation;
  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome;
  /** Turns one stdout line into filtered events; `job` is left empty for the worker to fill. */
  parseStreamLine?(line: string): JobEvent[];
  /** Arguments that make the CLI print its version, for the doctor. */
  versionArgs: string[];
}
