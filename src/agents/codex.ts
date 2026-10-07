import { parseCodexOutput } from "../lib/codex-output-parser.js";
import { codexHomeFor } from "../jobs/accounts.js";
import type { Job } from "../jobs/store.js";
import type { AgentAdapter, Invocation, JobEvent, Outcome } from "./types.js";

const MAX_EVENT_TEXT = 500;

/** The team lead must spawn `node` processes and write job state outside the repo, which workspace-write blocks. */
export function codexSandbox(job: Job): string {
  if (job.role === "teamlead") return "danger-full-access";
  if (job.role === "review" && job.allowCommands) return "workspace-write";
  return job.mode === "write" ? "workspace-write" : "read-only";
}

const clip = (text: string) => text.slice(0, MAX_EVENT_TEXT);
const event = (partial: Omit<JobEvent, "ts" | "job">): JobEvent => ({
  ts: new Date().toISOString(),
  job: "",
  ...partial,
});

function errorText(parsed: Record<string, unknown>): string {
  const err = parsed["error"];
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  if (typeof parsed["message"] === "string") return parsed["message"];
  return JSON.stringify(parsed);
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  binary: () => process.env["AGENTMATE_CODEX_BIN"] ?? "codex",
  capabilities: { write: true, web: false, resume: true, shell: true, streaming: "jsonl" },
  teamleadNeedsWrite: false,
  versionArgs: ["--version"],

  effortError: () => null,

  /** A non-default account runs under its own CODEX_HOME, where its login and threads live. */
  env(job: Job): Record<string, string> | undefined {
    const home = codexHomeFor(job.account);
    return home ? { CODEX_HOME: home } : undefined;
  },

  buildInvocation(job: Job, resumeSessionId?: string): Invocation {
    const args = resumeSessionId
      ? ["exec", "resume", resumeSessionId, "--json"]
      : ["exec", "--json", "--skip-git-repo-check"];
    if (job.model) args.push("--model", job.model);
    // A config override is accepted by `exec` and `exec resume` alike, so a continued job keeps it.
    if (job.effort) args.push("-c", `model_reasoning_effort=${job.effort}`);
    // `exec resume` does not accept --sandbox; the resumed thread keeps its original one.
    if (!resumeSessionId) args.push("--sandbox", codexSandbox(job));
    args.push(job.prompt);
    return { command: codexAdapter.binary(), args };
  },

  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome {
    const r = parseCodexOutput(stdout);
    const outcome: Outcome = {
      text: r.agentMessage,
      sessionId: r.threadId,
      errors: r.errors,
      ...(r.usage ? { usage: r.usage } : {}),
    };
    if (exitCode !== 0 && !outcome.text && stderr.trim()) outcome.errors.push(stderr.trim());
    return outcome;
  },

  parseStreamLine(line: string): JobEvent[] {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      parsed = value as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = parsed["type"];
    if (type === "turn.failed" || type === "error") {
      return [event({ level: "important", kind: "error", text: clip(errorText(parsed)) })];
    }
    if (type !== "item.completed") return [];
    const item = (parsed["item"] as Record<string, unknown> | undefined) ?? {};
    switch (item["type"]) {
      case "agent_message": {
        const text = typeof item["text"] === "string" ? item["text"] : "";
        return text ? [event({ level: "important", kind: "message", text: clip(text) })] : [];
      }
      case "file_change": {
        const path = typeof item["path"] === "string" ? item["path"] : "";
        if (!path) return [];
        const kind = typeof item["kind"] === "string" ? item["kind"] : "update";
        return [
          event({
            level: "status",
            kind: "file",
            text: clip(`${kind} ${path}`),
            data: { path, kind },
          }),
        ];
      }
      case "command_execution": {
        const command = typeof item["command"] === "string" ? item["command"] : "";
        const exitCode = typeof item["exit_code"] === "number" ? item["exit_code"] : null;
        return [
          event({
            level: "fyi",
            kind: "command",
            text: clip(`${command} (exit ${exitCode ?? "?"})`),
            data: { command, exitCode },
          }),
        ];
      }
      default:
        return [];
    }
  },
};
