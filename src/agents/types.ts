import type { Job } from "../jobs/store.js";

export type AgentId = "codex" | "claude" | "gemini" | "agy";

export interface AgentCapabilities {
  /** Supports `write` mode. */
  write: boolean;
  /** Can search the web while read-only. */
  web: boolean;
  /**
   * Can continue a previous session. `false` also covers "not verified": `startJob` refuses
   * `continueJob` for such an agent instead of passing an untested flag.
   */
  resume: boolean;
  /**
   * Can run shell commands (such as `git diff`) headless. A reviewer without it gets the diff inline
   * in its briefing, and an implementer without it cannot run the repository's verification.
   */
  shell: boolean;
  /** Emits events while it runs (`jsonl`) or only at the end (`none`). */
  streaming: "jsonl" | "none";
}

export interface Invocation {
  command: string;
  args: string[];
}

export interface Usage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface Outcome {
  text: string;
  sessionId: string | null;
  errors: string[];
  /** `text` is what a stream printed before it ended without a final result. */
  partial?: boolean;
  usage?: Usage;
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
  /**
   * A team lead must delegate through the shell, which this agent runs headless only in write mode;
   * `startJob` refuses a read-only team lead on it with `teamleadWriteReason`.
   */
  teamleadNeedsWrite: boolean;
  /** The error for a read-only team lead on an agent with `teamleadNeedsWrite`. */
  teamleadWriteReason?: string;
  /**
   * Why this agent cannot honor `job.effort` (with `job.model`), or null when it can. Called by
   * `startJob` before anything is spawned, so an effort is never dropped in silence. An adapter
   * without it refuses every effort.
   */
  effortError?(job: Pick<Job, "effort" | "model">): string | null;
  /** Extra environment variables the agent CLI needs for this job. */
  env?(job: Job): Record<string, string> | undefined;
  buildInvocation(job: Job, resumeSessionId?: string): Invocation;
  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome;
  /** Turns one stdout line into filtered events; `job` is left empty for the worker to fill. */
  parseStreamLine?(line: string): JobEvent[];
  /** Clears any state kept between `parseStreamLine` calls; the worker runs one job, so tests use it. */
  resetStream?(): void;
  /** Arguments that make the CLI print its version, for the doctor. */
  versionArgs: string[];
}
