# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - Unreleased

### Added

- Inbox: every `important` job event of kind `message`, `finished` or `error` is also appended to `~/.agentmate/inbox.jsonl` (`{ ts, job, cwd, session?, provider, role, kind, text }`, owner-only, rotated to `inbox.1.jsonl` past 5 MB, one generation). `src/jobs/inbox.ts` reads it by directory (realpath, equal or subdirectory) with a read marker per directory in `~/.agentmate/inbox-cursors/`.
- MCP tool `mate_inbox(cwd?, unread?, ack?, limit?)` and CLI `agentmate inbox [--cwd] [--all] [--no-ack] [--follow]` (`--follow` prints new lines every second until Ctrl-C). The `jobs`, `teamlead`, `crossreview` and `split` skills and the `jobs` command templates tell Codex to call `mate_inbox` before `mate_wait` when it resumes a turn with jobs in progress.
- `UserPromptSubmit` hook for Claude Code (`hooks/user-prompt-submit.mjs`, registered in `hooks/hooks.json`): adds up to 5 unread inbox entries of the directory to the prompt context and advances the cursor; 10 s cooldown per directory, `AGENTMATE_HOOK_QUIET=1` to disable, fail-open. The `SessionStart` hook now also reports `N unread inbox entries`.
- `agentmate init` is registered in the CLI (`src/cli.ts`); the command itself ships with the init workstream.
- Gemini CLI as a third agent (experimental): `AgentId` and `AGENT_IDS` gain `gemini` (`src/agents/gemini.ts`, binary `AGENTMATE_GEMINI_BIN` or `gemini`). It runs `gemini -p <prompt> --output-format stream-json [--model m] [--resume sid] --approval-mode <mode>`: `default` for read-only and research jobs, `auto_edit` for write jobs, `yolo` for a team lead (`--sandbox` is never used). `src/lib/gemini-output-parser.ts` reads stream-json (`init`, `message` chunks, `tool_use`, `tool_result`, `error`, `result`) and the single object of `--output-format json`; the adapter turns the assistant chunks into one `message` event when the `result` arrives, `write_file`/`replace`/`edit` tool use into `file` events and every other tool use into `command` events. Written against the documented format and tested with a fake binary, because the Gemini CLI is not installed in the development environment. The `gemini` skill (`/mate:gemini`) routes by intent like `codex` and `claude`.
- Agent availability: `isAgentAvailable(id)` and `availableAgents()` (`src/agents/registry.ts`) look for the binary by absolute path or on `PATH` without running it. `startJob` refuses an agent that is not installed with `Agent gemini is not installed (binary "gemini" not found on PATH). Install it or set AGENTMATE_GEMINI_BIN.`
- `partner` on the `mate_teamlead`, `mate_crossreview` and `mate_split` tools, `StartOptions` and `jobs start --partner <agent>`: the agent that works with `provider` (reviewer, delegate, or the other half of a split). It must differ from `provider` and be installed; the default stays codex and claude paired with each other, and `claude` for a `gemini` provider. A split plan only assigns parts to the agents that are installed (or to the planner and its partner).
- `agentmate init [--cwd] [--check] [--create] [--files AGENTS.md,CLAUDE.md]` and the `init` skill (`/mate:init`): add or refresh a block of at most 25 lines between `<!-- agentmate:start -->` and `<!-- agentmate:end -->` (commands, the rules for a job received from another agent, `agentmate inbox` and `agentmate jobs list`). Existing files only unless `--create`; a second run changes nothing; `--check` writes nothing and exits 1 when a block is missing or old; a lone marker is an error that names the file (`src/lib/marked-section.ts`, `src/lib/init.ts`).

### Changed

- `agentmate doctor` prints one line per agent; a missing Gemini CLI is `ok  gemini  not installed (optional)` instead of a warning. The `jobs` help texts and the MCP tool descriptions list the three agents, and the zod enums derive from `AGENT_IDS`.
- `otherAgent()` keeps pairing codex with claude and now returns `claude` for `gemini`.

## [0.6.0] - Unreleased

### Added

- Sessions: shared context across jobs and agents. A session is `~/.agentmate/sessions/<id>/` with `session.json` and an append-only `notes.md`. A job started with a session (`session` on every MCP job tool, `jobs start --session <id>`) is recorded in it, recorded as `job.session`, and its prompt, for every role, is followed by the notes under `## Shared session notes`, fenced and framed as data rather than instructions, capped at 4000 characters of whole entries (a single note is capped at 2000). Membership is derived from the jobs; `session.json` has no `jobs` array. Children started by `crossreview` and `split` inherit the workflow's session.
- MCP tools `mate_session_start`, `mate_session_show`, `mate_session_notes` and `mate_session_list`, and the CLI `agentmate sessions start|show|notes|list`.
- `split` role: a workflow job where `provider` plans 1 to `maxParts` (2 to 4, default 3) independent parts with closed interfaces and no overlapping files, the parts run in parallel on both agents, and the other agent reviews each finished part. Read-only mode (default) runs a `research` job per part; write mode requires a git repository with a clean working tree (checked before the planner runs), creates a git worktree and branch per part from the recorded base commit (`git worktree add -b agentmate/<split-id>/<part-id> ~/.agentmate/worktrees/<split-id>/<part-id> <base-commit>`; no `node_modules`, `.env` or submodule contents), runs an `implement` job in it and commits the result automatically (`--no-verify`, gpg signing off). The report has the goal, a parts table with verdicts and branches, every worktree and branch with cleanup commands, `git merge` commands for approved parts only (conflicts are not resolved automatically), a `## Needs human` section for the other parts, and the `jobs result` commands. A failed part ends the workflow `error` naming the part after the others finish. `split` creates a session when none is given and writes its plan into the notes. Only a top-level session can start it.
- MCP tool `mate_split(provider, goal, acceptance?, maxParts?, mode?, cwd?, session?, model?, timeoutMinutes?, waitSeconds?)`, CLI `jobs start <provider> "<goal>" --role split [--max-parts N] [--mode write]`, the `split` skill (`/mate:split`, `$mate:split`) and the `split` command templates (bare `/split`, `/prompts:split`).

- `SessionStart` hook for Claude Code (`hooks/hooks.json`, `hooks/session-start.mjs`, auto-discovered by the plugin): when a session opens it prints one line (400 characters at most) with the jobs of that directory or its subdirectories that finished since the last session there (`quota_exhausted` first, marked "needs hand-off") and the running and stale counts. A pid counts as alive only when its `/proc/<pid>/cmdline`, if readable, mentions `worker`. 120 s per-directory cooldown, 24 h first-run window, `AGENTMATE_HOOK_QUIET=1` to disable, fail-open. Codex has no equivalent.
- Release scripts and CI gates: `scripts/bump-version.mjs` (`pnpm version:bump x.y.z` / `version:check`, validates every file before writing any), `scripts/smoke-pack.mjs` (tarball contents, then a real `npm pack` installed into a scratch project and run with `--version` and `--help`; fails with "run `pnpm build` first" when `dist/` is missing) and `scripts/smoke-built-cli.mjs`, all run by CI and the Release workflow. `pnpm release:prepare` runs the same gates locally. The Release workflow now fails when the tag does not match the package version, publishes through npm Trusted Publishing and verifies the package on the registry, deriving its name from `package.json`.
- README "Cutting a release" steps (English and Portuguese).
- Claude streams events: the adapter runs `claude -p --output-format stream-json --verbose` and `parseStreamLine` maps assistant text to `message` (`important`), `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool use to `file` (`status`), `Bash` and every other tool use to `command` (`fyi`) and an error result to `error`. `parseClaudeOutput` reads both stream-json and the legacy single JSON object (the last `result` event wins).
- `quota_exhausted` job status (terminal): a job whose provider reports a spent usage limit, quota or credits ends with `<provider> quota exhausted: <line>. Retry after the reset or start the job on <other agent>.`, and `jobs result` / `mate_result` print `Hand off: start the same job with provider <other>.`. Detection (`src/jobs/quota.ts`) is extendable with `AGENTMATE_QUOTA_PATTERNS`; a plain 429 is not exhaustion. `crossreview` and `split` end `error` with the child's hint when a step hits its quota.

### Changed

- `pnpm release` is now `scripts/bump-version.mjs`: a lockstep version bump over the five version files that does not commit, tag or publish. Run `pnpm release:prepare` for the checks, then commit, tag and push (the Release workflow publishes).
- The `SessionStart` hook is no longer declared in `.claude-plugin/plugin.json`; Claude Code auto-discovers `hooks/hooks.json`, and declaring both risked a duplicate-load warning.
- Cancelling a job cancels its non-terminal children first, recursively, so a workflow whose worker was killed leaves no orphan running.
- The package now exposes a single binary, `agentmate`. `serve` has only the `jobs` subcommand, and `tsdown` builds only `src/cli.ts` and `src/jobs-server.ts`.
- `doctor` keeps flagging legacy registrations, now for `agentmate serve codex|claude` and `agents-bridge-mcp serve codex|claude` alike, with the hint "remove it; the synchronous servers were removed in 0.6.0".
- Version 0.6.0 across `package.json`, `src/lib/version.ts`, both plugin manifests and the Codex marketplace.

### Removed

- The synchronous servers: `serve codex` and `serve claude` (`src/codex-server.ts`, `src/claude-server.ts`) and the `agentmate-codex` and `agentmate-claude` binaries, plus the `dev:codex-server` and `dev:claude-server` scripts.
- The `setup` command (`src/commands/setup.ts`), `setupClaude` / `setupCodex` and their helpers in `src/lib/installer.ts` (`install skill|agent|commands` stay), the deprecation notice (`src/lib/deprecation.ts`) and the project-local `.claude/skills/setup/` skill.
- `buildExplainCodePrompt` and `buildPlanPerfPrompt` (with `ExplainDepth` and `PerfMetric`), `CODEX_MODELS` and `CLAUDE_MODELS` (with their types) and `createProgressReporter` / `ProgressReporter`.
- The "Legacy setup" README section and the "Move from a legacy `setup` install" guide sections, replaced by short "Removed in 0.6.0" notes. To clean up a leftover registration, run `claude mcp remove codex -s user` or delete the `[mcp_servers.claude]` section from `~/.codex/config.toml`; `doctor` flags both.

## [0.5.0] - Unreleased

### Added

- Agent adapters in `src/agents/` (Codex and Claude behind one `AgentAdapter` interface and a registry); the runtime no longer branches on agent names.
- Job events: every job writes an append-only `events.jsonl` with `important`, `status` and `fyi` levels (started, message, file, command, finished, error). Codex events stream while the job runs; Claude, which has no stream, records one message at the end.
- MCP tool `mate_events` and CLI `jobs events <id> [--since <iso>] [--level <a,b>] [--follow]`.
- `mate_observe` and `jobs observe` accept `raw` / `--raw` to include the stdout/stderr tails, and `levels` / `--level` to widen the events.
- `docs/ARCHITECTURE.md` describing the runtime, adapters, jobs and events.
- `crossreview` role: a workflow job where `provider` implements (write mode) and the other agent reviews the uncommitted diff (read-only), as child jobs of one workflow, looping up to `maxRounds` (1 to 5, default 2). The reviewer must end with `Verdict: approve` or `Verdict: request-changes`: approve finishes, request-changes continues the implementer's session with the findings, no clear verdict stops with a `## Needs human` section, and a failed child fails the workflow. The report has the rounds table, the final review and the changes; `job.workflow` records the rounds. Only a top-level session can start it.
- MCP tool `mate_crossreview(provider, task, acceptance?, maxRounds?, cwd?, model?, timeoutMinutes?, waitSeconds?)`, CLI `jobs start <provider> "<task>" --role crossreview [--max-rounds N]`, the `crossreview` skill (`/mate:crossreview`, `$mate:crossreview`) and the `crossreview` command templates (bare `/crossreview`, `/prompts:crossreview`).

### Changed

- The review prompt now requires its last line to be exactly `Verdict: approve` or `Verdict: request-changes`, so workflows can parse it.
- `observe` shows filtered events (`important` and `status`, last 30) instead of the raw stdout/stderr tails; pass `raw` for the tails.
- `cancel` kills the whole worker process group, so grandchildren do not outlive a canceled job.
- `AGENTMATE_HOME=""` is treated as unset.
- A recycled PID is no longer mistaken for a live worker (the process command line must match the job).

### Deprecated

- The synchronous servers (`serve codex`, `serve claude`) and `setup` print a deprecation warning to stderr and will be removed in 0.6.0. Install the plugin (`mate@agentmate`) and use the `mate_*` job tools instead. Behavior is unchanged in 0.5.0.

## [0.4.0] - 2026-10-03

### Changed / Breaking

- The project is renamed from Agents Bridge to **AgentMate** — *AI agents work better together.* AgentMate connects AI coding agents so they can collaborate, delegate, review, and help each other complete tasks.
- npm package `agents-bridge-mcp` → `agentmate` (`npx -y agentmate doctor`); the legacy synchronous-server bins `abm-claude` / `abm-codex` → `agentmate-claude` / `agentmate-codex`.
- Marketplace `agents-bridge` → `agentmate`, plugin `bridge` → `mate`: the install id is `mate@agentmate` and the commands are `/mate:<skill>` in Claude Code and `$mate:<skill>` in Codex. Agents are `mate:codex-reviewer` and so on.
- MCP server key `agents-bridge` → `agentmate`, tools `bridge_*` → `mate_*`.
- State directory `~/.agents-bridge` → `~/.agentmate` (`AGENTMATE_HOME`); environment variables `AGENTS_BRIDGE_*` and `BRIDGE_*` → `AGENTMATE_*` (`AGENTMATE_SYNC_DEPTH`, `AGENTMATE_TIMEOUT_MS`, `AGENTMATE_MAX_RETRIES`, `AGENTMATE_DEBUG`, `AGENTMATE_CLAUDE_WRITE_TOOLS`, `AGENTMATE_<PROVIDER>_BIN`). Existing jobs are not migrated.
- The repository moves to `naldomadeira/agentmate`.
- Migrating from 0.3.0 or earlier: remove the old plugin (`bridge@agents-bridge`, or `agents-bridge@agents-bridge` from 0.2.0) and the `agents-bridge` marketplace, install `mate@agentmate` and restart the host. `doctor` still detects legacy `agents-bridge-mcp serve` registrations.

## [0.3.0] - 2026-10-03

### Changed / Breaking

- The plugin is renamed from `agents-bridge` to `bridge`, following the `agy` plugin pattern: the plugin name is the command namespace in both hosts. The marketplace stays `agents-bridge` and the npm package stays `agents-bridge-mcp`. The install id changes from `agents-bridge@agents-bridge` to `bridge@agents-bridge` (`claude plugin install bridge@agents-bridge`, `codex plugin add bridge@agents-bridge`), and the commands change from `/agents-bridge:<skill>` to `/bridge:<skill>` in Claude Code and from `$<skill>` to `$bridge:<skill>` in Codex. The MCP server key stays `agents-bridge`, so `bridge_*` tool names are unchanged.
- Migrating from 0.2.0: remove the old plugin (`claude plugin uninstall agents-bridge@agents-bridge`; in Codex, remove the `agents-bridge@agents-bridge` plugin, see `codex plugin --help` for the exact verb), install `bridge@agents-bridge` and restart the host.
- Update commands are now `claude plugin marketplace update agents-bridge && claude plugin update bridge@agents-bridge` and `codex plugin marketplace upgrade agents-bridge && codex plugin add bridge@agents-bridge`.
- Every skill description now lists trigger phrases (for example `/bridge:ask`, "ask codex", "pergunte ao claude") so the model selects the skill on its own.
- README (English and Portuguese) is restructured: an "Invoke a role" subsection, a "For agents" snippet that points at the raw install guide, an "Upgrade" subsection and a "Use cases" table. The "Slash commands" section lists `/bridge:ask` and `$bridge:ask` as the plugin forms; bare `/ask` and `/prompts:ask` remain optional extras. Both installation guides gain a migration note.
- npm package, plugin manifests and marketplace moved to 0.3.0.

### Added

- Slash-command templates in a new `templates/` directory (shipped in the npm package, not scanned by either host): `templates/claude-commands/` for Claude Code and `templates/codex-prompts/` for Codex, each with `ask`, `review`, `research`, `plan`, `implement`, `teamlead` and `jobs`.
- `install commands <claude|codex|both> [--global|--local]` copies them: bare `/ask`, `/review`, ... to `~/.claude/commands/` (or `./.claude/commands/`) for Claude Code, and `/prompts:ask`, `/prompts:review`, ... to `$CODEX_HOME/prompts/` (default `~/.codex/prompts/`) for Codex. Codex custom prompts are user-level only, so the local scope installs them globally. It asks before overwriting and prints the installed command names.
- The README notes that OpenAI marks Codex custom prompts deprecated in favour of skills, and both installation guides document the optional `install commands` step.

## [0.2.0] - 2026-10-03

### Added

- Job roles: `ask`, `review`, `research`, `plan`, `implement` and `teamlead` (plus `custom` for a raw prompt). Each role sends a purpose-built prompt with a defined output format and runs with role-specific permissions.
- MCP tools `bridge_ask` (waits for the answer, up to 120 seconds by default), `bridge_review`, `bridge_research`, `bridge_plan`, `bridge_implement` and `bridge_teamlead`. `bridge_start` accepts `role`, `bridge_list` accepts `parent`, and `bridge_observe` lists the child jobs of a team lead.
- Team lead mode: a worker that decomposes an objective, delegates to the other provider through the CLI, reviews the results and returns a structured report. Jobs record `depth` and `parentJob`.
- CLI: `jobs start --role`, `jobs ask <provider> "<question>" [--wait 120s]`, `jobs list --parent <id>`, and a `children` section in `jobs observe`.
- `doctor` command: checks Node.js, that the `codex` and `claude` CLIs exist and respond to `--version`, the job state directory, stale `running` jobs (it lists their ids) and legacy registrations, and exits `1` when a check fails. It does not check authentication.
- Skills `ask`, `review`, `research`, `plan`, `implement`, `teamlead` and `jobs`, shared by Claude Code and Codex.
- Claude Code agents `codex-reviewer`, `codex-researcher` and `codex-teamlead`.
- Claude research jobs can use `WebSearch` and `WebFetch`.
- `src/lib/version.ts` as the single source of the runtime version.
- This changelog and a rewritten README with a quickstart, a role matrix, a safety model and troubleshooting.

### Changed

- The `codex` and `claude` skills and the `codex-teammate` agent now route to the `bridge_*` job tools instead of the legacy synchronous `mcp__codex__*` and `mcp__claude__*` tools. They fall back to the `npx -y agents-bridge-mcp jobs` CLI when MCP is not loaded.
- The `delegate` skill points to the role skills and documents the delegation depth limit of 2.
- Codex jobs run with `--skip-git-repo-check` and a sandbox that follows the mode: `read-only`, `workspace-write` for `write`, and `danger-full-access` only for a Codex team lead.
- The `.claude/skills/setup` skill presents the plugin install first and is labeled legacy.
- npm package description, keywords and `repository.url` (now `git+https://...`); plugin manifests and marketplaces moved to 0.2.0.
- `implement` (`--role implement`, `bridge_implement`) always runs in write mode; passing `read-only` is rejected.
- Write-mode Claude jobs (`implement`, write `teamlead`) run with `acceptEdits` plus an allowlist for verification commands: the read-only list plus `pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add` and `git commit`. Extend it with `AGENTS_BRIDGE_CLAUDE_WRITE_TOOLS` (comma-separated Claude permission patterns).
- A Claude team lead's CLI access is limited to `agents-bridge-mcp jobs *`, pinned to the installed version (no `setup` or `install`). The team lead prompt pins the CLI version, writes briefings in a single-quoted heredoc and waits with `--timeout 90s`, repeating on exit code 2.
- Stored job `depth` is 0 for a job started by a session and 1 for a job started by a worker; the documentation and diagrams now use this numbering.
- `jobs start --timeout` must be a positive number of minutes (at most 120) and is validated.
- The skills and README tell Codex callers to pass `waitSeconds: 45` to `bridge_ask`, because Codex limits an MCP tool call to about 60 seconds by default.

### Fixed

- Claude jobs with a tool allowlist passed `--allowedTools` in a form that swallowed the prompt, so every such job failed. The allowlist and the prompt are now passed separately.
- `npx -y agents-bridge-mcp --version` now prints the version.
- `doctor` lists the ids of stale `running` jobs instead of only counting them.

### Security

- Delegation depth limit of 2 (`AGENTS_BRIDGE_DEPTH`): a session starts a team lead, the lead starts children, and children cannot start jobs. The runtime refuses a third level and refuses a team lead started by a worker.
- Jobs remain read-only by default. `implement` always runs in write mode; a team lead writes only when started with `mode: write`.
- Read-only Claude jobs (`ask`, `review`, `plan`, `research`, read-only `teamlead`) run with an allowlist and an explicit deny of `Edit`, `Write` and `NotebookEdit`.
- A Codex team lead runs with `--sandbox danger-full-access` in either mode, because it must spawn worker processes and write job state. In read-only mode the runtime refuses any `write` child job (a read-only parent cannot start write children) and the prompt forbids edits, but the lead itself is not sandboxed. Use `claude` as lead when that matters.
- Files under `~/.agents-bridge` are created owner-only (`0600` for files, `0700` for directories).

## [0.1.0]

### Added

- Background job runtime with MCP tools `bridge_start`, `bridge_wait`, `bridge_observe`, `bridge_result`, `bridge_cancel` and `bridge_list`, and the matching `jobs` CLI commands.
- Delegation to `codex` or `claude`, with a `read-only` default mode, `write` mode, timeouts and session continuation (`--continue`).
- Hybrid plugin for Claude Code and Codex with the `delegate` skill and the jobs MCP server.
- Synchronous bridge servers (`serve codex`, `serve claude`), the legacy `setup` command, and the `/codex` and `/claude` shortcuts.
- Bilingual documentation (English and Brazilian Portuguese) and an installation guide.
