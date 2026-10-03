/** Printed to stderr by the legacy synchronous servers and `setup`; 0.5.0 warns, 0.6.0 removes them. */
export const LEGACY_DEPRECATION_NOTICE =
  "Deprecated: the synchronous servers (serve codex, serve claude) and setup are removed in 0.6.0; install the plugin (mate@agentmate) and use the mate_* job tools instead.";

/** One stderr line, so it never mixes with an MCP stdio stream on stdout. */
export function warnLegacyDeprecated(): void {
  console.error(LEGACY_DEPRECATION_NOTICE);
}
