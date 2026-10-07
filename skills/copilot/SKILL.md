---
name: copilot
description: Route a task or question to the GitHub Copilot CLI, experimental (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching AgentMate tool. Use when the user says /mate:copilot, 'ask copilot', 'check with copilot', 'hand this to copilot', 'pergunte ao copilot', or names GitHub Copilot.
argument-hint: "<task or question>"
---

# Work with the GitHub Copilot CLI (experimental)

Experimental; requires the `copilot` CLI on PATH (or `AGENTMATE_COPILOT_BIN`). Needs `copilot login` once. Check with `npx -y agentmate doctor`; a job on a missing agent is refused with an install hint (`npm install -g @github/copilot` or `brew install copilot-cli`). Shortcut for "do this with copilot". Read the user's request, pick the role it matches and run the matching `mate_*` tool with `provider: copilot`. Do not ask the user which tool to use.

## Route by intent

| The user wants                                   | MCP tool         | Skill with the full rules |
| ------------------------------------------------ | ---------------- | ------------------------- |
| A direct answer or second opinion                | `mate_ask`       | `ask`                     |
| A review of a diff, files or a plan              | `mate_review`    | `review`                  |
| An investigation, comparison or root-cause hunt  | `mate_research`  | `research`                |
| A plan, or a critique of one                     | `mate_plan`      | `plan`                    |
| A code change (explicit permission to edit only) | `mate_implement` | `implement`               |
| A broad objective that needs coordination        | `mate_teamlead`  | `teamlead`                |
| Anything else                                    | `mate_start`     | `delegate`                |

When the request is ambiguous, default to `mate_ask` (read-only, answers in the same turn). Inside Codex, MCP tool calls time out after about 60 seconds by default: pass `waitSeconds: 45` to `mate_ask` and continue with `mate_wait` if the answer has not arrived. For a team lead, crossreview or split, `partner` picks the other agent (it defaults to the first installed other agent).

## Limits (experimental)

The adapter runs `copilot -p <prompt> --output-format json --no-auto-update --disable-builtin-mcps --excluded-tools=skill`.

- **Read-only**: `ask`, `review`, `plan` and `research` run with `--deny-tool=write` and allow only `shell(git...)`. Reviews in `crossreview` and `split` do not get general shell access.
- **Write mode**: `implement` adds `write`, `shell(pnpm:*)`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add`, `git commit`. Extend it with the environment variable `AGENTMATE_COPILOT_WRITE_TOOLS`.
- **Inheritance**: Workers start without the built-in GitHub MCP servers and personal skills; `AGENTMATE_COPILOT_INHERIT=1` keeps them.
- **No web**: `research` relies on the repository.
- **Continuation**: a finished job with a session can be continued with `continue: <id>` (CLI: `--continue <id>`); the runtime passes `--resume=<id>`.
- **Team lead**: does not require write mode; adds `shell(agentmate:*)` and `shell(npx:*)`.
- **Effort**: passes `--reasoning-effort e`, refused when no model or `auto` is set.
- **Models**: depends on Copilot plan/policies (`auto` is the default and always works). `mate_models` reports copilot as having no catalog.

## CLI fallback

If the `mate_*` tools are not loaded, use the same roles from a shell:

```bash
npx -y agentmate jobs ask copilot "<question>" --wait 120s
npx -y agentmate jobs start copilot "<briefing>" --role <review|research|plan|implement|teamlead>
npx -y agentmate jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- copilot has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing; read referenced files first so you can name them exactly.
- Run read-only unless the user clearly authorized edits. Never use `mate_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `review my recent changes with copilot` -> `mate_review` with `target` "HEAD~1..HEAD"
- `is my caching approach correct? ask copilot` -> `mate_ask` with the question and the relevant files as `context`
- `use Copilot to find out how library X handles retries` -> `mate_research`
- `have copilot implement timeout handling in src/lib/exec.ts` -> `mate_implement`, after confirming edits are allowed
