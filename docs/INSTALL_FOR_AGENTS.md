# Install Agents Bridge as a plugin

[Português (Brasil)](./INSTALL_FOR_AGENTS.pt-BR.md)

Agents Bridge packages the `delegate` skill with a background-jobs MCP server. When MCP is not available in a host session, the skill uses the package CLI and preserves the same start, wait, result, observe, and cancel workflow.

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

Restart Claude Code. The installed plugin exposes `agents-bridge:delegate` and starts only the jobs MCP server.

### Codex

```bash
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Restart Codex. The plugin provides the `delegate` skill and `bridge_*` tools without a manual `config.toml` edit.

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

Restart the host after an upgrade. Confirm the active plugin with `claude plugin list` or `codex plugin list`; check the CLI version with `npx -y agents-bridge-mcp --version`.

## Smoke test

After restarting, delegate a short read-only task to the other CLI. With MCP available, call `bridge_start` with `provider` set to `codex` or `claude`, `mode` set to `read-only`, and a prompt such as `Reply only with OK`. Call `bridge_wait` with the same job ID.

Without MCP, use the CLI fallback:

```bash
npx -y agents-bridge-mcp jobs start codex "Reply only with OK"
# retain the printed ID
npx -y agents-bridge-mcp jobs wait <id>
```

`wait` exits `0` when complete, `1` when failed or canceled, and `2` when the wait expires. Exit code `2` leaves the job running; repeat the same wait. Use `jobs result <id>` after an interrupted wait. Request progress with `bridge_observe` or `jobs observe <id>` only when a person asks for it.

Jobs are read-only by default. Pass `mode: write` or `--mode write` only for an explicitly authorized editing task.

## Diagnose an installation

1. Run `claude plugin list` or `codex plugin list` and confirm that `agents-bridge@agents-bridge` is enabled.
2. Restart the host after any install or update; a running session does not reload skills or tools.
3. Run `npx -y agents-bridge-mcp jobs list` to confirm the CLI fallback is available.
4. If a job fails, confirm that the destination CLI is authenticated and reachable on `PATH`.
5. If MCP is unavailable while the CLI works, use the fallback. Do not register an MCP server automatically.

## Move from a legacy `setup` install

`npx -y agents-bridge-mcp setup` remains supported for existing users, but plugins are the supported installation path. Legacy setup may have registered synchronous servers and installed `/codex` and `/claude` shortcuts.

Before removing anything, inspect `claude mcp list`, `claude plugin list`, `codex plugin list`, and the candidate files. Remove only entries that point exactly to `agents-bridge-mcp serve codex` or `agents-bridge-mcp serve claude`:

- Claude Code: `claude mcp remove codex -s user` removes the legacy server with that name.
- Codex: remove only the `[mcp_servers.claude]` section that contains `agents-bridge-mcp serve claude` from `~/.codex/config.toml`.
- Legacy skills and agent: remove only recognized, unmodified copies of `.claude/skills/codex/`, `.claude/agents/codex-teammate.md`, and `.agents/skills/claude/`.

Do not remove entries with another name, origin, or customized content. Install the plugin and restart the host before cleaning legacy entries so a working delegation route remains available.
