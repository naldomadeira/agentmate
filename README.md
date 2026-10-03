# Agents Bridge

[![npm version](https://img.shields.io/npm/v/agents-bridge-mcp?color=f97316)](https://www.npmjs.com/package/agents-bridge-mcp)
[![npm downloads](https://img.shields.io/npm/dm/agents-bridge-mcp?color=3b82f6)](https://www.npmjs.com/package/agents-bridge-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[Português (Brasil)](./docs/README.pt-BR.md)

Delegate focused work between [Claude Code](https://code.claude.com/) and the [Codex CLI](https://developers.openai.com/codex/cli/) without blocking the session that started it. Agents Bridge ships a shared skill, an MCP jobs server, and a CLI fallback.

![Two developer environments connected by a secure bridge.](./assets/illustrations/cli-bridge.png)

## Install

Install the plugin in the host you use. The plugin adds the `delegate` skill and the jobs MCP server; it does not require manual edits to host configuration files.

### Claude Code

```bash
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge
```

### Codex

```bash
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Restart the host after installation. See the [installation guide](./docs/INSTALL_FOR_AGENTS.md) for upgrades, a local-development install, diagnostics, and migration from legacy `setup` installs.

## How it works

Agents Bridge treats delegated work as a durable background job:

1. Start a task on `codex` or `claude`; `bridge_start` returns a job ID immediately.
2. Wait for that ID, collect its result, or request progress when a person asks for it.
3. Use the stored result to decide the next step. Jobs survive the caller session ending.

![A task moves through a queue, worker, and returned result.](./assets/illustrations/background-jobs.png)

| Capability           | MCP                            | CLI fallback                                                |
| -------------------- | ------------------------------ | ----------------------------------------------------------- |
| Start work           | `bridge_start`                 | `npx -y agents-bridge-mcp jobs start <provider> "<prompt>"` |
| Wait or fetch output | `bridge_wait`, `bridge_result` | `jobs wait <id>`, `jobs result <id>`                        |
| Request progress     | `bridge_observe`               | `jobs observe <id>`                                         |
| Cancel work          | `bridge_cancel`                | `jobs cancel <id>`                                          |

The skill prefers `bridge_*` tools when they are available. If the host did not load MCP, it uses the same job contract through `npx -y agents-bridge-mcp`; it never changes a user's host configuration as a fallback.

## A safe first task

Start with a read-only request. For example, ask the other CLI to review the current diff or explain a module. Jobs default to `read-only`; select `write` only when the task explicitly authorizes edits.

```bash
npx -y agents-bridge-mcp jobs start codex "Review the current diff. Report only actionable findings."
npx -y agents-bridge-mcp jobs wait <id>
```

`wait` exits with `0` for a completed job, `1` for a failed or canceled job, and `2` when the wait expires while work is still running. A timed-out wait does not cancel the job.

## Requirements

- Node.js 18 or later
- Claude Code and/or Codex CLI, authenticated
- The destination CLI available on the initiating host's `PATH`

## Legacy setup

`npx -y agents-bridge-mcp setup` remains available for existing installations that use the synchronous bridge servers or the `/codex` and `/claude` shortcuts. New installations should use the plugin. The [installation guide](./docs/INSTALL_FOR_AGENTS.md#move-from-a-legacy-setup-install) explains how to remove only the legacy entries that belong to Agents Bridge.

## Development

```bash
git clone https://github.com/naldomadeira/agents-bridge-mcp.git
cd agents-bridge-mcp
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

[MIT](./LICENSE)
