export type BridgeErrorCode =
  | "CLI_NOT_FOUND"
  | "API_KEY_MISSING"
  | "TIMEOUT"
  | "PARSE_ERROR"
  | "PROCESS_ERROR"
  | "RECURSION_LIMIT";

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code: BridgeErrorCode,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/**
 * Wraps a CLI command's `run` so a thrown Error prints as a single `Error: <message>` line on
 * stderr with exit code 1, instead of citty's stack trace. Non-Error throws propagate unchanged.
 */
export function userFacing<Args extends unknown[]>(
  run: (...args: Args) => unknown,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    try {
      await run(...args);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    }
  };
}
