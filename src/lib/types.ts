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
  usage: {
    model?: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  } | null;
  errors: string[];
}

export interface ClaudeResult {
  resultText: string;
  sessionId: string | null;
  usage: {
    model?: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  } | null;
  errors: string[];
  /** `resultText` is the last assistant text of a stream that ended without a `result` event. */
  partial?: boolean;
}
