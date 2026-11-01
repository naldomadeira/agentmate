import type { Usage } from "../agents/types.js";

type Obj = Record<string, unknown>;

/** What `parseGrokOutput` makes of a Grok Build run (`-p … --output-format streaming-json`). */
export interface GrokResult {
  resultText: string;
  /** The session id of the final `end` event, which `--resume` takes to continue the run. */
  sessionId: string | null;
  errors: string[];
  /** `resultText` is the text streamed so far by a run that ended without an `end` event. */
  partial?: boolean;
  /** A final `end` event was seen. */
  completed: boolean;
  usage?: Usage;
}

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const MAX_RAW_CHARS = 300;

/** One readable line for an `error` event: `message`, else `data`, else the error object, else the type. */
export function grokErrorText(event: Obj): string {
  const error = event["error"];
  return (
    str(event["message"]).trim() ||
    str(event["data"]).trim() ||
    (isObject(error) ? str(error["message"]).trim() : str(error).trim()) ||
    str(event["type"])
  );
}

/** Whether an `end` event closes the turn with a failure. */
const isFailedStop = (stopReason: string) =>
  stopReason !== "" && stopReason !== "end_turn" && stopReason !== "max_turns";

/**
 * Reads the JSONL of `grok -p --output-format streaming-json`: `text` and `thought` chunks, ACP-style
 * `tool_call` / `tool_call_update` events, and a final `end` event with `sessionId`, `usage` and
 * `modelUsage`. The answer is the text streamed after the last tool call; text printed before the
 * first `{` (an error line) is an error.
 */
export function parseGrokOutput(stdout: string, exitCode: number): GrokResult {
  const result: GrokResult = { resultText: "", sessionId: null, errors: [], completed: false };
  const raw: string[] = [];
  let current = "";
  let model = "";
  let usage: Usage = {};

  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let event: Obj;
    try {
      const value: unknown = JSON.parse(text);
      if (!isObject(value)) continue;
      event = value;
    } catch {
      raw.push(text);
      continue;
    }
    const type = str(event["type"]);
    if (type === "text") current += str(event["data"]);
    else if (type === "tool_call") current = "";
    else if (type === "error") result.errors.push(grokErrorText(event));
    else if (type === "end") {
      result.completed = true;
      result.sessionId = str(event["sessionId"]) || null;
      const stop = str(event["stopReason"]);
      if (isFailedStop(stop)) result.errors.push(`grok stopped: ${stop}`);
      const total = event["usage"];
      if (isObject(total)) {
        usage = {
          ...(num(total["input_tokens"]) !== undefined
            ? { inputTokens: num(total["input_tokens"])! }
            : {}),
          ...(num(total["output_tokens"]) !== undefined
            ? { outputTokens: num(total["output_tokens"])! }
            : {}),
          ...(num(total["reasoning_tokens"]) !== undefined
            ? { reasoningTokens: num(total["reasoning_tokens"])! }
            : {}),
          ...(num(total["cache_read_input_tokens"]) !== undefined
            ? { cachedInputTokens: num(total["cache_read_input_tokens"])! }
            : {}),
        };
      }
      const cost = num(event["total_cost_usd"]);
      if (cost !== undefined) usage.costUsd = cost;
      const models = event["modelUsage"];
      if (isObject(models)) model = Object.keys(models)[0] ?? "";
    }
  }

  result.resultText = current.trim();
  if (!result.completed && result.resultText) result.partial = true;
  if (!result.completed && !result.resultText && raw.length > 0)
    result.errors.push(raw.join(" ").slice(0, MAX_RAW_CHARS));
  else if (!result.completed && exitCode !== 0)
    result.errors.push(`grok exited ${exitCode} without a final result`);
  if (model) usage.model = model;
  if (Object.keys(usage).length > 0) result.usage = usage;
  return result;
}
