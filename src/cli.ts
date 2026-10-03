#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { VERSION } from "./lib/version.js";

const main = defineCommand({
  meta: {
    name: "agentmate",
    version: VERSION,
    description:
      "AgentMate: AI agents work better together. Lets Claude Code and Codex delegate, review and help each other.",
  },
  subCommands: {
    serve: () => import("./commands/serve.js").then((r) => r.default),
    install: () => import("./commands/install.js").then((r) => r.default),
    jobs: () => import("./commands/jobs.js").then((r) => r.default),
    sessions: () => import("./commands/sessions.js").then((r) => r.default),
    doctor: () => import("./commands/doctor.js").then((r) => r.default),
    worker: () => import("./commands/worker.js").then((r) => r.default),
  },
});

runMain(main);
