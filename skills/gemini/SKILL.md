---
name: gemini
description: Route a task or question to Google Gemini CLI, experimental (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching AgentMate tool. Use when the user says /mate:gemini, 'ask gemini', 'check with gemini', 'hand this to gemini', 'pergunte ao gemini'.
argument-hint: "<task or question>"
---

# Work with Gemini CLI (experimental)

Experimental; requires the Gemini CLI (`gemini`) on PATH. Check with `npx -y agentmate doctor`; a job on a missing agent is refused with an install hint. Shortcut for "do this with Gemini CLI". Read the user's request, pick the role it matches and run the matching `mate_*` tool with `provider: gemini`. Do not ask the user which tool to use.

## Route by intent

| The user wants                                   | MCP tool           | Skill with the full rules |
| ------------------------------------------------ | ------------------ | ------------------------- |
| A direct answer or second opinion                | `mate_ask`       | `ask`                     |
| A review of a diff, files or a plan              | `mate_review`    | `review`                  |
| An investigation, comparison or root-cause hunt  | `mate_research`  | `research`                |
| A plan, or a critique of one                     | `mate_plan`      | `plan`                    |
| A code change (explicit permission to edit only) | `mate_implement` | `implement`               |
| A broad objective that needs coordination        | `mate_teamlead`  | `teamlead`                |
| Anything else                                    | `mate_start`     | `delegate`                |

When the request is ambiguous, default to `mate_ask` (read-only, answers in the same turn). Inside Codex, MCP tool calls time out after about 60 seconds by default: pass `waitSeconds: 45` to `mate_ask` and continue with `mate_wait` if the answer has not arrived. For a team lead, crossreview or split led by gemini, `partner` picks the other agent (it defaults to claude).

## CLI fallback

If the `mate_*` tools are not loaded, use the same roles from a shell:

```bash
npx -y agentmate jobs ask gemini "<question>" --wait 120s
npx -y agentmate jobs start gemini "<briefing>" --role <review|research|plan|implement|teamlead>
npx -y agentmate jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- Gemini CLI has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing; read referenced files first so you can name them exactly.
- Run read-only unless the user clearly authorized edits. Never use `mate_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `review my recent changes` -> `mate_review` with `target` "HEAD~1..HEAD"
- `is my caching approach correct?` -> `mate_ask` with the question and the relevant files as `context`
- `find out how library X handles retries` -> `mate_research`
- `implement timeout handling in src/lib/exec.ts` -> `mate_implement`, after confirming edits are allowed
