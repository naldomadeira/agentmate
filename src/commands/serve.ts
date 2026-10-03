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
        description:
          "Start the job-based MCP server (background delegation to codex, claude, gemini or agy)",
      },
      async run() {
        await import("../jobs-server.js");
      },
    }),
  },
});
