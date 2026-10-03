# AgentMate architecture

AgentMate is one runtime with two faces. **Delegation** hands a task to another coding agent as a durable background job and collects the result. **Collaboration** lets agents review, split and continue each other's work through the same jobs, using filtered events instead of raw transcripts. Claude Code and Codex CLI are the first teammates; the adapter layer is where new agents plug in.

```text
                         AgentMate
                             │
             ┌───────────────┼───────────────┐
             │               │               │
           Jobs            Events         Sessions
     durable, detached   filtered log    shared notes
     wait/observe/result  important /     across jobs
     cancel/list          status / fyi    (phase 2)
             │               │               │
             └───────────────┼───────────────┘
                             │
                      Agent adapters
                             │
                ┌────────────┼────────────┐
                │            │            │
             Claude        Codex       Gemini (phase 3)
```

## Agent adapters (`src/agents/`)

An adapter knows how to run one agent CLI and nothing else: which binary to call, which flags each role and mode need, how to parse the output, how to turn a stream of CLI events into AgentMate events, and what it can do (write, web access, resume, streaming). The runtime never branches on the agent name outside this directory. Adding an agent means adding one file and registering it.

| Adapter | Invocation | Read-only | Write | Streaming |
| --- | --- | --- | --- | --- |
| `codex` | `codex exec --json --skip-git-repo-check` | `--sandbox read-only` | `--sandbox workspace-write` (team lead: `danger-full-access`) | JSONL items |
| `claude` | `claude -p --output-format json` | tool allowlist plus explicit deny of `Edit`, `Write`, `NotebookEdit` | `--permission-mode acceptEdits` plus a verification allowlist | none (single JSON result) |

## Jobs (`src/jobs/`)

A job is a directory under `~/.agentmate/jobs/<id>/` with `job.json` (atomic, owner-only), `stdout.log`, `stderr.log`, `result.md` and `events.jsonl`. `mate_start` writes the job and spawns a detached worker, so the job outlives the session that started it. The worker runs the adapter's invocation, records events while it runs, and writes the result and the terminal status last.

Roles (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, or `custom`) select a prompt builder and the permissions the adapter applies. Jobs record `depth` and `parentJob`; a session starts a team lead (depth 0), the team lead starts children (depth 1), and children cannot start jobs. A read-only parent cannot start write children.

## Events and context filtering

Agents must not receive each other's tool noise. Every event has a level:

| Level | Examples | Crosses to the other agent? |
| --- | --- | --- |
| `important` | the agent's message, errors, start and finish | yes, always |
| `status` | a file changed | summarized on request (`observe`) |
| `fyi` | a command ran, with its exit code | only with `--raw` or `levels: ["fyi"]` |

`mate_observe` returns the recent `important` and `status` events by default; `mate_events` returns the full filtered log; raw stdout and stderr are available on demand.

## Sessions (phase 2)

A session groups jobs across agents and carries short shared notes that the host writes and workers read in their briefing. Cross-review (implement on A, review on B, revise on A) and task splitting (plan, parallel parts, cross-review, integration) are workflows that the worker runs as a sequence of jobs inside one session, so the user never relays results by hand.

## Safety model

Read-only by default; permissions follow the role; the delegation depth is limited to two levels; one write job per working tree at a time; job state files are owner-only; no agent runs with maximum permissions unless the user opts in explicitly. See the README's "Safety model" for the per-role table.

## Roadmap

The incremental plan lives in `docs/superpowers/plans/2026-10-03-agentmate-runtime-evolucao.md` (Portuguese). Phase 1 adds adapters, events and lifecycle hardening; phase 2 adds sessions, cross-review and task splitting; phase 3 adds an inbox, the Gemini adapter and `agentmate init`.
