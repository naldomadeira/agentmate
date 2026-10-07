import type { Usage } from "../agents/types.js";

export interface ExecOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** Consulted before a transient retry; return false to hand the failed result back instead. */
  shouldRetry?: (result: ExecResult) => boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer | string) => void;
  onStderr?: (chunk: Buffer | string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted?: boolean;
}

export interface CodexResult {
  threadId: string | null;
  agentMessage: string;
  fileChanges: Array<{
    path: string;
    kind: string;
  }>;
  commandsExecuted: Array<{
    command: string;
    exitCode: number | null;
    output: string;
  }>;
  /** Effective model and token counts summed over turns; null when the stream reported none. */
  usage: Usage | null;
  errors: string[];
}

export interface ClaudeResult {
  resultText: string;
  sessionId: string | null;
  /** Effective model, tokens and cost; null when the stream reported none. */
  usage: Usage | null;
  errors: string[];
  /** `resultText` is the last assistant text of a stream that ended without a `result` event. */
  partial?: boolean;
}
