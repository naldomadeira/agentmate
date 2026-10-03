import type { Provider } from "../jobs/store.js";

export type ExplainDepth = "overview" | "detailed" | "trace";
export type PerfMetric = "latency" | "throughput" | "memory" | "binary-size";

/**
 * Builds a prompt for deep code/logic explanation.
 */
export function buildExplainCodePrompt(options: {
  target: string;
  depth?: ExplainDepth;
  context?: string;
}): string {
  const depth = options.depth ?? "detailed";
  const depthInstructions: Record<ExplainDepth, string> = {
    overview:
      "Provide a high-level overview: what the code does, its role in the system, and key abstractions. Keep it concise.",
    detailed:
      "Provide a detailed explanation: purpose, control flow, data flow, key design decisions, edge cases, and how it interacts with surrounding code.",
    trace:
      "Provide a full execution trace: step through the code path, explain each branch, data transformation, and side effect. Include call chains and state mutations.",
  };

  let prompt = `Explain the following code/module/function in depth.\n\nTarget: ${options.target}\n\n${depthInstructions[depth]}`;

  if (options.context) {
    prompt += `\n\nAdditional context: ${options.context}`;
  }

  prompt += `\n\nStructure your response with:
1. **Purpose** - What this code does and why it exists
2. **Key Components** - Main functions, types, data structures
3. **Control Flow** - How execution proceeds
4. **Data Flow** - How data is transformed and passed
5. **Design Decisions** - Why it's structured this way
6. **Dependencies** - What it depends on and what depends on it`;

  return prompt;
}

/**
 * Builds a prompt for planning performance improvements.
 */
export function buildPlanPerfPrompt(options: {
  target: string;
  metrics?: PerfMetric[];
  constraints?: string;
  context?: string;
}): string {
  const metrics = options.metrics ?? ["latency", "memory"];
  const metricsList = metrics.join(", ");

  let prompt = `Analyze the performance of the following code and create a concrete improvement plan.

Target: ${options.target}

Focus metrics: ${metricsList}

Perform the following analysis:
1. **Current State** - Read and understand the target code
2. **Hot Path Analysis** - Identify the critical execution path and where time/memory is spent
3. **Bottleneck Identification** - List specific bottlenecks with evidence (e.g., unnecessary allocations, redundant computations, cache misses, algorithmic complexity)
4. **Optimization Plan** - For each bottleneck, propose a ranked optimization with:
   - Description of the change
   - Expected impact (quantified if possible)
   - Implementation difficulty (low/medium/high)
   - Any correctness risks or trade-offs
5. **Implementation Order** - Recommend which optimizations to apply first (highest impact, lowest risk)
6. **Measurement Plan** - How to verify each optimization works (benchmarks, profiling commands)`;

  if (options.constraints) {
    prompt += `\n\nConstraints: ${options.constraints}`;
  }

  if (options.context) {
    prompt += `\n\nAdditional context: ${options.context}`;
  }

  return prompt;
}

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

Structure your response with:
1. **Answer** - The direct answer first, in a few sentences
2. **Evidence** - Supporting code references as file:line, when the question concerns code
3. **Caveats** - Anything you could not verify or that could change the answer (omit if none)`;
}

/** Code review: severity-ordered findings and a final verdict. */
export function buildReviewPrompt(options: {
  target: string;
  focus?: string;
  context?: string;
}): string {
  const focus = options.focus ? `\n\nFocus especially on: ${options.focus}` : "";
  return `Review the following change as a rigorous, skeptical code reviewer. ${READ_ONLY_RULE} Use read-only git commands (diff, log, show, status) to inspect it.

Review target: ${options.target}${focus}${withContext(options.context)}

Report only real problems: correctness bugs, security issues, data loss, race conditions, missing error handling, and tests that do not prove what they claim. Skip pure style preferences.

Structure your response with:
1. **Findings** - Ordered by severity (critical, high, medium, low). For each: severity, file:line, what is wrong, and the **Failure scenario** (the concrete input or sequence that breaks it)
2. **Suggested fixes** - One line per finding
3. **Verdict** - Exactly one of: approve, request-changes, followed by a one-sentence reason`;
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
  const constraints = options.constraints ? `\n\nConstraints: ${options.constraints}` : "";
  const writeRule = canWrite
    ? "- Run only one write job at a time across the whole work tree; wait for it to finish before starting another."
    : "- Do not start any --mode write job; this run is read-only, so delegate only ask, review, research and plan roles.";
  return `You are the team lead (${provider}) for the objective below. Break it into subtasks, delegate the ones that benefit from a second agent to ${otherProvider}, do the rest yourself, then review and integrate everything into one outcome.

Objective: ${options.objective}${constraints}${withContext(options.context)}

Delegate through the agents-bridge CLI (each command is a shell command):

\`\`\`bash
npx -y agents-bridge-mcp jobs start ${otherProvider} "<complete briefing>" --role <ask|review|research|plan|implement> [--mode write] [--cwd <dir>]
npx -y agents-bridge-mcp jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running (run it again)
npx -y agents-bridge-mcp jobs result <id>
npx -y agents-bridge-mcp jobs list
\`\`\`

\`jobs start\` prints a job id and returns at once, so start independent jobs in parallel and then wait for each.

Rules:
- Never delegate to ${provider}; delegate only to ${otherProvider}.
${writeRule}
- A delegated worker cannot delegate further; the bridge refuses it.
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
