import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "serve",
    description: "Start an MCP server",
  },
  subCommands: {
    jobs: defineCommand({
      meta: {
        name: "jobs",
        description: "Start the job-based MCP server (background delegation to codex or claude)",
      },
      async run() {
        await import("../jobs-server.js");
      },
    }),
    codex: defineCommand({
      meta: { name: "codex", description: "Start the Codex MCP server (for Claude Code)" },
      async run() {
        await import("../codex-server.js");
      },
    }),
    claude: defineCommand({
      meta: { name: "claude", description: "Start the Claude MCP server (for Codex CLI)" },
      async run() {
        await import("../claude-server.js");
      },
    }),
  },
});
