# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
