---
name: plan
description: Get an implementation plan from Codex or Claude, or a critique of a plan you already have, with files, risks and verification steps. Use when the user says /bridge:plan, 'plan this with codex', 'challenge this plan', 'planeje com o claude', or before a non-trivial change.
argument-hint: "<codex|claude> <goal> | <codex|claude> critique <plan>"
---

# Plan or critique a plan

Two modes, chosen by the arguments. After the provider: a goal means "write a plan"; the word `critique` followed by a plan means "find the gaps in this plan".

## How to run it

1. **MCP (preferred)** — call `bridge_plan` with `provider` and `goal`. Add `constraints` (deadlines, compatibility, things not to touch) and `context`. For a critique, also pass the full text in `existingPlan`; the worker then critiques instead of creating. The call returns a job id; collect it with `bridge_wait`.
2. **CLI fallback**:

   ```bash
   npx -y agents-bridge-mcp jobs start <provider> "<planning briefing>" --role plan
   npx -y agents-bridge-mcp jobs wait <id> --timeout 10m
   ```

   Paste the plan to critique into the briefing. `wait` exits `0` done, `1` failed or canceled, `2` still running (repeat it). Read the output with `jobs result <id>`.

## Write the briefing

- The goal as an outcome and how you will know it is done.
- Constraints: what must stay compatible, what is off limits, what is already decided.
- Pointers: the files, modules or docs the plan has to respect.
- For a critique: the whole plan, not a summary, and the part you are least sure about.

## Treat the result

- A plan names files, ordered steps, risks and a verification step for each part. Reject a plan that skips verification or invents files that do not exist; check paths against the repository.
- A critique lists gaps and risks. Decide which ones change the plan and update it; record the ones you dismiss and why.
- Present the user with the resulting plan and the decisions you made, not the raw worker text.

## Rules

- Planning is read-only. Do not start `implement` until the user approves the plan.
- Prefer a different provider than your own so the plan is not a restatement of your assumptions.
- Re-plan after the facts change: start a new job or `continue` the previous one with the new information.
