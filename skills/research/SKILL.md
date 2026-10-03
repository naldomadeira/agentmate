---
name: research
description: Investigate a technical topic with Codex or Claude and get findings, compared options and a recommendation with evidence. Use when the user says /mate:research, 'research this with codex', 'pesquise com o claude', or needs a library choice, root-cause hunt or design trade-off surveyed.
argument-hint: "<codex|claude> <topic>"
---

# Research a topic

Delegate an investigation and receive a structured report: findings with evidence, options compared, a recommendation and open questions. The first argument is the provider; the rest is the topic.

## How to run it

1. **MCP (preferred)** — call `mate_research` with `provider`, `topic`, and optionally `questions` (the specific things you need answered), `scope` (where to look: directories, docs, the web) and `context`. It returns a job id; collect it with `mate_wait`. Research can take minutes, so do other work in between.
2. **CLI fallback**:

   ```bash
   npx -y agentmate jobs start <provider> "<research briefing>" --role research
   npx -y agentmate jobs wait <id> --timeout 10m
   ```

   `wait` exits `0` done, `1` failed or canceled, `2` still running (repeat it). Read the output with `jobs result <id>`.

## Write the briefing

- The decision this research feeds. "Which queue library for X given Y" beats "look into queues".
- The concrete questions, numbered, so each gets an answer.
- The scope: which parts of the repository, which versions, whether web sources are expected (Claude research jobs can use web search and fetch; Codex runs sandboxed and may have no web access, so say what it should rely on).
- Constraints that rule options out (license, runtime, team skills).

## Treat the result

- Separate what the report shows with evidence (file paths, links, quotes) from what it infers. Spot-check the load-bearing claims.
- Web-derived claims age: check dates and versions before relying on them.
- Give the user the recommendation, the strongest alternative and the open questions. Do not forward the full report unless asked.

## Rules

- Research is read-only. It does not install packages or modify the working tree.
- If the report leaves a question open, continue the same session with a follow-up job (`continue` on `mate_start`, CLI `--continue <id>`) rather than starting from zero.
- Several independent topics are several jobs, started in parallel.
