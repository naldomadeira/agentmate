import { defineCommand } from "citty";
import {
  installClaudeAgent,
  installClaudeCommands,
  installClaudeSkill,
  installCodexPrompts,
  installCodexSkill,
  promptScope,
  resolveScope,
} from "../lib/installer.js";

export default defineCommand({
  meta: {
    name: "install",
    description: "Install skills, agents and slash commands",
  },
  subCommands: {
    skill: defineCommand({
      meta: { name: "skill", description: "Install an AgentMate skill" },
      args: {
        target: {
          type: "positional",
          description:
            "Target platform: claude (installs /codex skill) or codex (installs /claude skill)",
          required: false,
        },
        global: { type: "boolean", description: "Install globally" },
        local: { type: "boolean", description: "Install locally to current project" },
      },
      async run({ args }) {
        const target = args.target ?? "claude";
        const scope = resolveScope(args.global, args.local) ?? (await promptScope());

        if (target === "claude") {
          console.log("Installing /codex skill for Claude Code...");
          await installClaudeSkill(scope);
        } else if (target === "codex") {
          console.log("Installing /claude skill for Codex...");
          await installCodexSkill(scope);
        } else {
          console.error(`Unknown target: ${target}. Use "claude" or "codex".`);
          process.exit(1);
        }
      },
    }),
    agent: defineCommand({
      meta: { name: "agent", description: "Install the codex-teammate agent for Claude Code" },
      args: {
        global: { type: "boolean", description: "Install globally to ~/.claude/agents/" },
        local: { type: "boolean", description: "Install locally to .claude/agents/" },
      },
      async run({ args }) {
        const scope = resolveScope(args.global, args.local) ?? (await promptScope());
        console.log("Installing codex-teammate agent for Claude Code...");
        await installClaudeAgent(scope);
      },
    }),
    commands: defineCommand({
      meta: {
        name: "commands",
        description:
          "Install slash commands: bare /ask for Claude Code, /prompts:ask for Codex (both by default)",
      },
      args: {
        target: {
          type: "positional",
          description: "Host: claude, codex or both (default)",
          required: false,
        },
        global: {
          type: "boolean",
          description: "Install globally (~/.claude/commands/, $CODEX_HOME/prompts/)",
        },
        local: {
          type: "boolean",
          description: "Install to .claude/commands/ in the current project (Claude Code only)",
        },
      },
      async run({ args }) {
        const target = args.target ?? "both";
        if (target !== "claude" && target !== "codex" && target !== "both") {
          console.error(`Unknown target: ${target}. Use "claude", "codex" or "both".`);
          process.exit(1);
        }
        // Codex custom prompts are user-level only, so a codex-only install has no scope to ask for.
        const scope =
          resolveScope(args.global, args.local) ??
          (target === "codex" ? "global" : await promptScope());

        const installed: string[] = [];
        if (target === "claude" || target === "both") {
          console.log("Installing slash commands for Claude Code...");
          installed.push(...(await installClaudeCommands(scope)));
        }
        if (target === "codex" || target === "both") {
          console.log("Installing custom prompts for Codex...");
          installed.push(...(await installCodexPrompts(scope)));
        }

        if (installed.length > 0) {
          console.log(`\nInstalled commands: ${installed.join(", ")}`);
          console.log("Restart the host to load them.");
        } else {
          console.log("\nNo commands installed.");
        }
      },
    }),
  },
});
