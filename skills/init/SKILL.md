---
name: init
description: Set up AgentMate in a repository by adding or refreshing a short marked block in AGENTS.md and CLAUDE.md that tells every agent the /mate: commands and the rules for jobs it receives. Use when the user says /mate:init, 'set up agentmate in this repo', 'configurar o agentmate', 'prepare this repo for agentmate'.
argument-hint: "[--check] [--create] [--files AGENTS.md,CLAUDE.md]"
---

# Set up a repository

Writes a short block between `<!-- agentmate:start -->` and `<!-- agentmate:end -->` in the repository's `AGENTS.md` and `CLAUDE.md`, so any agent that opens the repo knows the AgentMate commands and how to behave when it receives a job. Text outside the markers is never touched, and running it twice changes nothing.

## Run it

```bash
npx -y agentmate init                 # update the files that exist
npx -y agentmate init --create        # start AGENTS.md and a CLAUDE.md that imports it
npx -y agentmate init --check         # change nothing; exit 1 if a block is missing or old
npx -y agentmate init --cwd <dir> --files AGENTS.md,CLAUDE.md
```

Each file is reported as `created`, `updated`, `already up to date`, `not found` or `out of date`.

## Rules

- Run it from the repository root (or pass `--cwd`), and show the user which files changed. Do not commit them unless asked.
- Without `--create` it never makes a new file. If neither file exists, ask whether to run `agentmate init --create`.
- Claude Code does not read `AGENTS.md` natively. `--create` therefore writes `AGENTS.md` and a `CLAUDE.md` that starts with `@AGENTS.md` (Claude Code imports it) followed by the block.
- A file with CRLF line endings keeps them; markers are matched only when alone on their line.
- A marker without its partner stops the run with an error naming the file. Do not edit the markers for the user; tell them what to fix.
- `--check` suits CI or a pre-commit hook. After upgrading AgentMate, run `init` again to refresh the block.
