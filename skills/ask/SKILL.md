---
name: ask
description: Ask Codex, Claude or Gemini (experimental) a direct question and get the answer in the same turn. Use when the user says /mate:ask, 'ask codex', 'ask claude', 'ask gemini', 'pergunte ao codex/claude', or wants a quick second opinion from the other model.
argument-hint: "<codex|claude|gemini> <question>"
---

# Ask another agent

Get a direct answer from the other model without leaving the session. The first argument is the provider that answers; pick the one that is **not** you, so the opinion is independent. Everything after it is the question.

## How to run it

1. **MCP (preferred)** — call `mate_ask` with `provider` and `question`. It waits up to 120 seconds (`waitSeconds`, max 300) and returns the answer in the same call. Add `context` for background and `cwd` if the question is about another repository. Inside Codex, MCP tool calls time out after about 60 seconds by default: pass `waitSeconds: 45` and continue with `mate_wait` if the answer has not arrived.
2. **CLI fallback** — when the `mate_*` tools are not loaded, run the same thing from a shell:

   ```bash
   npx -y agentmate jobs ask <provider> "<question>" --wait 120s
   ```

   Exit code `0` means the answer was printed, `1` means the job failed or was canceled, `2` means it is still running. Do not pipe the output: a pipe loses the exit code.

## Write the question

The worker starts with no memory of this session. A good question states:

- what you are trying to decide or understand, and why;
- the exact files, symbols, errors or constraints involved (paths, not "the thing we discussed");
- the shape of the answer you want (a yes/no with reasons, a ranked list, a short explanation).

Ask one question per call. If you have three, make three calls, in parallel when they are independent.

## Treat the answer

- The answer is an input to your judgment, not a verdict. Check anything surprising against the code before relying on it.
- Report it to the user in your own words: what was asked, what came back, and what you will do about it. Do not paste raw output.
- If the wait expires, the job is still running: call `mate_wait` with the job id (CLI: `jobs wait <id>`) instead of asking again.

## Rules

- `ask` is read-only. If the question needs edits, use the `implement` skill; if it needs a thorough diff review, use `review`; if it needs web sources, use `research`.
- Never send secrets or credentials in the question.
- Prefer a different provider than the one you are running on.
