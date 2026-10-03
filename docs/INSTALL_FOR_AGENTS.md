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
claude plugin install agents-bridge@agents-bridge
```

Restart Claude Code. The installed plugin exposes the skills as `/agents-bridge:ask`, `/agents-bridge:review` and so on, adds the four agents, and starts only the jobs MCP server.

### Codex

```bash
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Restart Codex. The plugin provides the skills (mention one with `$ask`, or use the skills menu) and the `bridge_*` tools without a manual `config.toml` edit.

### Local development

Point each host at the checkout while testing unpublished changes:

```bash
claude plugin marketplace add /absolute/path/to/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge

codex plugin marketplace add /absolute/path/to/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Remove a local marketplace before adding the remote repository under the same name.

## Upgrade

```bash
# Claude Code
claude plugin marketplace update agents-bridge
claude plugin update agents-bridge@agents-bridge

# Codex
codex plugin marketplace upgrade agents-bridge
```

Restart the host after an upgrade. Confirm the active plugin with `claude plugin list` or `codex plugin list`; check the CLI version with `npx -y agents-bridge-mcp --version`. Version 0.2.0 adds the role skills and tools; see the [changelog](../CHANGELOG.md).

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

Jobs are read-only by default. Pass `mode: write` or `--mode write` only for an explicitly authorized editing task; the `implement` skill and `bridge_implement` do this for you.

## Run the doctor

```bash
npx -y agents-bridge-mcp doctor
```

`doctor` checks that Node.js is 18 or later, that `codex` and `claude` are on `PATH` (with versions when available), that the job state directory is writable, how many jobs exist and whether any `running` job lost its worker, and whether a legacy `setup` registration is still present. Each item is reported as `ok`, `warn` or `fail` with a hint. It exits `1` if any item fails, and it works when `codex` or `claude` is not installed (reported as a warning).

## Diagnose an installation

1. Run `npx -y agents-bridge-mcp doctor` and follow its hints.
2. Run `claude plugin list` or `codex plugin list` and confirm that `agents-bridge@agents-bridge` is enabled.
3. Restart the host after any install or update; a running session does not reload skills or tools.
4. Run `npx -y agents-bridge-mcp jobs list` to confirm the CLI fallback is available.
5. If a job fails, confirm that the destination CLI is authenticated and reachable on `PATH`.
6. If MCP is unavailable while the CLI works, use the fallback. Do not register an MCP server automatically.

## Move from a legacy `setup` install

`npx -y agents-bridge-mcp setup` remains supported for existing users, but plugins are the supported installation path. Legacy setup may have registered synchronous servers and installed `/codex` and `/claude` shortcuts. `doctor` reports these registrations as warnings.

Before removing anything, inspect `claude mcp list`, `claude plugin list`, `codex plugin list`, and the candidate files. Remove only entries that point exactly to `agents-bridge-mcp serve codex` or `agents-bridge-mcp serve claude`:

- Claude Code: `claude mcp remove codex -s user` removes the legacy server with that name.
- Codex: remove only the `[mcp_servers.claude]` section that contains `agents-bridge-mcp serve claude` from `~/.codex/config.toml`.
- Legacy skills and agent: remove only recognized, unmodified copies of `.claude/skills/codex/`, `.claude/agents/codex-teammate.md`, and `.agents/skills/claude/`.

Do not remove entries with another name, origin, or customized content. Install the plugin and restart the host before cleaning legacy entries so a working delegation route remains available.
