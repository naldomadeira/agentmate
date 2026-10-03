# Install Agents Bridge as a plugin

[Português (Brasil)](./INSTALL_FOR_AGENTS.pt-BR.md)

Agents Bridge packages ten skills (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `jobs`, `delegate`, `codex`, `claude`) with a background-jobs MCP server, and in Claude Code four agents that wrap Codex (`codex-teammate`, `codex-reviewer`, `codex-researcher`, `codex-teamlead`). When MCP is not available in a host session, the skills use the package CLI and preserve the same start, wait, result, observe, and cancel workflow.

## Requirements

- Node.js 18 or later
- An authenticated Claude Code or Codex CLI
- Network access to npm for `npx -y agents-bridge-mcp`
- The CLI that receives delegated work available on the initiating host's `PATH`

## Install on a clean machine

### Claude Code

```bash
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install bridge@agents-bridge
```

Restart Claude Code. The installed plugin exposes the skills as `/bridge:ask`, `/bridge:review` and so on, adds the four agents, and starts only the jobs MCP server.

### Codex

```bash
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add bridge@agents-bridge
```

Restart Codex. The plugin provides the skills (type `$bridge:ask`, or `$bridge` to filter them all, or pick one from the `/skills` menu) and the `bridge_*` tools without a manual `config.toml` edit.

### Migrating from 0.2.0

The plugin was renamed from `agents-bridge` to `bridge`, so its install id changed. Remove the old plugin: `claude plugin uninstall agents-bridge@agents-bridge`; in Codex, remove the `agents-bridge@agents-bridge` plugin with `codex plugin --help` for the exact verb.
Then install `bridge@agents-bridge` as above and restart the host.
Commands are now `/bridge:ask` in Claude Code and `$bridge:ask` in Codex.

### Optional: slash commands

Plugin skills are always namespaced in Claude Code, and Codex plugins cannot ship slash commands. To get shorter commands, install the command templates that ship in the npm package:

```bash
# Claude Code: bare /ask, /review, /research, /plan, /implement, /teamlead, /jobs
npx -y agents-bridge-mcp install commands claude --global

# Codex: /prompts:ask, /prompts:review, ... (restart Codex afterwards)
npx -y agents-bridge-mcp install commands codex

# Both hosts
npx -y agents-bridge-mcp install commands both --global
```

Claude Code commands go to `~/.claude/commands/` (`--local`: `./.claude/commands/`); Codex prompts go to `$CODEX_HOME/prompts/` (default `~/.codex/prompts/`) and are always user-level. The installer asks before overwriting an existing file and prints the command names it installed. OpenAI marks Codex custom prompts deprecated in favour of skills; they still work, and the `$bridge:ask` skill needs no extra install.

### Local development

Point each host at the checkout while testing unpublished changes:

```bash
claude plugin marketplace add /absolute/path/to/agents-bridge-mcp
claude plugin install bridge@agents-bridge

codex plugin marketplace add /absolute/path/to/agents-bridge-mcp
codex plugin add bridge@agents-bridge
```

Remove a local marketplace before adding the remote repository under the same name. Team lead mode runs the CLI pinned to the installed version (`npx -y agents-bridge-mcp@<version> jobs ...`), so an unpublished local checkout must be published or linked before team lead jobs work.

## Upgrade

```bash
# Claude Code
claude plugin marketplace update agents-bridge && claude plugin update bridge@agents-bridge

# Codex
codex plugin marketplace upgrade agents-bridge && codex plugin add bridge@agents-bridge
```

Restart the host after an upgrade. Confirm the active plugin with `claude plugin list` or `codex plugin list`; check the CLI version with `npx -y agents-bridge-mcp --version`. Hosts cache the plugin per version, so the new version only appears after the restart. See the [changelog](../CHANGELOG.md) for what changed.

## Smoke test

After restarting, ask the other CLI a short read-only question. With MCP available, call `bridge_ask` with `provider` set to `codex` or `claude` and a question such as `Reply only with OK`. It waits for the answer and returns it in the same call.

Without MCP, use the CLI fallback:

```bash
npx -y agents-bridge-mcp jobs ask codex "Reply only with OK" --wait 120s
```

`jobs ask` prints the answer. If the wait expires it prints the job ID and leaves the job running; collect it with `jobs wait <id>`.

To exercise the generic job path as well, start and wait explicitly. With MCP, call `bridge_start` with `mode` set to `read-only`, then `bridge_wait` with the same job ID. Without MCP:

```bash
npx -y agents-bridge-mcp jobs start codex "Reply only with OK"
# retain the printed ID
npx -y agents-bridge-mcp jobs wait <id>
```

`wait` and `ask` exit `0` when complete, `1` when failed or canceled, and `2` when the wait expires. Exit code `2` leaves the job running; repeat the same wait. Use `jobs result <id>` after an interrupted wait. Request progress with `bridge_observe` or `jobs observe <id>` only when a person asks for it.

Jobs are read-only by default. The `implement` skill and `bridge_implement` always run in write mode (read-only is rejected), so use them only for an explicitly authorized editing task. For any other role, pass `mode: write` or `--mode write` only when the task is explicitly allowed to edit files.

## Run the doctor

```bash
npx -y agents-bridge-mcp doctor
```

`doctor` checks that Node.js is 18 or later, that `codex` and `claude` are on `PATH` and respond to `--version`, that the job state directory is writable, how many jobs exist and which `running` jobs lost their worker (it lists their ids), and whether a legacy `setup` registration is still present. Each item is reported as `ok`, `warn` or `fail` with a hint. It exits `1` if any item fails, and it works when `codex` or `claude` is not installed (reported as a warning). It does not check authentication: if a job fails right away, log in to the destination CLI yourself.

## Diagnose an installation

1. Run `npx -y agents-bridge-mcp doctor` and follow its hints.
2. Run `claude plugin list` or `codex plugin list` and confirm that `bridge@agents-bridge` is enabled.
3. Restart the host after any install or update; a running session does not reload skills or tools.
4. Run `npx -y agents-bridge-mcp jobs list` to confirm the CLI fallback is available.
5. If a job fails, confirm that the destination CLI is reachable on `PATH` (`doctor` checks this) and authenticated (`doctor` does not check this).
6. If MCP is unavailable while the CLI works, use the fallback. Do not register an MCP server automatically.

## Move from a legacy `setup` install

`npx -y agents-bridge-mcp setup` remains supported for existing users, but plugins are the supported installation path. Legacy setup may have registered synchronous servers and installed `/codex` and `/claude` shortcuts. `doctor` reports these registrations as warnings.

Before removing anything, inspect `claude mcp list`, `claude plugin list`, `codex plugin list`, and the candidate files. Remove only entries that point exactly to `agents-bridge-mcp serve codex` or `agents-bridge-mcp serve claude`:

- Claude Code: `claude mcp remove codex -s user` removes the legacy server with that name.
- Codex: remove only the `[mcp_servers.claude]` section that contains `agents-bridge-mcp serve claude` from `~/.codex/config.toml`.
- Legacy skills and agent: remove only recognized, unmodified copies of `.claude/skills/codex/`, `.claude/agents/codex-teammate.md`, and `.agents/skills/claude/`.

Do not remove entries with another name, origin, or customized content. Install the plugin and restart the host before cleaning legacy entries so a working delegation route remains available.
