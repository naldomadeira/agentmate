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
     cancel/list          status / fyi    + notes.md
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
| `claude` | `claude -p --output-format stream-json --verbose` | tool allowlist plus explicit deny of `Edit`, `Write`, `NotebookEdit` | `--permission-mode acceptEdits` plus a verification allowlist | JSONL (stream-json): assistant text, tool use and error results |

## Jobs (`src/jobs/`)

A job is a directory under `~/.agentmate/jobs/<id>/` with `job.json` (atomic, owner-only), `stdout.log`, `stderr.log`, `result.md` and `events.jsonl`. `mate_start` writes the job and spawns a detached worker, so the job outlives the session that started it. The worker runs the adapter's invocation, records events while it runs, and writes the result and the terminal status last.

Roles (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `crossreview`, `split`, or `custom`) select a prompt builder and the permissions the adapter applies. Jobs record `depth` and `parentJob`; a session starts a team lead (depth 0), the team lead starts children (depth 1), and children cannot start jobs. A read-only parent cannot start write children.

## Events and context filtering

Agents must not receive each other's tool noise. Every event has a level:

| Level | Examples | Crosses to the other agent? |
| --- | --- | --- |
| `important` | the agent's message, errors, start and finish | yes, always |
| `status` | a file changed | summarized on request (`observe`) |
| `fyi` | a command ran, with its exit code | only with `--raw` or `levels: ["fyi"]` |

A job whose provider reports a spent usage allowance ends `quota_exhausted` (`src/jobs/quota.ts`); `cancelJob` cancels a job's non-terminal children, recursively, before the job itself.

`mate_observe` returns the recent `important` and `status` events by default; `mate_events` returns the full filtered log; raw stdout and stderr are available on demand.

## Cross-review (workflow job)

`crossreview` is a job whose worker calls no agent CLI. `src/jobs/crossreview.ts` runs the steps as child jobs through `startJob` (depth 1, `parentJob` = the workflow id): `implement` on the named provider in write mode, then `review` on `otherAgent(provider)` read-only over the uncommitted diff, repeated up to `maxRounds` (default 2, stored in `job.workflow` with the per-round job ids and verdicts). A round-2 implement step continues the implementer's session with the findings. The loop stops on `Verdict: approve`, on a missing verdict (report section `## Needs human`) or when rounds run out; a failed child fails the workflow. The workflow job's own deadline bounds the whole run, and canceling it cancels the running child. Only a top-level session may start one.

## Split (workflow job)

`split` is the second workflow job: its worker calls no agent CLI either. `src/jobs/split.ts` runs a planner and the parts as child jobs through `startJob`, all in one session, and `job.split` stores `maxParts` and the per-part progress (`id`, `title`, `agent`, plan, part and review job ids, verdict, branch, worktree).

1. **Plan.** A `plan` child on the named provider gets `buildSplitPlanPrompt` and must end with one fenced `json` block, `{ "parts": [{ id, title, briefing, files, agent }] }`. The worker parses the last such block and validates it (1..`maxParts` parts, unique ids `[a-z0-9-]+`, known agents; a missing or unknown agent alternates, starting with `otherAgent(provider)`). An invalid block ends the workflow `error` with a pointer to `jobs result <planJob>`. The plan is appended to the session notes (author `split`).
2. **Parts, in parallel.** Read-only: one `research` child per part, on the part's agent, in the job's `cwd`. Write: per part `git worktree add -b agentmate/<split-id>/<part-id> <AGENTMATE_HOME>/worktrees/<split-id>/<part-id> HEAD` in the job's `cwd`, then an `implement` child with `cwd` = that worktree; when it finishes the worker commits what it left on the branch. All parts start before the worker waits for any, in short slices that honor SIGTERM and the deadline.
3. **Cross-review, in parallel.** One read-only `review` child per finished part on `otherAgent(part.agent)`, in the part's worktree (write: the diff against the base commit) or in the job's `cwd` (read-only: over the research result), ending in `Verdict: approve` or `Verdict: request-changes`.
4. **Report.** `result.md` has `## Goal`, `## Parts`, `## Integration` (write: the ordered `git merge` commands and `git worktree remove` cleanup; read-only: merged research), `## Needs human` and `## Next steps`. A failed part ends the workflow `error` naming it, after the other parts finish. Nothing is merged, pushed or deleted, and conflicts between parts are not resolved.

## Sessions (shipped in phase 2)

A session groups jobs across agents and carries short shared notes that the host writes and workers read in their briefing. Cross-review shipped in phase 1 on parent/child jobs (see above); phase 2 adds sessions as the shared context between steps, and task splitting (see above), a workflow that the worker runs as a sequence of jobs inside one session, so the user never relays results by hand.

A session is a directory `~/.agentmate/sessions/<id>/` (owner-only, written like jobs) with `session.json` (`id`, `title`, `cwd`, `createdAt`, `updatedAt`, `jobs`) and `notes.md`, an append-only file of `### <ISO> · <author>` entries. `src/jobs/sessions.ts` creates, lists and reads them. A job started with a session records it as `job.session` (distinct from `job.sessionId`, the provider's own conversation id that `continue` resumes), is added to `session.jobs`, and, when the notes are not empty, gets the last 4000 characters of them in front of its prompt, whatever its role:

```text
## Shared session notes (session <id>: <title>)
<notes>

---

<the role prompt>
```

Children started by workflows (`crossreview`, `split`) inherit the workflow's session. The host edits the notes through `mate_session_notes` / `agentmate sessions notes`; keep them short and factual, because every worker in the session reads them.

## Safety model

Read-only by default; permissions follow the role; the delegation depth is limited to two levels; one write job per working tree at a time; job state files are owner-only; no agent runs with maximum permissions unless the user opts in explicitly. See the README's "Safety model" for the per-role table.

## Roadmap

The incremental plan lives in `docs/superpowers/plans/2026-10-03-agentmate-runtime-evolucao.md` (Portuguese). Phase 1 adds adapters, events and lifecycle hardening; phase 2 adds sessions, cross-review and task splitting; phase 3 adds an inbox, the Gemini adapter and `agentmate init`.
