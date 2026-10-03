#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { VERSION } from "./lib/version.js";

const main = defineCommand({
  meta: {
    name: "agents-bridge-mcp",
    version: VERSION,
    description: "Bidirectional MCP bridge between Claude Code and Codex CLI",
  },
  subCommands: {
    serve: () => import("./commands/serve.js").then((r) => r.default),
    setup: () => import("./commands/setup.js").then((r) => r.default),
    install: () => import("./commands/install.js").then((r) => r.default),
    jobs: () => import("./commands/jobs.js").then((r) => r.default),
    doctor: () => import("./commands/doctor.js").then((r) => r.default),
    worker: () => import("./commands/worker.js").then((r) => r.default),
  },
});

runMain(main);
