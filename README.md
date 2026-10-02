# agents-bridge-mcp

[![npm version](https://img.shields.io/npm/v/agents-bridge-mcp?color=f97316)](https://www.npmjs.com/package/agents-bridge-mcp)
[![npm downloads](https://img.shields.io/npm/dm/agents-bridge-mcp?color=3b82f6)](https://www.npmjs.com/package/agents-bridge-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Bidirectional [MCP](https://modelcontextprotocol.io/) server bridge between **Claude Code** and **OpenAI Codex CLI**.

Let Claude and Codex work as partners — each can ask the other for help, review code, explain logic, and plan performance improvements.

```
┌──────────────┐         MCP          ┌──────────────┐
│              │ ◄──────────────────► │              │
│  Claude Code │   agents-bridge      │  Codex CLI   │
│              │ ◄────── mcp ───────► │              │
└──────────────┘                      └──────────────┘
```

## Background jobs (recommended)

The synchronous tools below block the caller until the other CLI finishes, so long tasks hit client timeouts and
cannot be cancelled. The **jobs** server delegates instead: `bridge_start` returns a job id immediately, a detached
worker runs the task, and the job keeps going even if your session ends.

| Tool             | What it does                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bridge_start`   | Start a job on `codex` or `claude` (`read-only` by default, `write` opt-in). `continue` resumes a finished job's session |
| `bridge_wait`    | Block until done or the wait expires; expiring does not stop the job                                                     |
| `bridge_observe` | Non-blocking snapshot of status and recent output                                                                        |
| `bridge_result`  | Read the stored result                                                                                                   |
| `bridge_cancel`  | Stop a job, keeping partial output                                                                                       |
| `bridge_list`    | Recent jobs                                                                                                              |

```bash
claude mcp add bridge -s user -- npx agents-bridge-mcp serve jobs      # as MCP tools
npx agents-bridge-mcp jobs start codex "review the diff on this branch"   # or from the shell
npx agents-bridge-mcp jobs wait <id>                                      # exit 0 done · 1 failed · 2 still running
```

As a Claude Code plugin (adds the `delegate` skill and registers the MCP server):

```bash
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge
```

Jobs are stored under `~/.agents-bridge/jobs/<id>/` (override with `AGENTS_BRIDGE_HOME`). A job has a 60 minute
deadline by default (max 120). `AGENTS_BRIDGE_CODEX_BIN` / `AGENTS_BRIDGE_CLAUDE_BIN` point at alternative executables.

> Claude jobs return their result at the end only (`--output-format json`), so `observe` shows less for them than for Codex.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — installed and authenticated
- [Codex CLI](https://developers.openai.com/codex/cli/) — installed and authenticated
- [Node.js](https://nodejs.org) >= 18

## Quick Start

Set up everything with a single command:

```bash
npx agents-bridge-mcp setup
```

This registers MCP servers for both Claude Code and Codex, and installs the `/codex` skill and codex-teammate agent.

## Setup

### Automatic (recommended)

```bash
npx agents-bridge-mcp setup              # Full setup: both directions + skill + agent
npx agents-bridge-mcp setup claude       # Only Claude Code → Codex
npx agents-bridge-mcp setup codex        # Only Codex → Claude
npx agents-bridge-mcp setup --skip-extras  # MCP servers only, no skill/agent
```

Use `--global` or `--local` to control where the skill and agent are installed (defaults to interactive prompt).

### Manual

<details>
<summary><strong>Claude Code → Codex</strong> (let Claude call Codex)</summary>

Add to your Claude Code MCP config:

```bash
claude mcp add codex -s user -- npx agents-bridge-mcp serve codex
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "codex": {
      "type": "stdio",
      "command": "npx",
      "args": ["agents-bridge-mcp", "serve", "codex"]
    }
  }
}
```

</details>

<details>
<summary><strong>Codex → Claude</strong> (let Codex call Claude)</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.claude]
command = "npx"
args = ["agents-bridge-mcp", "serve", "claude"]
tool_timeout_sec = 600
```

</details>

## Usage

Once set up, just talk to Claude Code or Codex naturally. The bridge tools are picked up automatically.

### In Claude Code — ask Codex for help

```
> Ask Codex to review my recent changes

> Get Codex's opinion on whether this approach is correct: [paste plan]

> Have Codex explain how the parser in src/lib/codex-output-parser.ts works

> Ask Codex to analyze performance bottlenecks in the exec runner

> Ask Codex to implement error handling for the retry logic
```

### In Codex — ask Claude for help

```
> Ask Claude to review the changes in HEAD~3..HEAD

> Have Claude explain the architecture of this project

> Ask Claude to critique my plan for adding caching
```

### Using the `/codex` slash command (Claude Code)

Install the skill to get the `/codex` shortcut in Claude Code:

```bash
npx agents-bridge-mcp install skill claude --global    # or --local
```

Then use it:

```
/codex review my recent changes
/codex explain src/lib/exec-runner.ts
/codex is my approach to caching correct?
/codex optimize the output parser for memory usage
```

### Using the `/claude` slash command (Codex)

Install the skill to get the `/claude` shortcut in Codex:

```bash
npx agents-bridge-mcp install skill codex --global    # or --local
```

Then use it:

```
/claude review my recent changes
/claude explain the architecture of this project
/claude critique my plan for adding caching
```

### Spawning Codex as a teammate

For parallel work, spawn Codex as a subagent from Claude Code:

```
> Spawn a codex-teammate to review src/lib/exec-runner.ts while we keep working
```

## Tools

### `abm-codex` — Claude calls Codex

| Tool                 | Description                                      |
| -------------------- | ------------------------------------------------ |
| `codex_query`        | Ask Codex a question or give it a task           |
| `codex_review_code`  | Ask Codex to review code changes                 |
| `codex_review_plan`  | Ask Codex to critique an implementation plan     |
| `codex_explain_code` | Ask Codex to explain code / logic / architecture |
| `codex_plan_perf`    | Ask Codex to plan performance improvements       |
| `codex_implement`    | Ask Codex to write or modify code                |

### `abm-claude` — Codex calls Claude

| Tool                  | Description                                       |
| --------------------- | ------------------------------------------------- |
| `claude_query`        | Ask Claude a question or give it a task           |
| `claude_review_code`  | Ask Claude to review code changes                 |
| `claude_review_plan`  | Ask Claude to critique an implementation plan     |
| `claude_explain_code` | Ask Claude to explain code / logic / architecture |
| `claude_plan_perf`    | Ask Claude to plan performance improvements       |
| `claude_implement`    | Ask Claude to write or modify code                |

## Codex Teammate Agent

You can spawn Codex as a **Claude Code teammate** — a subagent that automatically uses the bridge tools to give you a second opinion, review code, or work on tasks in parallel.

### Install the Agent

```bash
npx agents-bridge-mcp install agent --global    # or --local
```

### Usage

Once installed, spawn the teammate from Claude Code using the Task tool:

```
# Code review
Task(subagent_type: "codex-teammate", prompt: "Review src/lib/exec-runner.ts for bugs and performance issues")

# Explain unfamiliar code
Task(subagent_type: "codex-teammate", prompt: "Explain the architecture of the MCP server in codex-server.ts")

# Critique a plan
Task(subagent_type: "codex-teammate", prompt: "Critique this plan: [your plan here]")

# Performance analysis
Task(subagent_type: "codex-teammate", prompt: "Analyze performance bottlenecks in the output parser")

# General question
Task(subagent_type: "codex-teammate", prompt: "What's the best approach for adding retry logic to the bridge?")
```

The agent automatically picks the right Codex tool (`codex_review_code`, `codex_explain_code`, `codex_plan_perf`, etc.) based on your request.

## Configuration

| Variable             | Description                                                  | Default           |
| -------------------- | ------------------------------------------------------------ | ----------------- |
| `BRIDGE_TIMEOUT_MS`  | Subprocess timeout in milliseconds                           | `600000` (10 min) |
| `BRIDGE_MAX_RETRIES` | Auto-retries on transient errors (rate limits, 5xx, network) | `2`               |
| `BRIDGE_DEBUG`       | Enable debug logging to stderr                               | —                 |
| `BRIDGE_DEPTH`       | Current recursion depth (set automatically)                  | `0`               |

### Anti-Recursion Guard

The bridge automatically prevents infinite loops. If Claude calls Codex which tries to call Claude again, the second call is blocked (`BRIDGE_DEPTH >= 2`).

## Development

```bash
git clone https://github.com/naldomadeira/agents-bridge-mcp.git
cd agents-bridge-mcp
pnpm install

pnpm build         # Compile to dist/
pnpm test          # Run tests
pnpm lint          # Lint and type check

# Dev mode (no build needed)
pnpm dev:codex-server
pnpm dev:claude-server
```

## License

[MIT](./LICENSE)
