---
name: setup
description: Legacy setup for agentmate. Prefer the plugin install; use this only to maintain an existing synchronous-server installation.
argument-hint: "[both|claude|codex]"
allowed-tools: "Read, Edit, Write, Bash, Glob, Grep"
---

AgentMate is installed as a plugin. This `setup` skill is **legacy**: it registers the old synchronous MCP servers (`serve codex`, `serve claude`) and copies shortcuts into the user's configuration. Use it only for an existing installation that already depends on them.

## Recommended: install the plugin

Tell the user to install the plugin in the host they use. It adds the `ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `jobs`, `delegate`, `codex` and `claude` skills, the four Codex agents (Claude Code) and the jobs MCP server, with no manual edits to configuration files.

```bash
# Claude Code
claude plugin marketplace add naldomadeira/agentmate
claude plugin install mate@agentmate

# Codex
codex plugin marketplace add naldomadeira/agentmate
codex plugin add mate@agentmate
```

Restart the host, then verify with `npx -y agentmate doctor`. Full guide: `docs/INSTALL_FOR_AGENTS.md`.

## Legacy: Claude Code -> Codex (synchronous server)

The user may pass `both` (default), `claude` or `codex`. Only continue if the user explicitly wants the legacy servers.

```bash
claude mcp add codex -s user -- npx agentmate serve codex
claude mcp list
```

Confirm that `codex` appears in the list.

## Legacy: Codex -> Claude (synchronous server)

1. Check whether `~/.codex/config.toml` exists. If not, create the directory and file.
2. Read the existing content. Add this block only if `[mcp_servers.claude]` is not already present; if it is, ask the user before changing it.

```toml
[mcp_servers.claude]
command = "npx"
args = ["agentmate", "serve", "claude"]
tool_timeout_sec = 600
```

## Legacy: copy the skills and agent

```bash
npx agentmate install skill claude --global   # /codex skill for Claude Code
npx agentmate install skill codex --global    # /claude skill for Codex
npx agentmate install agent --global          # codex-teammate agent (--local for this project)
```

These shortcuts route to the `mate_*` job tools, which come from the jobs server (`npx -y agentmate serve jobs`) that the plugin registers. Without the plugin, they fall back to the `npx -y agentmate jobs ...` CLI.

## After setup

Tell the user to restart the host and run `npx -y agentmate doctor`; it flags legacy registrations and suggests how to move to the plugin. The legacy servers expose `codex_query`, `codex_review_code`, `codex_review_plan`, `codex_explain_code`, `codex_plan_perf` and `codex_implement` (to Claude) and the matching `claude_*` tools (to Codex).
