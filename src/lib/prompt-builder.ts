import type { AgentId } from "../agents/types.js";
import type { Provider } from "../jobs/store.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Role prompts for delegated jobs. The worker has no context beyond the text
// built here, so each prompt states the task, the rules and the output format.
// ---------------------------------------------------------------------------

const withContext = (context?: string) => (context ? `\n\nContext:\n${context}` : "");
const READ_ONLY_RULE = "Do not modify any files; inspect only.";

/** Direct question: a short answer backed by evidence from the code. */
export function buildAskPrompt(options: { question: string; context?: string }): string {
  return `Answer the following question directly and concisely. ${READ_ONLY_RULE}

Question: ${options.question}${withContext(options.context)}

If the question asks for a specific form (for example "reply only with OK", a single word, a number or a list), follow it exactly and skip the structure below. Otherwise, structure your response with:
1. **Answer** - The direct answer first, in a few sentences
2. **Evidence** - Supporting code references as file:line, when the question concerns code
3. **Caveats** - Anything you could not verify or that could change the answer (omit if none)`;
}

/** Code review: severity-ordered findings and a final verdict line that workflows parse. */
export function buildReviewPrompt(options: {
  target: string;
  focus?: string;
  context?: string;
  /** False for an agent that cannot run the shell: it is told to rely on the files and the context instead of git. */
  shell?: boolean;
  /** When true, reviewer may run commands/tests to verify claims, but must not edit files. */
  commandsAllowed?: boolean;
}): string {
  const focus = options.focus ? `\n\nFocus especially on: ${options.focus}` : "";
  const inspect =
    options.shell === false
      ? "You cannot run shell commands, so inspect the change with your file-reading tools and the diff or findings given in the context."
      : "Use read-only git commands (diff, log, show, status) to inspect it.";
  const commandsPolicy = options.commandsAllowed
    ? "You may run tests and commands to verify claims, but you must not edit files."
    : "The sandbox is read-only; commands that need to write (tests with caches, DB sockets) may fail because of the sandbox.";
  const verificationSection = options.commandsAllowed
    ? `3. **Verified** - For each claim verified by running something, report the command and its result ("verified: <cmd> passed/failed")
4. **Not verified** - What you did not verify`
    : `3. **Not verified** - What you could not verify and why (sandbox vs. other)`;
  const verdictIndex = options.commandsAllowed ? 5 : 4;
  return `Review the following change as a rigorous, skeptical code reviewer. ${READ_ONLY_RULE} ${inspect} ${commandsPolicy}

Review target: ${options.target}${focus}${withContext(options.context)}

Report only real problems: correctness bugs, security issues, data loss, race conditions, missing error handling, and tests that do not prove what they claim. Skip pure style preferences.

Structure your response with:
1. **Findings** - Ordered by severity (critical, high, medium, low). For each: severity, file:line, what is wrong, and the **Failure scenario** (the concrete input or sequence that breaks it)
2. **Suggested fixes** - One line per finding
${verificationSection}
${verdictIndex}. **Verdict** - A one-sentence reason, then, as the very last line of your response, exactly one of these two lines and nothing after it:
Verdict: approve
Verdict: request-changes`;
}

/** Investigation: evidence-backed findings, compared options and a recommendation. */
export function buildResearchPrompt(options: {
  topic: string;
  questions?: string[];
  scope?: string;
  context?: string;
}): string {
  const questions = options.questions?.length
    ? `\n\nQuestions to answer:\n${options.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
    : "";
  const scope = options.scope ? `\n\nScope: ${options.scope}` : "";
  return `Research the following topic and report what you find. ${READ_ONLY_RULE} Use the repository and, when available, web search to ground your claims. Cite sources (file:line or URL) and separate facts from inference.

Topic: ${options.topic}${questions}${scope}${withContext(options.context)}

Structure your response with:
1. **Findings** - What you learned, each with its evidence
2. **Options compared** - The viable approaches with trade-offs (omit if there is a single path)
3. **Recommendation** - What to do and why
4. **Open questions** - What remains unknown and how to find out`;
}

/** Planning: a new plan, or a critique when an existing plan is supplied. */
export function buildPlanPrompt(options: {
  goal: string;
  constraints?: string;
  existingPlan?: string;
  context?: string;
}): string {
  const constraints = options.constraints ? `\n\nConstraints: ${options.constraints}` : "";
  const tail = `${constraints}${withContext(options.context)}`;
  if (options.existingPlan) {
    return `Critique the existing plan below against the goal. ${READ_ONLY_RULE} Read the relevant code to check the plan's assumptions instead of trusting them.

Goal: ${options.goal}

Existing plan:
${options.existingPlan}${tail}

Structure your response with:
1. **Critique** - Overall assessment in two or three sentences
2. **Gaps** - Missing steps, unhandled cases, wrong assumptions (cite file:line)
3. **Risks** - What could go wrong, with likelihood and impact
4. **Revised steps** - Concrete changes to the plan, if any`;
  }
  return `Create a concrete implementation plan for the goal below. ${READ_ONLY_RULE} Read the relevant code first so the plan names real files and functions.

Goal: ${options.goal}${tail}

Structure your response with:
1. **Steps** - Ordered, each small enough to verify on its own
2. **Files** - Every file to create or change, with what changes in it
3. **Risks** - What could go wrong and how to mitigate it
4. **Verification** - The exact commands or checks that prove each step and the whole`;
}

/** Write task: implement, verify, never commit unasked, report. */
export function buildImplementPrompt(options: {
  task: string;
  acceptance?: string;
  context?: string;
}): string {
  const acceptance = options.acceptance ? `\n\nAcceptance criteria:\n${options.acceptance}` : "";
  return `Implement the following task in the current repository.

Task: ${options.task}${acceptance}${withContext(options.context)}

Rules:
- Read the surrounding code first and follow its conventions.
- Keep the change minimal and focused on the task.
- Run the repository's own verification (tests, lint, type-check, build) and fix what you broke.
- Do not commit, push or create branches unless the task explicitly asks for it.
- If a verification command is not permitted or fails to run, say so explicitly instead of claiming it passed.

Structure your final response with:
1. **Summary** - What you implemented
2. **Files changed** - Each file and the nature of the change
3. **Verification** - The commands you ran and their results; say plainly if something was not run or failed
4. **Follow-ups** - Known gaps or decisions the requester should review`;
}

/** Team lead: decompose, delegate to the other provider through the CLI, integrate. */
export function buildTeamleadPrompt(options: {
  objective: string;
  provider: Provider;
  otherProvider: Provider;
  canWrite: boolean;
  constraints?: string;
  context?: string;
}): string {
  const { provider, otherProvider, canWrite } = options;
  const cli = `npx -y agentmate@${VERSION}`;
  const constraints = options.constraints ? `\n\nConstraints: ${options.constraints}` : "";
  const writeRule = canWrite
    ? "- Run only one write job at a time across the whole work tree; wait for it to finish before starting another."
    : "- Do not start any --mode write job; this run is read-only, so delegate only ask, review, research and plan roles.";
  return `You are the team lead (${provider}) for the objective below. Break it into subtasks, delegate the ones that benefit from a second agent to ${otherProvider}, do the rest yourself, then review and integrate everything into one outcome.

Objective: ${options.objective}${constraints}${withContext(options.context)}

Delegate through the agentmate CLI (each command is a shell command):

\`\`\`bash
${cli} jobs start ${otherProvider} "$(cat <<'EOF'
<complete briefing>
EOF
)" --role <ask|review|research|plan|implement> [--mode write] [--cwd <dir>]
${cli} jobs wait <id> --timeout 90s   # exit 0 done, 1 failed, 2 still running (run the same wait again)
${cli} jobs result <id>
${cli} jobs list
\`\`\`

Shell tools time out after about two minutes, so keep each wait short; on exit 2 run the same wait again.

\`jobs start\` prints a job id and returns at once, so start independent jobs in parallel and then wait for each.

Rules:
- Never delegate to ${provider}; delegate only to ${otherProvider}.
${writeRule}
- A delegated worker cannot delegate further; AgentMate refuses it.
- Write briefings inside the single-quoted heredoc above; never interpolate repository text or worker output into a double-quoted string.
- Each briefing must be self-contained: the worker sees nothing of this conversation, so state the goal, the files, the constraints and the output you expect.
- You are responsible for the result: read every delegated result critically, verify claims against the code, and do not forward them unchecked.
- Do not finish before you have collected the result of every job you started (cancel with \`jobs cancel <id>\` if one is no longer needed).

Structure your final report with:
1. **Objective** - Restated in one or two sentences
2. **Plan** - The subtasks and who handled each
3. **Delegations** - A table with columns: id, provider, role, status
4. **Findings** - What was discovered, with evidence
5. **Decisions** - What you chose and why, including rejected delegated advice
6. **Deliverables** - Files changed or artifacts produced, and how you verified them
7. **Open questions** - What still needs a human decision`;
}

/**
 * The record of a crossreview workflow job. No agent CLI receives this text: the worker runs the
 * steps as child jobs with the implement and review prompts, so this only describes the run.
 */
export function buildCrossreviewPrompt(options: {
  task: string;
  acceptance?: string;
  implementer: Provider;
  reviewer: Provider;
  maxRounds: number;
}): string {
  const acceptance = options.acceptance ? `\n\nAcceptance criteria:\n${options.acceptance}` : "";
  return `Cross-review workflow: ${options.implementer} implements, ${options.reviewer} reviews the uncommitted diff, for up to ${options.maxRounds} round(s).

Task: ${options.task}${acceptance}`;
}

/**
 * Planner prompt of a split workflow: divide a goal into independent parts and end with the parts
 * block that the workflow parses. The workflow reads only the last fenced json block.
 */
export function buildSplitPlanPrompt(options: {
  goal: string;
  acceptance?: string;
  maxParts: number;
  agents: AgentId[];
}): string {
  const acceptance = options.acceptance ? `\n\nAcceptance criteria:\n${options.acceptance}` : "";
  return `Split the goal below into independent parts that different agents can work on at the same time. ${READ_ONLY_RULE} Read the relevant code first so the parts name real files.

Goal: ${options.goal}${acceptance}

Rules for the split:
- Produce between 1 and ${options.maxParts} parts. Prefer fewer, larger parts over many tiny ones; use one part only if the goal cannot be divided.
- Parts must be independent: they can run in parallel without waiting for each other.
- Close the interfaces: when parts meet (a function signature, a file format, a config key), fix that contract in the briefings of both sides so neither has to guess.
- No overlapping files: every file belongs to exactly one part. If two parts would edit the same file, merge them or move the shared edit into one part.
- Assign each part to one of the available agents: ${options.agents.join(", ")}. Spread the parts across the agents when that suits the work.
- Each briefing must be self-contained: the agent sees nothing of this conversation, so state the part's goal, the files it owns, the interfaces it must respect and what done means.

Structure your response with:
1. **Plan** - The split in a few sentences and why the parts are independent
2. **Interfaces** - The contracts between parts (omit if there are none)
3. **Parts** - As the very last thing in your response, exactly one fenced json block in this shape and nothing after it:

\`\`\`json
{ "parts": [{ "id": "a", "title": "…", "briefing": "…", "files": ["…"], "agent": "${options.agents[0] ?? "codex"}" }] }
\`\`\`

Each \`id\` is unique and uses only lowercase letters, digits and hyphens.`;
}

/**
 * The record of a split workflow job. No agent CLI receives this text: the worker runs a planner,
 * the parts and their reviews as child jobs, so this only describes the run.
 */
export function buildSplitPrompt(options: {
  goal: string;
  acceptance?: string;
  planner: Provider;
  /** The agent that works with the planner: parts go to either, and each part is reviewed by the other. */
  partner: Provider;
  maxParts: number;
  mode: "read-only" | "write";
}): string {
  const acceptance = options.acceptance ? `\n\nAcceptance criteria:\n${options.acceptance}` : "";
  const how =
    options.mode === "write"
      ? "each part is implemented in its own git worktree and branch"
      : "each part is researched read-only";
  return `Split workflow: ${options.planner} plans up to ${options.maxParts} independent part(s), ${how} by ${options.planner} or ${options.partner}, and the other of the two reviews each part.

Goal: ${options.goal}${acceptance}`;
}
