---
name: agy
description: Route a task or question to the Google Antigravity CLI (agy), experimental (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching AgentMate tool. Use when the user says /mate:agy, 'ask agy', 'check with agy', 'hand this to agy', 'pergunte ao agy', or names Antigravity.
argument-hint: "<task or question>"
---

# Work with the Antigravity CLI (agy, experimental)

Experimental; requires the Antigravity CLI (`agy`) on PATH. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then check with `npx -y agentmate doctor`; a job on a missing agent is refused with an install hint. Shortcut for "do this with agy". Read the user's request, pick the role it matches and run the matching `mate_*` tool with `provider: agy`. Do not ask the user which tool to use.

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

The adapter is untested against the real CLI. Headless agy denies every tool call that its own profile does not allow, unless it runs with `--dangerously-skip-permissions`:

- **No shell in read-only**: read-only jobs pass no permission flag and rely on agy's own profile, so results can be thin until the user installs the agy-staff allowlist or runs the job with `mode: write`. Reviews in `crossreview` and `split` get the diff inline in the briefing (capped at 30 000 characters) instead of `git diff` instructions.
- **Write mode skips permissions**: `mode: write` (an `implement` job or a team lead) passes `--dangerously-skip-permissions`, which approves every tool call. Warn the user, or use `claude` or `codex`. The runtime does not count on agy's shell, so verify the work yourself.
- **No web**: `research` relies on the repository.
- **Continuation**: a finished job with a session can be continued with `continue: <id>` (CLI: `--continue <id>`); the runtime passes `--conversation <id>` with the conversation id agy reported.
- **Team lead**: accepted only with `mode: write`; a read-only agy lead is refused.
- Each job runs `--print-timeout` with the job deadline rounded up to whole minutes, and `--add-dir` for the working directory.

## CLI fallback

If the `mate_*` tools are not loaded, use the same roles from a shell:

```bash
npx -y agentmate jobs ask agy "<question>" --wait 120s
npx -y agentmate jobs start agy "<briefing>" --role <review|research|plan|implement|teamlead>
npx -y agentmate jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- agy has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing; read referenced files first so you can name them exactly.
- Run read-only unless the user clearly authorized edits. Never use `mate_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `review my recent changes with agy` -> `mate_review` with `target` "HEAD~1..HEAD"
- `is my caching approach correct? ask agy` -> `mate_ask` with the question and the relevant files as `context`
- `use Antigravity to find out how library X handles retries` -> `mate_research`
- `have agy implement timeout handling in src/lib/exec.ts` -> `mate_implement`, after confirming edits are allowed
