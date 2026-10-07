# AgentMate

[![npm version](https://img.shields.io/npm/v/agentmate?color=f97316)](https://www.npmjs.com/package/agentmate)
[![npm downloads](https://img.shields.io/npm/dm/agentmate?color=3b82f6)](https://www.npmjs.com/package/agentmate)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[Português (Brasil)](./docs/README.pt-BR.md)

**AI agents work better together.**

AgentMate connects AI coding agents so they can collaborate, delegate, review, and help each other complete tasks. Give your AI agent a teammate: let [Claude Code](https://code.claude.com/) and the [Codex CLI](https://developers.openai.com/codex/cli/) ask, review, research, plan, implement, cross-review and lead each other as background jobs.

![AgentMate: in Claude Code, /mate:review hands a review to Codex; in Codex, $mate:ask asks Claude a question.](./assets/hero.svg)

## Why AgentMate

- **A second opinion from a different model.** Ask the other CLI a question, or have it review your diff, before you commit to an approach. It reads your repository; it does not share your session's assumptions.
- **More than two CLIs.** Besides Claude Code and Codex, AgentMate also drives the Gemini CLI and the Antigravity CLI (`agy`), the same one the author's agy-staff plugin is built on. Both are experimental teammates: tested with fake binaries, never against the real CLIs.
- **Work that does not block you.** Every task is a durable background job with an id. The session that started it can end, and the result is still there.
- **Roles instead of raw prompts.** `ask`, `review`, `research`, `plan`, `implement` and `teamlead` each send a tuned prompt with a defined output format, and each runs with the narrowest permissions that role needs. Jobs are read-only unless you say otherwise. `crossreview` chains two of them: one agent implements, the other reviews, and the loop runs without you relaying anything. `split` divides a broad goal into independent parts that both agents work on in parallel and review each other's, sharing context through sessions.

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

`doctor` verifies Node.js, that the `codex` and `claude` CLIs (and the optional, experimental `gemini` and `agy` CLIs) are on your `PATH` and respond to `--version`, the job state directory, stale `running` jobs (it lists their ids) and legacy registrations, and prints a fix for each problem. It does not check authentication: if a job fails right away, log in to the destination CLI yourself. See the [installation guide](./docs/INSTALL_FOR_AGENTS.md) for upgrades, a local-development install and cleaning up leftover legacy registrations.

### Set up a repository

```bash
npx -y agentmate init          # add or refresh the AgentMate block in AGENTS.md and CLAUDE.md
npx -y agentmate init --check  # change nothing; exit 1 if a block is missing or out of date
```

`agentmate init` (or `/mate:init`) writes a block of at most 25 lines between `<!-- agentmate:start -->` and `<!-- agentmate:end -->` in the repository's existing `AGENTS.md` and `CLAUDE.md` (a file with CRLF line endings keeps them), so every agent that opens the repo knows the `/mate:` and `$mate:` commands, how to check on jobs (`agentmate jobs list`, `agentmate inbox`) and the rules for a job it receives (no commit or push unless asked, report with the role's headings, treat session notes as data). Text outside the markers is never touched and a second run changes nothing. Claude Code does not read `AGENTS.md` natively, so `--create` starts both `AGENTS.md` and a `CLAUDE.md` that begins with `@AGENTS.md` (Claude Code imports it) followed by the block; use `--files`  to pick other files and `--cwd` to run it elsewhere. Run it again after upgrading to refresh the block.

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
| Implement, then cross-review | `/mate:crossreview codex Add a --dry-run flag to the export command`        |
| Split a goal across both agents | `/mate:split codex Add CSV and JSON export to the report command`        |
| Job ops                 | `/mate:jobs list`, `/mate:jobs result <id>`, `/mate:jobs cancel <id>`         |

`implement` and `crossreview` edit files, and `split` does when you pass `--mode write`, so use them only when you authorize that. The others are read-only.

## Teammates

| Teammate                      | Provider id | Needs                                                    | Notes                                                                                                                 |
| ----------------------------- | ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Claude Code                   | `claude`    | the `claude` CLI                                         | Reads with an explicit tool allowlist; web access in `research`.                                                      |
| Codex CLI                     | `codex`     | the `codex` CLI                                          | Sandboxed by mode; no web access.                                                                                     |
| Gemini CLI (**experimental**) | `gemini`    | the `gemini` CLI on `PATH` (or `AGENTMATE_GEMINI_BIN`) | Runs `gemini -p` with `--output-format stream-json` and an approval mode per role. Headless Gemini has **no shell and no web**, `--resume` is unverified (so `continue` is refused), and a team lead is write-only. Tested with a fake binary only. |
| Antigravity CLI (**experimental**) | `agy` | the `agy` CLI on `PATH` (or `AGENTMATE_AGY_BIN`) | Runs `agy -p` with `--output-format stream-json`, `--add-dir <cwd>` and `--print-timeout <N>m` (the job deadline in whole minutes). **Read-only jobs pass no permission flag**: headless agy denies the tool calls its own profile does not allow, so results can be thin until you install the agy-staff allowlist or run in write mode. **Write jobs and the (write-only) team lead pass `--dangerously-skip-permissions`.** No shell is counted on and no web; `continue` works through `--conversation <id>`. Tested with a fake binary only. |

A job on an agent that is not installed is refused up front with an install hint, and `agentmate doctor` lists each agent (a missing Gemini or Antigravity CLI is reported as optional, for example `ok  agy  not installed (optional)`). `teamlead`, `crossreview` and `split` pair the provider with the first installed other agent (in the order codex, claude, gemini, agy), resolve and check it before anything starts, and record it as the job's `partner`. Pass `partner` (`mate_teamlead`, `mate_crossreview`, `mate_split`, or `jobs start --partner <agent>`) to pick the other agent yourself, for example `/mate:crossreview codex <task>` with `partner: gemini` to have Gemini review Codex's change. The partner must differ from the provider and be installed. Gemini limits, in short: it cannot run shell commands (reviews of its changes or by it get the diff inline, capped at 30 000 characters, and an `implement` job cannot run the tests), it cannot search the web, it cannot continue a job, and as a team lead it needs `mode: write`. agy shares the diff-inline, no-web and write-only team lead limits, but it can continue a job; its read-only results depend on the permissions of your agy profile (see the table above).

## What you can do

Eight roles, each reachable as a skill, an MCP tool and a CLI command. `<provider>` is `codex`, `claude`, `gemini` or `agy` (the last two experimental); pick the one that is not the host you are in.

| Role        | Skill       | MCP tool           | CLI                                                 | Mode                               |
| ----------- | ----------- | ------------------ | --------------------------------------------------- | ---------------------------------- |
| `ask`       | `ask`       | `mate_ask`       | `jobs ask <provider> "<question>"`                  | read-only                          |
| `review`    | `review`    | `mate_review`    | `jobs start <provider> "<prompt>" --role review`    | read-only                          |
| `research`  | `research`  | `mate_research`  | `jobs start <provider> "<prompt>" --role research`  | read-only (Claude adds web access) |
| `plan`      | `plan`      | `mate_plan`      | `jobs start <provider> "<prompt>" --role plan`      | read-only                          |
| `implement` | `implement` | `mate_implement` | `jobs start <provider> "<prompt>" --role implement` | write (always)                     |
| `teamlead`  | `teamlead`  | `mate_teamlead`  | `jobs start <provider> "<prompt>" --role teamlead`  | read-only by default, write opt-in |
| `crossreview` | `crossreview` | `mate_crossreview` | `jobs start <provider> "<task>" --role crossreview [--max-rounds N]` | write on the implementer, read-only review |
| `split` | `split` | `mate_split` | `jobs start <provider> "<goal>" --role split [--max-parts N] [--mode write]` | read-only by default, write opt-in (one git worktree per part) |

`mate_ask` waits for the answer (up to 120 seconds by default) and returns it in the same call. The other role tools return a job id immediately unless you pass `waitSeconds`.

Codex limits an MCP tool call to about 60 seconds by default. When you run inside Codex, pass `waitSeconds: 45` to `mate_ask` and continue with `mate_wait` if the answer has not arrived.

Six more skills cover the rest:

- `jobs` lists, observes, collects and cancels jobs, and inspects models via `mate_models`.
- `delegate` is the generic path (`mate_start`) for work that fits no role.
- `codex`, `claude`, `gemini` and `agy` (the last two experimental) are shortcuts that route a plain request to the right role with the provider already set.
- `init` sets up a repository for AgentMate (see [Set up a repository](#set-up-a-repository)).

In Claude Code the plugin also adds four agents that wrap Codex: `codex-teammate` (questions and general delegation), `codex-reviewer`, `codex-researcher` and `codex-teamlead`. They brief Codex, verify what it returns and report their own conclusion instead of forwarding raw output.

Every command in the table works without MCP. Prefix CLI commands with `npx -y agentmate`.

## Slash commands

Nine commands (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `crossreview`, `split` and `jobs`) can be started as a command in either host. Both hosts take the provider first, then the request.

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

A team lead is a job whose worker plans a broad objective, delegates pieces to the other provider through the CLI, reviews the results and writes a report. You start it with `mate_teamlead` or the `teamlead` skill and follow it with `mate_observe`. The lead delegates to `partner` when you pass one (for example a `claude` lead with `partner: gemini`); the default is the first installed other agent.

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

> **Gemini team lead warning (experimental).** A `gemini` team lead is accepted only with `mode: write`, because delegating needs the shell and Gemini allows it only in `--approval-mode yolo`, which approves every tool call without asking. A read-only Gemini lead is refused (`A Gemini team lead needs mode write: delegation requires the shell, which Gemini only allows in yolo mode.`). Treat it like the Codex lead above, or lead with `claude`.

> **agy team lead warning (experimental).** An `agy` team lead is accepted only with `mode: write`, because delegating needs the shell and headless agy allows it only with `--dangerously-skip-permissions`, which skips every permission check. A read-only agy lead is refused (`An agy team lead needs mode write: delegation requires the shell, which agy only allows with --dangerously-skip-permissions.`). Treat it like the Codex lead above, or lead with `claude`.

Use a team lead only when the work has several independent parts. One question or one review is cheaper as `ask` or `review`.

## Cross-review

Cross-review lets one agent implement and the other review, so you do not copy a diff between sessions. It is a workflow job: the worker does not call a CLI itself, it runs the steps as child jobs. `provider` implements; the other agent reviews (`partner`, when you pass one). Start it with `mate_crossreview` or the `crossreview` skill (`/mate:crossreview codex <task>`), and follow it with `mate_observe`.

```text
implement (provider, write)  ->  review (other agent, read-only)  ->  verdict
        ^                                                              |
        |            Verdict: request-changes, rounds left             |
        `---- implement --continue with the findings  <---------------'
                                                      |
                              Verdict: approve  ->  done
```

Each round has two child jobs on the same working directory (`depth` 1, `parentJob` = the workflow id). The implementer runs in write mode; from round 2 it continues its own session with the reviewer's findings (an implementer that cannot continue, such as Gemini, starts a fresh implement job with the findings instead). The reviewer reads the uncommitted `git diff` (and `git status` for new files) read-only, or receives the diff in its briefing when it cannot run the shell (Gemini, agy), with the implementer's report as context, and must end its review with the line `Verdict: approve` or `Verdict: request-changes`.

Stop rules:

- `Verdict: approve` ends the workflow as `done`.
- `Verdict: request-changes` starts another round while rounds remain (`maxRounds`, 1 to 5, default 2). When the budget is used up the workflow is `done` and the report says so; the latest edits stay in the working tree.
- No clear verdict ends the workflow at once as `done` with a `## Needs human` section; it never loops blindly.
- A child that ends `error`, `timeout` or `canceled` ends the workflow as `error`, naming that child's id and error. A child that ends `quota_exhausted` ends it as `error` with that child's own error, which already says how to hand the work to the other agent. The workflow's own `--timeout` is the overall deadline, and `jobs cancel <id>` on the workflow cancels its running children first (recursively), then the workflow itself.

The report (`jobs result <id>`) has `## Task`, `## Rounds` (round, implement job, review job, verdict), `## Final review`, `## Changes`, `## Needs human` when it applies, and `## Next steps` with the `jobs result <child-id>` commands. `jobs events <id>` lists one `important` event per step, such as `round 1: review verdict approve`.

```bash
npx -y agentmate jobs start codex "Add a --dry-run flag to the export command" --role crossreview --max-rounds 3
```

It edits files, so start it only when you authorize that, and keep one write job per working tree. Only a top-level session can start it, like a team lead. `--model` applies to the implementer only.

## Task splitting

Task splitting divides a broad goal into independent parts, runs the parts in parallel on both agents and has the other agent review each one, so you do not relay results between sessions. Like cross-review it is a workflow job: the worker calls no CLI itself, it runs the steps as child jobs (`depth` 1, `parentJob` = the workflow id) that share one [session](#sessions). `provider` plans; each part goes to an installed agent, or only to the provider and its `partner` when you pass one. Start it with `mate_split` or the `split` skill (`/mate:split codex <goal>`), and follow it with `mate_observe`.

```text
goal -> plan (provider, read-only)
          |  1..maxParts parts: closed interfaces, no overlapping files, one agent each
          v
        parts in parallel ---- read-only: a research job per part, on the working directory
          |                    write:     a git worktree + branch per part, an implement job in each
          v
        cross-review (the other agent of each part, read-only, Verdict: approve | request-changes)
          |
          v
        integration report (parts table, merge order, what needs a human)
```

1. **Plan.** A `plan` job on `provider` returns a fenced `json` block, `{ "parts": [{ "id", "title", "briefing", "files", "agent" }] }`, with 1 to `maxParts` parts (2 to 4, default 3). The worker takes the last such block and checks it: unique ids (`a-z`, `0-9`, `-`), known agents (a missing or unknown agent alternates, starting with the other agent). If the block is invalid the workflow ends `error` with a pointer to `jobs result <plan-job>`. The plan goes into the session notes, so every part sees it.
2. **Parts, in parallel.** Read-only (default): one `research` job per part on the part's agent, in the working directory. Write (`--mode write`): for each part the worker creates a worktree from the recorded base commit, `git worktree add -b agentmate/<split-id>/<part-id> ~/.agentmate/worktrees/<split-id>/<part-id> <base-commit>`, then an `implement` job works there, so your working tree is untouched. When the implementer finishes, AgentMate commits what it left on the part's branch automatically (`--no-verify`, gpg signing off).
3. **Cross-review.** Each finished part is reviewed read-only by the other agent of the pair (the provider or the partner): in write mode in the part's worktree, against the commit the branch started from (`git diff <base-commit>`, or that diff inline when the reviewer is Gemini or agy and cannot run the shell); in read-only mode over the research result. The review ends with `Verdict: approve` or `Verdict: request-changes`.
4. **Report.** `jobs result <id>` has `## Goal`, `## Parts` (part, title, agent, part job, review job, verdict, branch), `## Integration`, `## Needs human` when it applies and `## Next steps` with the `jobs result <child-id>` commands. In write mode the report lists every worktree and branch with its cleanup commands (`git worktree remove <path>`, `git branch -D <branch>`), `## Integration` has the ordered `git merge agentmate/<split-id>/<part-id>` commands for **approved parts only**, and every other part goes under `## Needs human`; in read-only mode it merges the research results. `jobs events <id>` lists one `important` event per step.

A part that fails does not stop the others: they run to completion (and are reviewed), then the workflow ends `error` naming the failed part. A part that is not approved (`request-changes`, a missing verdict or a failure) lands in `## Needs human`. The workflow's own `--timeout` is the overall deadline, and `jobs cancel <id>` on it also cancels the running children.

**Write mode limitations.** It needs a git repository with a **clean working tree**, checked **before** the planner runs; commit or stash first. The worktrees are fresh checkouts: they have no `node_modules`, no `.env` and no submodule contents, so a part cannot run checks that need them unless its briefing says how to set them up.

What is **not** automated: AgentMate never merges, pushes, rebases or deletes branches for you, and merge conflicts between parts are not resolved automatically. Run the merges from the report yourself, resolve any conflict, run the tests, then remove the worktrees. There is no second round: a part with `request-changes` is for you (or a follow-up job) to fix.

```bash
npx -y agentmate jobs start codex "Add CSV and JSON export to the report command" --role split --max-parts 3
npx -y agentmate jobs start codex "Add CSV and JSON export to the report command" --role split --mode write
```

Write mode edits files (in the worktrees), so start it only when you authorize that. Only a top-level session can start it, like a team lead. `--model` applies to the planner and to parts run by the same agent.

## How it works

AgentMate treats delegated work as a durable background job:

1. Start a task on `codex` or `claude`. The tool returns a job id immediately (or the answer, for `mate_ask`).
2. Wait for that id, collect its result, or request progress when a person asks for it.
3. Use the stored result to decide the next step. Jobs survive the caller session ending.

![A task moves through a queue, worker, and returned result.](./assets/illustrations/background-jobs.png)

The jobs MCP server (`npx -y agentmate serve jobs`, registered by the plugin) and the `jobs` CLI share one runtime. State lives under `~/.agentmate`. A detached worker runs the provider CLI and records the output, so an expired wait never stops a job.

Every job also writes an append-only event log (`events.jsonl`). Both Codex and Claude (`--output-format stream-json`) stream events while they run. Events carry one of three levels: `important` (the agent's messages, errors, start and finish), `status` (files changed) and `fyi` (commands run). `mate_observe` and `jobs observe` show only `important` and `status` events, so progress checks stay small; ask for `fyi` with `levels` / `--level`, read the full log with `mate_events` / `jobs events <id>`, and pull the raw stdout/stderr tails only when needed with `raw` / `--raw`. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the runtime, adapters and event model.

| Capability           | MCP                                                                                                                    | CLI                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Start work           | `mate_start`, `mate_ask`, `mate_review`, `mate_research`, `mate_plan`, `mate_implement`, `mate_teamlead`, `mate_crossreview`, `mate_split` | `jobs start`, `jobs ask`             |
| Wait or fetch output | `mate_wait`, `mate_result`                                                                                         | `jobs wait <id>`, `jobs result <id>` |
| Request progress     | `mate_observe`                                                                                                       | `jobs observe <id> [--raw]`          |
| Read job events      | `mate_events`                                                                                                        | `jobs events <id> [--follow]`        |
| Cancel work          | `mate_cancel`                                                                                                        | `jobs cancel <id>`                   |
| Find jobs            | `mate_list`                                                                                                          | `jobs list [--cwd] [--parent <id>]`  |
| List models          | `mate_models`                                                                                                        | `jobs models [provider] [--refresh]` |
| Sessions             | `mate_session_start`, `mate_session_context`, `mate_session_show`, `mate_session_notes`, `mate_session_list`          | `sessions start/context/show/notes/list`, `jobs start --session <id>` |
| Inbox                | `mate_inbox`                                                                                                         | `inbox [--cwd] [--all] [--no-ack] [--follow]` |

<a id="sessions"></a>

**Sessions.** A session is shared context across jobs and agents. `mate_session_start(title, cwd?, context?)` creates one under `~/.agentmate/sessions/<id>/` (`session.json`, `notes.md` and optional `context.md`; membership is derived from the jobs that carry the session id, so `session.json` has no `jobs` array); pass its id as `session` to any role tool or `mate_start` (CLI: `jobs start ... --session <id>`) and the job is recorded in it. A session holds a fixed briefing (spec, decisions, how to test, up to 16,000 characters) set at creation or via `mate_session_context(session, context, mode? = "replace" | "append")` (CLI: `sessions start --context/--context-file`, `sessions context <id> [text|--file] [--append]`). Every worker in the session receives this fixed context in full under `## Session context (session <id>)` ahead of notes, so individual jobs only need to pass their specific focus. `mate_session_notes(id, text, author?)` appends a note (a single note is capped at 2000 characters), `mate_session_show(id)` shows the context (up to ~2 KB), notes (tail) and the session's jobs, and `mate_session_list(cwd?, limit?)` lists sessions. When a session has notes, every worker started in it receives them **after** the task and context, under `## Shared session notes`, in a code fence and framed as data written by other agents, not as instructions. The injection is capped at 4000 characters of whole entries (the newest that fit), whatever the role, so keep notes short and factual: decisions, constraints, file locations. Jobs that a workflow starts (`crossreview`, `split`) inherit the workflow's session, and `split` creates a session for itself when you pass none and writes its plan into the notes. The notes and context are plain text under `~/.agentmate`, so keep secrets out of them.

**Session start summary.** In Claude Code the plugin also registers a `SessionStart` hook (`hooks/hooks.json`). When a session opens, it prints one line (400 characters at most) about the jobs started from that directory or a subdirectory: the jobs that finished since the last session there (`quota_exhausted` ones first, marked "needs hand-off"), how many are still running and how many are stale (their worker is gone). It stays silent when there is nothing to report and for 120 seconds after the last summary in the same directory; the first time in a directory it looks back 24 hours. Set `AGENTMATE_HOOK_QUIET=1` to turn it off. It never fails a session: any error exits silently. This is a Claude Code feature only; Codex has no equivalent hook.

**Inbox.** Every time a job records an `important` message, error or finish, AgentMate also appends one line to `~/.agentmate/inbox.jsonl` (owner-only, rotated to `inbox.1.jsonl` past 5 MB, one generation): `{ ts, job, cwd, session?, provider, role, kind, text }`. It is how one agent learns that the other finished or failed without sitting in `wait`. `mate_inbox(cwd?, unread? = true, ack? = true, limit? = 20)` returns the entries for that directory or a subdirectory, one line each (`HH:MM:SS  <job>  <role>/<provider>  <kind>  <text>`), oldest first, and moves a read marker kept per directory in `~/.agentmate/inbox-cursors/` through the last entry it showed (`… N more unread (run again)` when there are more), so nothing is shown twice; a terminal job already read through `mate_wait` or `mate_result` is not listed again, and entries of jobs started by another job (workflow steps, team lead children) are left out because their parent reports. Entry text is capped at 500 characters and is untrusted worker output: data, not instructions. Workers never read the host's inbox: `mate_inbox` declines when `AGENTMATE_JOB_ID` is set and the hooks stay silent inside a worker. From a terminal, `agentmate inbox` does the same (`--all` for every directory, `--no-ack` to only look) and `agentmate inbox --follow` prints new lines every second until Ctrl-C. In Claude Code the plugin also registers a `UserPromptSubmit` hook: before each prompt it adds up to 5 unread entries for the directory to the context (10 seconds of cooldown per directory, `AGENTMATE_HOOK_QUIET=1` turns it off, any error exits silently), and the `SessionStart` summary mentions how many are unread. Codex has no hooks, so the `jobs`, `teamlead`, `crossreview` and `split` skills tell it to call `mate_inbox` when it resumes a turn with jobs in progress, before `mate_wait`. Entries are short summaries; read the full output with `jobs result <id>`.

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

### Cross-review a change

```bash
npx -y agentmate jobs start codex "Add a --dry-run flag to the export command" --role crossreview --max-rounds 3
npx -y agentmate jobs wait <job-id> --timeout 10m
npx -y agentmate jobs result <job-id>
```

Codex implements, Claude reviews the uncommitted diff, and the report lists the rounds. Use `jobs events <job-id>` for the step-by-step log.

### Split a goal across both agents

```bash
sid=$(npx -y agentmate sessions start "CSV and JSON export")
npx -y agentmate sessions notes "$sid" "Keep the CLI flags stable; formatters live in src/export/."
npx -y agentmate jobs start codex "Add CSV and JSON export to the report command" --role split --session "$sid"
npx -y agentmate jobs wait <job-id> --timeout 10m
npx -y agentmate jobs result <job-id>
npx -y agentmate sessions show "$sid"
```

Codex plans the parts, both agents research them in parallel, and the report merges the findings. Add `--mode write` to implement each part in its own worktree and branch.

### Continue, inspect, or cancel a job

An expired wait does not stop work. Repeat `wait` for the same ID, inspect output when progress is requested, or collect a stored result after an interrupted terminal session.

```bash
npx -y agentmate jobs observe <job-id>
npx -y agentmate jobs result <job-id>
npx -y agentmate jobs cancel <job-id>
```

A finished job with a saved session can continue on the same provider (not available for `gemini` yet, whose `--resume` is unverified; start a new job with the full context. `agy` continues with `--conversation <id>`):

```bash
npx -y agentmate jobs start codex "Address the highest-priority finding." --continue <job-id>
```

| `wait` exit code | Meaning                               | Next action                                      |
| ---------------- | ------------------------------------- | ------------------------------------------------ |
| `0`              | Job completed                         | Read and assess the returned result.             |
| `1`              | Job failed, was canceled or hit its quota (`quota_exhausted`) | Read `result` for the retained output and error. |
| `2`              | Wait expired while job remains active | Repeat `wait`; do not create a duplicate job.    |

`jobs ask` uses the same exit codes. Do not pipe `wait` or `ask`: a pipe discards the exit code.

`jobs wait --timeout` (for example `10m` or `90s`) only limits how long the command waits. To limit how long a job may run, pass `jobs start --timeout <minutes>`: a positive number of minutes, at most 120.

### Reasoning effort

Pass `effort` (`low`, `medium`, `high`, `xhigh`) to any job-starting tool or `--effort` to `jobs start` / `jobs ask`:

- **Codex** passes `-c model_reasoning_effort=<effort>` on `exec` and `exec resume`.
- **Claude** passes `--effort <effort>`.
- **agy** folds the effort into the model id (`<model>-<effort>`, requires `model`, accepts `low`, `medium`, or `high`, e.g. `gemini-3.1-pro` + `high` → `gemini-3.1-pro-high`).
- **Gemini** has no reasoning effort setting in headless mode and refuses it with a clear error.
- Resuming with `--continue` inherits the previous job's `effort` and `model` unless overridden. In `crossreview`, `effort` applies to the implementer only. In `split`, it applies to the planner and same-agent parts.

### Models and validation

Pass `model` / `--model <id>` to override the model. Inspect supported models and efforts with `mate_models` or `npx -y agentmate jobs models [provider] [--refresh]`:

- **agy** queries `agy models`, cached on disk for 6 hours in `~/.agentmate/cache/models-agy.json` (bypass with `refresh` / `--refresh`).
- **Codex** reads `$CODEX_HOME/models_cache.json` for the job's account, listing supported reasoning levels.
- **Claude and Gemini** are not checked (their CLIs do not provide a machine-readable model catalog).
- Unknown models and unsupported efforts fail before dispatch with closest matches suggested. Set `AGENTMATE_SKIP_MODEL_CHECK=1` to skip this check.

### Codex accounts

For Codex, pass `account` / `--account <name>` to choose the active profile:

- `principal` (or `default`): uses the default `CODEX_HOME` (`~/.codex`).
- Profile name: directory under `~/.codex-profiles/<name>` (override base directory with `AGENTMATE_CODEX_PROFILES`), running with its own `CODEX_HOME`.
- `auto`: runs `limites --json` (override binary with `AGENTMATE_LIMITES_BIN`) and selects the account with the most headroom, falling back to `principal` with a note if `limites` fails or returns no suggestion.
- Resumed jobs (`--continue`) enforce and inherit the original account. In `crossreview`, `account` applies to the implementer; in `split`, to the planner, same-agent parts, and Codex reviewers.

### Review with command execution

`mate_review` and `jobs start --role review` default to strict read-only inspection. Pass `allowCommands: true` or `--allow-commands` to widen the sandbox so the reviewer can run tests, builds, and verification commands:

- **Codex** widens `--sandbox` from `read-only` to `workspace-write` (allowing caches and sockets while the prompt forbids file edits).
- **Claude** allows unrestricted `Bash` while maintaining an explicit denial of `Edit`, `Write`, and `NotebookEdit`.
- **Gemini and agy** refuse `allowCommands` because they lack shell capability in headless/read-only mode.
- The review prompt directs the reviewer to report concrete verification under `3. **Verified**` (`verified: <cmd> passed/failed`) and `4. **Not verified**`.

### Result header and listing

Job results (`mate_wait`, `mate_result`, `jobs result`) begin with a structured summary header:
`job <id> · provider/mode [· role] [· <model> · <effort>] [· account <name>] [· commands allowed] [· in/out/reasoning tok] [· $cost] · <status> · <duration>s`

When the CLI reports the effective model executed, the header displays `ran <effective model> (asked <requested model>)`. Job listings (`mate_list`, `jobs list`) show `model·effort` (e.g. `default·high` or `gpt-5·medium`) for each entry.

## Safety model

- **Read-only by default.** `ask`, `review`, `plan` and `research` always run read-only, and `teamlead` is read-only unless you pass `mode: write`. `implement` always runs in write mode: `--role implement` and `mate_implement` default to write and reject `read-only`. Use it only after the user has authorized edits.
- **Permissions per role.** The sandbox or tool allowlist follows the role and mode:

  | Role and mode                                             | Codex sandbox        | Claude permissions                                                                        | Gemini (experimental)            | agy (experimental)                                   |
  | --------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------- |
  | read-only (`ask`, `review`, `plan`, read-only `teamlead`) | `read-only`          | allowlist (below) and an explicit deny of `Edit`, `Write` and `NotebookEdit`              | `--approval-mode default`        | no permission flag (agy's own profile)               |
  | `review` (`allowCommands: true`)                          | `workspace-write`    | allowlist with unrestricted `Bash`, explicit deny of `Edit`, `Write`, `NotebookEdit`       | not supported (no shell)         | not supported (no shell)                             |
  | `research`                                                | `read-only`          | the read-only allowlist plus `WebSearch` and `WebFetch`, with the same explicit deny      | `--approval-mode default`        | no permission flag (agy's own profile)               |
  | `implement`, write `teamlead`                             | `workspace-write`    | `acceptEdits` permission mode plus the verification allowlist (below)                     | `--approval-mode auto_edit`      | `--dangerously-skip-permissions`                     |
  | `teamlead` (Codex lead, read-only or write)               | `danger-full-access` | not applicable                                                                            | not applicable                   | not applicable                                       |
  | `teamlead` (Claude lead)                                  | not applicable       | the rows above, plus CLI access limited to `agentmate jobs *` (installed version)         | not applicable                   | not applicable                                       |
  | `teamlead` (Gemini lead, write only)                      | not applicable       | not applicable                                                                            | `--approval-mode yolo`           | not applicable                                       |
  | `teamlead` (agy lead, write only)                         | not applicable       | not applicable                                                                            | not applicable                   | `--dangerously-skip-permissions`                     |

  The read-only allowlist is `Read`, `Grep`, `Glob`, `git diff`, `git log`, `git show` and `git status`. The write-mode allowlist adds `pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add` and `git commit` so a worker can run verification commands. Extend it with the environment variable `AGENTMATE_CLAUDE_WRITE_TOOLS`, a comma-separated list of Claude permission patterns. A Claude team lead cannot run `install`, only `agentmate jobs *`. Claude workers start with `--strict-mcp-config`, so none of your MCP servers (claude.ai connectors and plugins included) load into a job: they start faster and only have the tools above. Set `AGENTMATE_CLAUDE_INHERIT_MCP=1` to give workers your MCP servers. Passing `allowCommands` on `review` widens the sandbox (workspace-write on Codex, general `Bash` on Claude) so reviewers can run tests and verification commands requiring socket or cache writes, while keeping file editing strictly denied; Gemini and agy have no shell capability in read-only mode and reject `allowCommands`.

- **Gemini runs with the least approval that fits the role (experimental).** `--approval-mode default` denies every tool that needs approval in headless mode, so read-only and research jobs can read but not run shell commands or search the web; `auto_edit` approves file edits but still denies the shell, so an `implement` job cannot run the tests. A Gemini team lead needs the shell, which only `--approval-mode yolo` allows: it is accepted with `mode: write` only, and it approves every tool call without asking, so it is as unrestricted as the Codex lead below. `--sandbox` and the legacy `--yolo` flag are never used.
- **agy asks for nothing in read-only and for everything in write mode (experimental).** Read-only jobs pass no permission flag, so headless agy denies the tool calls its own profile does not allow; a read-only job can therefore return thin results until you install the agy-staff allowlist or run in write mode. `--dangerously-skip-permissions` is passed to every `mode: write` job, including `implement` and the team lead, and approves every tool call without asking, so it is as unrestricted as the Codex lead below. An agy team lead is accepted with `mode: write` only. agy has no `--sandbox` here either.
- **A Codex team lead is not sandboxed.** It runs with `--sandbox danger-full-access` in either mode, because it must spawn worker processes and write job state. "Read-only" for a Codex lead means that the runtime refuses any `write` child job (a read-only parent cannot start write children) and that the prompt forbids edits; it does not restrict the lead's own process. Lead with `claude` when this matters.
- **Delegation depth limit of 2.** A session starts a team lead (depth 0), the lead starts child jobs (depth 1), and children cannot start jobs. The runtime refuses a third level and refuses a team lead, a cross-review or a split started by a worker.
- **Cross-review writes only through its implementer.** The `implement` step gets the `implement` permissions above; the `review` step is read-only. The workflow job itself calls no CLI.
- **Split writes only inside its worktrees.** In write mode each part's `implement` job runs in its own git worktree on its own branch (`agentmate/<split-id>/<part-id>`), the planner and reviewers are read-only, and nothing is merged into your branch for you.
- **One `write` job per working tree at a time.** Two writers in one tree collide. The skills and the team lead prompt follow this rule; use separate git worktrees for parallel edits (`split` does this for its parts).
- **A spent plan is a status, not a crash.** When a provider reports that its usage limit, quota or credits are used up, the job ends `quota_exhausted` (terminal; `wait` and `ask` exit `1`). Its `error` reads `<provider> quota exhausted: <line>. Retry after the reset or start the job on <other agent>.`, and `result` adds `Hand off: start the same job with provider <other>.`; the other agent is the first installed one, and when none is installed both lines say to retry after the reset instead. Detection reads the stderr tail and parsed errors only, so a 429 alone is not exhaustion, and the job is not retried once a quota line is seen. Extend the detection with `AGENTMATE_QUOTA_PATTERNS`, case-insensitive regular expressions separated by `|`; invalid ones are ignored. The defaults cover agy's `RESOURCE_EXHAUSTED` status and its `Individual quota reached` and `quota exceeded` wording; its bare `code 429` is too loose to be a default, so add `AGENTMATE_QUOTA_PATTERNS='\bcode\s*429\b'` if you want it (a 429 caused by a tool the agent called then counts as exhaustion too).
- **The delegator owns acceptance.** Job output is an input to your judgment. Verify claims and run the tests before you merge anything a worker produced.
- **No hidden configuration changes.** The plugin registers its own MCP server. The fallback path runs the CLI and never edits host configuration. Do not put secrets in briefings: prompts and results are stored in plain text under `~/.agentmate`, in files created with owner-only permissions (`0600` for files, `0700` for directories). Environment variables that configure job controls: `AGENTMATE_CODEX_PROFILES` overrides the Codex profiles directory (`~/.codex-profiles`), `AGENTMATE_LIMITES_BIN` overrides the binary used to resolve `account: "auto"` (`limites`), and `AGENTMATE_SKIP_MODEL_CHECK=1` skips model and effort catalog validation before dispatch.

## Troubleshooting

Start with `npx -y agentmate doctor`. It prints `ok`, `warn` or `fail` for each check with a hint, and exits `1` if any check fails. It runs without `codex` or `claude` installed and reports the missing CLI as a warning. It checks that each CLI responds to `--version`, not that you are logged in.

| Symptom                                             | Likely cause and fix                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `mate_*` tools or skills do not appear              | Restart the host after installing; check `claude plugin list` or `codex plugin list`.                                                  |
| A job fails immediately                             | The destination CLI is missing from `PATH` (`doctor` reports this) or not authenticated (`doctor` does not check; log in to it).       |
| `wait` or `ask` exits `2`                           | The job is still running. Repeat `jobs wait <id>`; do not start a duplicate.                                                           |
| A job shows `running` but nothing happens           | The worker process died. `doctor` lists the ids of these jobs; `jobs cancel <id>` clears them.                                         |
| `Delegation depth limit reached`                    | A job started by a worker tried to start another job (a third level). Return the findings to the session that started the job instead. |
| `Only a top-level session can start a teamlead job` | A worker tried to start a team lead (or a cross-review or a split: `... a crossreview job`, `... a split job`). Start it from your own session.                      |
| Job ends `quota_exhausted` | The provider's usage limit, quota or credits are spent. Detection looks at the stderr tail and parsed errors only, a 429 alone is not exhaustion, and the job is not retried once a quota line is seen. Wait for the reset it names, or start the same job on the other agent (`result` prints the hint). If your provider words it differently, add a pattern to `AGENTMATE_QUOTA_PATTERNS` (for example `AGENTMATE_QUOTA_PATTERNS="plan cap\|budget burned"`). |
| Duplicated or conflicting tools                     | A legacy registration (`serve codex` / `serve claude`) is still present. `doctor` flags it; see "Removed in 0.6.0".                    |

## Requirements

- Node.js 18 or later
- Claude Code and/or Codex CLI, authenticated
- The destination CLI available on the initiating host's `PATH`

## Removed in 0.6.0

The deprecated synchronous servers (`serve codex`, `serve claude`), the `setup` command, the `agentmate-codex` / `agentmate-claude` binaries and the legacy `/codex` and `/claude` setup skill are gone; the plugin and the `mate_*` job tools replace them.
To remove a leftover registration, run `claude mcp remove codex -s user` for Claude Code, or delete the `[mcp_servers.claude]` section from `~/.codex/config.toml` for Codex.
`npx -y agentmate doctor` flags both. See the [installation guide](./docs/INSTALL_FOR_AGENTS.md#removed-in-060-legacy-setup-installs) for the details.

## Development

```bash
git clone https://github.com/naldomadeira/agentmate.git
cd agentmate
pnpm install
pnpm build
pnpm test
pnpm lint
```

### Cutting a release

```bash
pnpm version:bump x.y.z          # package.json, src/lib/version.ts, both plugin manifests, the Codex marketplace
pnpm release:prepare             # version check, build, smoke:pack (real tarball install), smoke:cli
git commit -am "chore: release vx.y.z"
git tag vx.y.z
git push --follow-tags
```

The Release workflow runs on the tag: it fails when the tag does not match the package version, runs the checks, publishes through npm Trusted Publishing (no token) and verifies that the version appears on the registry.

Release notes are in the [changelog](./CHANGELOG.md).

## License

[MIT](./LICENSE)
