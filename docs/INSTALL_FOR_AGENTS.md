# Install AgentMate as a plugin

[Português (Brasil)](./INSTALL_FOR_AGENTS.pt-BR.md)

AgentMate packages fifteen skills (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `crossreview`, `split`, `jobs`, `delegate`, `codex`, `claude`, `gemini`, `agy`, `init`) with a background-jobs MCP server, and in Claude Code four agents that wrap Codex (`codex-teammate`, `codex-reviewer`, `codex-researcher`, `codex-teamlead`). When MCP is not available in a host session, the skills use the package CLI and preserve the same start, wait, result, observe, and cancel workflow.

## Requirements

- Node.js 18 or later
- An authenticated Claude Code or Codex CLI; Gemini CLI and Antigravity CLI (`agy`; install with `curl -fsSL https://antigravity.google/cli/install.sh | bash`) are optional and experimental
- Network access to npm for `npx -y agentmate`
- The CLI that receives delegated work available on the initiating host's `PATH`

## Install on a clean machine

### Claude Code

```bash
claude plugin marketplace add naldomadeira/agentmate
claude plugin install mate@agentmate
```

Restart Claude Code. The installed plugin exposes the skills as `/mate:ask`, `/mate:review` and so on, adds the four agents, and starts only the jobs MCP server.

### Codex

```bash
codex plugin marketplace add naldomadeira/agentmate
codex plugin add mate@agentmate
```

Restart Codex. The plugin provides the skills (type `$mate:ask`, or `$mate` to filter them all, or pick one from the `/skills` menu) and the `mate_*` tools without a manual `config.toml` edit.

### Migrating from Agents Bridge (0.3.0 or earlier)

The project was renamed to AgentMate: npm package `agentmate`, plugin `mate`, tools `mate_*`, state directory `~/.agentmate`, environment variables `AGENTMATE_*`. Remove the old plugin (`claude plugin uninstall bridge@agents-bridge`, or `agents-bridge@agents-bridge` from 0.2.0) and the old marketplace (`claude plugin marketplace remove agents-bridge`); in Codex, remove both with `codex plugin --help` for the exact verbs.
Then install `mate@agentmate` as above and restart the host. Jobs stored in `~/.agents-bridge` are not migrated.
Commands are now `/mate:ask` in Claude Code and `$mate:ask` in Codex.

### Optional: slash commands

Plugin skills are always namespaced in Claude Code, and Codex plugins cannot ship slash commands. To get shorter commands, install the command templates that ship in the npm package:

```bash
# Claude Code: bare /ask, /review, /research, /plan, /implement, /teamlead, /jobs
npx -y agentmate install commands claude --global

# Codex: /prompts:ask, /prompts:review, ... (restart Codex afterwards)
npx -y agentmate install commands codex

# Both hosts
npx -y agentmate install commands both --global
```

Claude Code commands go to `~/.claude/commands/` (`--local`: `./.claude/commands/`); Codex prompts go to `$CODEX_HOME/prompts/` (default `~/.codex/prompts/`) and are always user-level. The installer asks before overwriting an existing file and prints the command names it installed. OpenAI marks Codex custom prompts deprecated in favour of skills; they still work, and the `$mate:ask` skill needs no extra install.

### Local development

Point each host at the checkout while testing unpublished changes:

```bash
claude plugin marketplace add /absolute/path/to/agentmate
claude plugin install mate@agentmate

codex plugin marketplace add /absolute/path/to/agentmate
codex plugin add mate@agentmate
```

Remove a local marketplace before adding the remote repository under the same name. Team lead mode runs the CLI pinned to the installed version (`npx -y agentmate@<version> jobs ...`), so an unpublished local checkout must be published or linked before team lead jobs work.

## Upgrade

```bash
# Claude Code
claude plugin marketplace update agentmate && claude plugin update mate@agentmate

# Codex
codex plugin marketplace upgrade agentmate && codex plugin add mate@agentmate
```

Restart the host after an upgrade. Confirm the active plugin with `claude plugin list` or `codex plugin list`; check the CLI version with `npx -y agentmate --version`. Hosts cache the plugin per version, so the new version only appears after the restart. See the [changelog](../CHANGELOG.md) for what changed.

## Smoke test

After restarting, ask the other CLI a short read-only question. With MCP available, call `mate_ask` with `provider` set to `codex`, `claude`, `gemini` or `agy` (the last two experimental) and a question such as `Reply only with OK`. It waits for the answer and returns it in the same call.

Without MCP, use the CLI fallback:

```bash
npx -y agentmate jobs ask codex "Reply only with OK" --wait 120s
```

`jobs ask` prints the answer. If the wait expires it prints the job ID and leaves the job running; collect it with `jobs wait <id>`.

To exercise the generic job path as well, start and wait explicitly. With MCP, call `mate_start` with `mode` set to `read-only`, then `mate_wait` with the same job ID. Without MCP:

```bash
npx -y agentmate jobs start codex "Reply only with OK"
# retain the printed ID
npx -y agentmate jobs wait <id>
```

`wait` and `ask` exit `0` when complete, `1` when failed or canceled, and `2` when the wait expires. Exit code `2` leaves the job running; repeat the same wait. Use `jobs result <id>` after an interrupted wait. Request progress with `mate_observe` or `jobs observe <id>` only when a person asks for it.

Jobs are read-only by default. The `implement` skill and `mate_implement` always run in write mode (read-only is rejected), so use them only for an explicitly authorized editing task. For any other role, pass `mode: write` or `--mode write` only when the task is explicitly allowed to edit files.

## Run the doctor

```bash
npx -y agentmate doctor
```

`doctor` checks that Node.js is 18 or later, that `codex`, `claude`, `gemini` and `agy` (the last two optional and experimental) are on `PATH` and respond to `--version`, that the job state directory is writable, how many jobs exist and which `running` jobs lost their worker (it lists their ids), and whether a legacy `serve codex` / `serve claude` registration is still present. Each item is reported as `ok`, `warn` or `fail` with a hint. It exits `1` if any item fails, and it works when `codex` or `claude` is not installed (reported as a warning; a missing `gemini` is reported as ok). It does not check authentication: if a job fails right away, log in to the destination CLI yourself.

## Diagnose an installation

1. Run `npx -y agentmate doctor` and follow its hints.
2. Run `claude plugin list` or `codex plugin list` and confirm that `mate@agentmate` is enabled.
3. Restart the host after any install or update; a running session does not reload skills or tools.
4. Run `npx -y agentmate jobs list` to confirm the CLI fallback is available.
5. If a job fails, confirm that the destination CLI is reachable on `PATH` (`doctor` checks this) and authenticated (`doctor` does not check this).
6. If MCP is unavailable while the CLI works, use the fallback. Do not register an MCP server automatically.

## Removed in 0.6.0: legacy `setup` installs

The deprecated `npx -y agentmate setup` command, the synchronous servers (`serve codex`, `serve claude`) and the `agentmate-codex` / `agentmate-claude` binaries were removed in 0.6.0. Plugins are the only installation path. `doctor` still warns when a leftover registration is present.

Before removing anything, inspect `claude mcp list`, `claude plugin list`, `codex plugin list`, and the candidate files. Remove only entries that point exactly to `agents-bridge-mcp serve codex` or `agents-bridge-mcp serve claude` (or `agentmate serve ...`):

- Claude Code: `claude mcp remove codex -s user` removes the legacy server with that name.
- Codex: remove only the `[mcp_servers.claude]` section that contains `agents-bridge-mcp serve claude` or `agentmate serve claude` from `~/.codex/config.toml`.
- Legacy skills and agent: remove only recognized, unmodified copies of `.claude/skills/codex/`, `.claude/agents/codex-teammate.md`, and `.agents/skills/claude/`.

Do not remove entries with another name, origin, or customized content. Install the plugin and restart the host before cleaning leftover entries so a working delegation route remains available.
