# AgentMate

[![npm version](https://img.shields.io/npm/v/agentmate?color=f97316)](https://www.npmjs.com/package/agentmate)
[![npm downloads](https://img.shields.io/npm/dm/agentmate?color=3b82f6)](https://www.npmjs.com/package/agentmate)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[Português (Brasil)](./docs/README.pt-BR.md)

**AI agents work better together.**

AgentMate connects AI coding agents so they can collaborate, delegate, review, and help each other complete tasks. Give your AI agent a teammate: let [Claude Code](https://code.claude.com/) and the [Codex CLI](https://developers.openai.com/codex/cli/) ask, review, research, plan, implement and lead each other as background jobs.

![Two developer environments connected by a secure bridge.](./assets/illustrations/cli-bridge.png)

## Why AgentMate

- **A second opinion from a different model.** Ask the other CLI a question, or have it review your diff, before you commit to an approach. It reads your repository; it does not share your session's assumptions.
- **Work that does not block you.** Every task is a durable background job with an id. The session that started it can end, and the result is still there.
- **Roles instead of raw prompts.** `ask`, `review`, `research`, `plan`, `implement` and `teamlead` each send a tuned prompt with a defined output format, and each runs with the narrowest permissions that role needs. Jobs are read-only unless you say otherwise.

## 60-second quickstart

### Install

Install the plugin in the host you use (or both), then restart the host.

```bash
# Claude Code
claude plugin marketplace add naldomadeira/agentmate
claude plugin install mate@agentmate

# Codex
codex plugin marketplace add naldomadeira/agentmate
codex plugin add mate@agentmate
```

The marketplace is named `agentmate` and the plugin is named `mate`, so the install id is `mate@agentmate` and every command starts with `mate:`.

> **Migrating from Agents Bridge (0.3.0 or earlier)?** The project was renamed to AgentMate: the npm package is now `agentmate`, the plugin `mate`, the tools `mate_*`, the state directory `~/.agentmate` and the environment variables `AGENTMATE_*`.
> Remove the old plugin (`claude plugin uninstall bridge@agents-bridge`, or `agents-bridge@agents-bridge` from 0.2.0) and the old marketplace (`claude plugin marketplace remove agents-bridge`); in Codex, remove both with `codex plugin --help` for the exact verbs.
> Then install `mate@agentmate` as above and restart the host. Jobs in `~/.agents-bridge` are not migrated.

### Invoke a role

Type `/mate:` in Claude Code to see every role; in Codex type `$mate` or open `/skills`. Both hosts take the provider first, then the request:

```text
/mate:ask codex Is it safe to call this migration twice? See db/migrate/0042.sql
$mate:ask claude Does this retry loop in src/queue.ts have a race?
```

Want shorter commands (`/ask`, `/prompts:ask`)? See [Slash commands](#slash-commands). More examples are in [Use cases](#use-cases).

### Check the installation

```bash
npx -y agentmate doctor
```

`doctor` verifies Node.js, that the `codex` and `claude` CLIs are on your `PATH` and respond to `--version`, the job state directory, stale `running` jobs (it lists their ids) and legacy registrations, and prints a fix for each problem. It does not check authentication: if a job fails right away, log in to the destination CLI yourself. See the [installation guide](./docs/INSTALL_FOR_AGENTS.md) for upgrades, a local-development install and migration from legacy `setup` installs.

### For agents

Paste this into any coding agent:

```text
Read the raw text of https://raw.githubusercontent.com/naldomadeira/agentmate/main/docs/INSTALL_FOR_AGENTS.md
(curl it - do not work from a summary) and follow it to install and verify the AgentMate plugin
for the host you are running in. Respond in the user's language.
```

### Upgrade

Claude Code and Codex install a copy of the plugin, so a new version only reaches you when you pull it in:

```bash
claude plugin marketplace update agentmate && claude plugin update mate@agentmate
```

```bash
codex plugin marketplace upgrade agentmate && codex plugin add mate@agentmate
```

Hosts cache the plugin per version, so restart Claude Code or Codex afterwards. A fix only lands if the plugin version changed.

## Use cases

Examples use Claude Code's `/mate:...`; in Codex use `$mate:...`. The provider (`codex` or `claude`) comes first; pick the one that is not your host.

| Use case                | Invocation                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Quick second opinion    | `/mate:ask codex Is this migration idempotent?`                                   |
| Review the working tree | `/mate:review codex Review the current working tree`                              |
| Review a PR or diff     | `/mate:review codex Review PR #730, focus on error handling`                      |
| Challenge a plan        | `/mate:plan codex critique the migration plan in docs/plan.md`                    |
| Research a topic        | `/mate:research claude How does auth work in this repo? Compare the options.`     |
| Implement a scoped fix  | `/mate:implement codex Fix the flaky retry test in test/queue.test.ts`            |
| Run a team lead         | `/mate:teamlead claude Audit error handling and propose fixes; delegate to codex` |
| Job ops                 | `/mate:jobs list`, `/mate:jobs result <id>`, `/mate:jobs cancel <id>`         |

`implement` edits files, so use it only when you authorize that. The others are read-only.

## What you can do

Six roles, each reachable as a skill, an MCP tool and a CLI command. `<provider>` is `codex` or `claude`; pick the one that is not the host you are in.

| Role        | Skill       | MCP tool           | CLI                                                 | Mode                               |
| ----------- | ----------- | ------------------ | --------------------------------------------------- | ---------------------------------- |
| `ask`       | `ask`       | `mate_ask`       | `jobs ask <provider> "<question>"`                  | read-only                          |
| `review`    | `review`    | `mate_review`    | `jobs start <provider> "<prompt>" --role review`    | read-only                          |
| `research`  | `research`  | `mate_research`  | `jobs start <provider> "<prompt>" --role research`  | read-only (Claude adds web access) |
| `plan`      | `plan`      | `mate_plan`      | `jobs start <provider> "<prompt>" --role plan`      | read-only                          |
| `implement` | `implement` | `mate_implement` | `jobs start <provider> "<prompt>" --role implement` | write (always)                     |
| `teamlead`  | `teamlead`  | `mate_teamlead`  | `jobs start <provider> "<prompt>" --role teamlead`  | read-only by default, write opt-in |

`mate_ask` waits for the answer (up to 120 seconds by default) and returns it in the same call. The other role tools return a job id immediately unless you pass `waitSeconds`.

Codex limits an MCP tool call to about 60 seconds by default. When you run inside Codex, pass `waitSeconds: 45` to `mate_ask` and continue with `mate_wait` if the answer has not arrived.

Four more skills cover the rest:

- `jobs` lists, observes, collects and cancels jobs.
- `delegate` is the generic path (`mate_start`) for work that fits no role.
- `codex` and `claude` are shortcuts that route a plain request to the right role with the provider already set.

In Claude Code the plugin also adds four agents that wrap Codex: `codex-teammate` (questions and general delegation), `codex-reviewer`, `codex-researcher` and `codex-teamlead`. They brief Codex, verify what it returns and report their own conclusion instead of forwarding raw output.

Every command in the table works without MCP. Prefix CLI commands with `npx -y agentmate`.

## Slash commands

Seven roles (`ask`, `review`, `research`, `plan`, `implement`, `teamlead` and `jobs`) can be started as a command in either host. Both hosts take the provider first, then the request.

| Host and style     | How to invoke                    | How to get it                                                             |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------- |
| Claude Code plugin | `/mate:ask codex <question>`   | Installed with the plugin.                                                |
| Claude Code bare   | `/ask codex <question>`          | `npx -y agentmate install commands claude --global`               |
| Codex skill        | `$mate:ask claude <question>`  | Installed with the plugin; or pick "Mate: Ask" from the `/skills` menu. |
| Codex slash        | `/prompts:ask claude <question>` | `npx -y agentmate install commands codex`, then restart Codex.    |

The plugin forms (`/mate:ask`, `$mate:ask`) need no extra install. The bare `/ask` and `/prompts:ask` rows are optional extras. Why two steps: Claude Code always prefixes plugin skills with the plugin name, so a bare `/ask` needs a user-level command file. Codex plugins can ship skills but not slash commands, so `/prompts:<name>` comes from a custom prompt file in `$CODEX_HOME/prompts/` (default `~/.codex/prompts/`).

`npx -y agentmate install commands [claude|codex|both] [--global|--local]` copies the templates from the package (`templates/claude-commands/` and `templates/codex-prompts/`) and prints the command names it installed. The default target is `both`. It asks before overwriting an existing file. `--local` installs the Claude Code commands to `./.claude/commands/`; Codex custom prompts are user-level only, so they are always installed globally.

> **Codex custom prompts are deprecated.** OpenAI marks them deprecated in favour of skills. They still work today, and the `$mate:ask` skill needs no extra install, so use whichever you prefer. Restart Codex after installing prompts.

Each command calls the same `mate_*` tool as its skill, falls back to the `npx -y agentmate jobs ...` CLI when MCP is not loaded, and points to the skill for the full rules. `jobs` takes a verb instead of a provider: `/jobs list`, `/jobs observe <id>`, `/jobs result <id>`, `/jobs cancel <id>`.

## Team lead mode

A team lead is a job whose worker plans a broad objective, delegates pieces to the other provider through the CLI, reviews the results and writes a report. You start it with `mate_teamlead` or the `teamlead` skill and follow it with `mate_observe`.

```text
your session
  `-- teamlead job (depth 0, started by you)       codex lead: danger-full-access
        |-- research job (claude)                   depth 1, cannot start jobs
        |-- review job (claude)                     depth 1, cannot start jobs
        `-- implement job (claude)                  depth 1, write, one per working tree
```

The stored `depth` is 0 for a job started by a session and 1 for a job started by a worker. The limit is two levels: a session starts a team lead, the lead starts child jobs, and the children cannot start jobs.

The final report has the sections Objective, Plan, Delegations (id, provider, role, status), Findings, Decisions, Deliverables and Open questions. `jobs observe <id>` shows the lead's output with its children; `jobs list --parent <id>` lists only the children.

> **Codex sandbox warning.** A Codex team lead runs with `--sandbox danger-full-access` whether `mode` is read-only or write. It has to start worker processes and write job state under `~/.agentmate`, so the sandbox cannot be narrower. In read-only mode the runtime refuses any `write` child job and the prompt forbids edits, but the lead itself is not sandboxed. Treat a Codex team lead like any Codex session with full filesystem access, or lead with `claude` instead, whose permissions are an explicit tool allowlist that includes an explicit deny of `Edit`, `Write` and `NotebookEdit` in read-only mode.

The team lead calls the CLI pinned to the installed version (`npx -y agentmate@<version> jobs ...`), so a local checkout that is not published to npm must be published or linked before team lead mode works.

Use a team lead only when the work has several independent parts. One question or one review is cheaper as `ask` or `review`.

## How it works

AgentMate treats delegated work as a durable background job:

1. Start a task on `codex` or `claude`. The tool returns a job id immediately (or the answer, for `mate_ask`).
2. Wait for that id, collect its result, or request progress when a person asks for it.
3. Use the stored result to decide the next step. Jobs survive the caller session ending.

![A task moves through a queue, worker, and returned result.](./assets/illustrations/background-jobs.png)

The jobs MCP server (`npx -y agentmate serve jobs`, registered by the plugin) and the `jobs` CLI share one runtime. State lives under `~/.agentmate`. A detached worker runs the provider CLI and records the output, so an expired wait never stops a job.

| Capability           | MCP                                                                                                                    | CLI                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Start work           | `mate_start`, `mate_ask`, `mate_review`, `mate_research`, `mate_plan`, `mate_implement`, `mate_teamlead` | `jobs start`, `jobs ask`             |
| Wait or fetch output | `mate_wait`, `mate_result`                                                                                         | `jobs wait <id>`, `jobs result <id>` |
| Request progress     | `mate_observe`                                                                                                       | `jobs observe <id>`                  |
| Cancel work          | `mate_cancel`                                                                                                        | `jobs cancel <id>`                   |
| Find jobs            | `mate_list`                                                                                                          | `jobs list [--cwd] [--parent <id>]`  |

Skills prefer the `mate_*` tools. If the host did not load MCP, they run the same job contract through `npx -y agentmate`; they never change a user's host configuration as a fallback.

## Usage examples

### Ask a quick question

```bash
npx -y agentmate jobs ask codex "Why might src/jobs/store.ts lose a write under concurrent workers?" --wait 120s
```

The answer is printed when it arrives. If the wait expires, the job keeps running: `jobs wait <id>` collects it.

### Review a change

Start with a read-only request. Give the receiving CLI enough context to produce an actionable result: name the goal, relevant files or diff, and the expected answer.

```bash
npx -y agentmate jobs start codex "Review the current diff. Report only actionable findings." --role review
# retain the job ID printed by start
npx -y agentmate jobs wait <job-id>
```

After a plugin restart, the same workflow can be requested through the installed `review` skill or the `delegate` skill. The skill selects MCP when it is available and otherwise runs the CLI commands above.

### Delegate an authorized edit

Jobs default to `read-only`, except `implement`, which always runs in write mode and rejects `read-only`. Use it only when the task is explicitly allowed to change files, and send one write job per working tree at a time. The `--mode write` flag is redundant for `implement` but makes the intent explicit.

```bash
npx -y agentmate jobs start claude "Add a focused regression test for the parser." --role implement --mode write --cwd .
npx -y agentmate jobs wait <job-id>
```

### Run a team lead

```bash
npx -y agentmate jobs start claude "Audit the CLI for inconsistent error handling and propose fixes. Delegate independent areas to codex." --role teamlead
npx -y agentmate jobs observe <job-id>
npx -y agentmate jobs wait <job-id> --timeout 10m
```

### Continue, inspect, or cancel a job

An expired wait does not stop work. Repeat `wait` for the same ID, inspect output when progress is requested, or collect a stored result after an interrupted terminal session.

```bash
npx -y agentmate jobs observe <job-id>
npx -y agentmate jobs result <job-id>
npx -y agentmate jobs cancel <job-id>
```

A finished job with a saved session can continue on the same provider:

```bash
npx -y agentmate jobs start codex "Address the highest-priority finding." --continue <job-id>
```

| `wait` exit code | Meaning                               | Next action                                      |
| ---------------- | ------------------------------------- | ------------------------------------------------ |
| `0`              | Job completed                         | Read and assess the returned result.             |
| `1`              | Job failed or was canceled            | Read `result` for the retained output and error. |
| `2`              | Wait expired while job remains active | Repeat `wait`; do not create a duplicate job.    |

`jobs ask` uses the same exit codes. Do not pipe `wait` or `ask`: a pipe discards the exit code.

`jobs wait --timeout` (for example `10m` or `90s`) only limits how long the command waits. To limit how long a job may run, pass `jobs start --timeout <minutes>`: a positive number of minutes, at most 120.

## Safety model

- **Read-only by default.** `ask`, `review`, `plan` and `research` always run read-only, and `teamlead` is read-only unless you pass `mode: write`. `implement` always runs in write mode: `--role implement` and `mate_implement` default to write and reject `read-only`. Use it only after the user has authorized edits.
- **Permissions per role.** The sandbox or tool allowlist follows the role and mode:

  | Role and mode                                             | Codex sandbox        | Claude permissions                                                                        |
  | --------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
  | read-only (`ask`, `review`, `plan`, read-only `teamlead`) | `read-only`          | allowlist (below) and an explicit deny of `Edit`, `Write` and `NotebookEdit`              |
  | `research`                                                | `read-only`          | the read-only allowlist plus `WebSearch` and `WebFetch`, with the same explicit deny      |
  | `implement`, write `teamlead`                             | `workspace-write`    | `acceptEdits` permission mode plus the verification allowlist (below)                     |
  | `teamlead` (Codex lead, read-only or write)               | `danger-full-access` | not applicable                                                                            |
  | `teamlead` (Claude lead)                                  | not applicable       | the rows above, plus CLI access limited to `agentmate jobs *` (installed version) |

  The read-only allowlist is `Read`, `Grep`, `Glob`, `git diff`, `git log`, `git show` and `git status`. The write-mode allowlist adds `pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add` and `git commit` so a worker can run verification commands. Extend it with the environment variable `AGENTMATE_CLAUDE_WRITE_TOOLS`, a comma-separated list of Claude permission patterns. A Claude team lead cannot run `setup` or `install`, only `agentmate jobs *`.

- **A Codex team lead is not sandboxed.** It runs with `--sandbox danger-full-access` in either mode, because it must spawn worker processes and write job state. "Read-only" for a Codex lead means that the runtime refuses any `write` child job (a read-only parent cannot start write children) and that the prompt forbids edits; it does not restrict the lead's own process. Lead with `claude` when this matters.
- **Delegation depth limit of 2.** A session starts a team lead (depth 0), the lead starts child jobs (depth 1), and children cannot start jobs. The runtime refuses a third level and refuses a team lead started by a worker.
- **One `write` job per working tree at a time.** Two writers in one tree collide. The skills and the team lead prompt follow this rule; use separate git worktrees for parallel edits.
- **The delegator owns acceptance.** Job output is an input to your judgment. Verify claims and run the tests before you merge anything a worker produced.
- **No hidden configuration changes.** The plugin registers its own MCP server. The fallback path runs the CLI and never edits host configuration. Do not put secrets in briefings: prompts and results are stored in plain text under `~/.agentmate`, in files created with owner-only permissions (`0600` for files, `0700` for directories).

## Troubleshooting

Start with `npx -y agentmate doctor`. It prints `ok`, `warn` or `fail` for each check with a hint, and exits `1` if any check fails. It runs without `codex` or `claude` installed and reports the missing CLI as a warning. It checks that each CLI responds to `--version`, not that you are logged in.

| Symptom                                             | Likely cause and fix                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `mate_*` tools or skills do not appear            | Restart the host after installing; check `claude plugin list` or `codex plugin list`.                                                  |
| A job fails immediately                             | The destination CLI is missing from `PATH` (`doctor` reports this) or not authenticated (`doctor` does not check; log in to it).       |
| `wait` or `ask` exits `2`                           | The job is still running. Repeat `jobs wait <id>`; do not start a duplicate.                                                           |
| A job shows `running` but nothing happens           | The worker process died. `doctor` lists the ids of these jobs; `jobs cancel <id>` clears them.                                         |
| `Delegation depth limit reached`                    | A job started by a worker tried to start another job (a third level). Return the findings to the session that started the job instead. |
| `Only a top-level session can start a teamlead job` | A worker tried to start a team lead. Start it from your own session.                                                                   |
| Duplicated or conflicting tools                     | A legacy `setup` install is still registered. `doctor` flags it; see the migration section of the guide.                               |

## Requirements

- Node.js 18 or later
- Claude Code and/or Codex CLI, authenticated
- The destination CLI available on the initiating host's `PATH`

## Legacy setup

`npx -y agentmate setup` remains available for existing installations that use the synchronous bridge servers or the legacy `/codex` and `/claude` shortcuts. New installations should use the plugin. The [installation guide](./docs/INSTALL_FOR_AGENTS.md#move-from-a-legacy-setup-install) explains how to remove only the legacy entries that belong to AgentMate.

## Development

```bash
git clone https://github.com/naldomadeira/agentmate.git
cd agentmate
pnpm install
pnpm build
pnpm test
pnpm lint
```

Release notes are in the [changelog](./CHANGELOG.md).

## License

[MIT](./LICENSE)
