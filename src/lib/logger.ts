// All logging goes to stderr — stdout is the MCP JSON-RPC channel.

const isDebug = !!process.env["AGENTMATE_DEBUG"];

type LogLevel = "info" | "warning" | "error" | "debug";

function log(level: LogLevel, msg: string, ...args: unknown[]): void {
  const prefix = `[${level.toUpperCase()}]`;
  console.error(`${prefix} ${msg}`, ...args);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const logger = {
  info(msg: string, ...args: unknown[]) {
    log("info", msg, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    log("warning", msg, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    log("error", msg, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (isDebug) log("debug", msg, ...args);
  },
};
