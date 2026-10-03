---
name: claude
description: Route a task or question to Claude Code (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching Agents Bridge tool. Use when the user says /bridge:claude, 'ask claude', 'check with claude', 'hand this to claude', 'pergunte ao claude'.
argument-hint: "<task or question>"
---

# Work with Claude Code

Shortcut for "do this with Claude Code". Read the user's request, pick the role it matches and run the matching `bridge_*` tool with `provider: claude`. Do not ask the user which tool to use.

## Route by intent

| The user wants                                   | MCP tool           | Skill with the full rules |
| ------------------------------------------------ | ------------------ | ------------------------- |
| A direct answer or second opinion                | `bridge_ask`       | `ask`                     |
| A review of a diff, files or a plan              | `bridge_review`    | `review`                  |
| An investigation, comparison or root-cause hunt  | `bridge_research`  | `research`                |
| A plan, or a critique of one                     | `bridge_plan`      | `plan`                    |
| A code change (explicit permission to edit only) | `bridge_implement` | `implement`               |
| A broad objective that needs coordination        | `bridge_teamlead`  | `teamlead`                |
| Anything else                                    | `bridge_start`     | `delegate`                |

When the request is ambiguous, default to `bridge_ask` (read-only, answers in the same turn). Inside Codex, MCP tool calls time out after about 60 seconds by default: pass `waitSeconds: 45` to `bridge_ask` and continue with `bridge_wait` if the answer has not arrived.

## CLI fallback

If the `bridge_*` tools are not loaded, use the same roles from a shell:

```bash
npx -y agents-bridge-mcp jobs ask claude "<question>" --wait 120s
npx -y agents-bridge-mcp jobs start claude "<briefing>" --role <review|research|plan|implement|teamlead>
npx -y agents-bridge-mcp jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- Claude Code has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing; read referenced files first so you can name them exactly.
- Run read-only unless the user clearly authorized edits. Never use `bridge_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `review my recent changes` -> `bridge_review` with `target` "HEAD~1..HEAD"
- `is my caching approach correct?` -> `bridge_ask` with the question and the relevant files as `context`
- `find out how library X handles retries` -> `bridge_research`
- `implement timeout handling in src/lib/exec.ts` -> `bridge_implement`, after confirming edits are allowed
