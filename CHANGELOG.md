# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-03

### Added

- Job roles: `ask`, `review`, `research`, `plan`, `implement` and `teamlead` (plus `custom` for a raw prompt). Each role sends a purpose-built prompt with a defined output format and runs with role-specific permissions.
- MCP tools `bridge_ask` (waits for the answer, up to 120 seconds by default), `bridge_review`, `bridge_research`, `bridge_plan`, `bridge_implement` and `bridge_teamlead`. `bridge_start` accepts `role`, `bridge_list` accepts `parent`, and `bridge_observe` lists the child jobs of a team lead.
- Team lead mode: a worker that decomposes an objective, delegates to the other provider through the CLI, reviews the results and returns a structured report. Jobs record `depth` and `parentJob`.
- CLI: `jobs start --role`, `jobs ask <provider> "<question>" [--wait 120s]`, `jobs list --parent <id>`, and a `children` section in `jobs observe`.
- `doctor` command: checks Node.js, the `codex` and `claude` CLIs, the job state directory, stuck jobs and legacy registrations, and exits `1` when a check fails.
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

### Security

- Delegation depth limit of 2 (`AGENTS_BRIDGE_DEPTH`): only a top-level session can start a team lead, and delegated workers cannot delegate further.
- Jobs remain read-only by default. `implement` is the only role that writes unless a team lead is started with `mode: write`.

## [0.1.0]

### Added

- Background job runtime with MCP tools `bridge_start`, `bridge_wait`, `bridge_observe`, `bridge_result`, `bridge_cancel` and `bridge_list`, and the matching `jobs` CLI commands.
- Delegation to `codex` or `claude`, with a `read-only` default mode, `write` mode, timeouts and session continuation (`--continue`).
- Hybrid plugin for Claude Code and Codex with the `delegate` skill and the jobs MCP server.
- Synchronous bridge servers (`serve codex`, `serve claude`), the legacy `setup` command, and the `/codex` and `/claude` shortcuts.
- Bilingual documentation (English and Brazilian Portuguese) and an installation guide.
