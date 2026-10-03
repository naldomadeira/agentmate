import { logger } from "./logger.js";
import type { ClaudeResult } from "./types.js";

type Obj = Record<string, unknown>;

function lastWhere<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return items[i];
  return undefined;
}

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The concatenated `text` parts of a content array (stream-json assistant messages). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Obj => isObject(part) && part["type"] === "text")
    .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
    .join("");
}

/**
 * Parses the output of `claude -p`: either the legacy single JSON object (`--output-format json`)
 * or stream-json (`--output-format stream-json --verbose`, one JSON object per line). For a stream
 * the last `result` event decides: its `result` text (or, if it has none, the text of the last
 * assistant message), `session_id` and `total_cost_usd`. A stream with no `result` event returns the
 * last assistant text as `resultText` with `partial: true`. An `is_error` result is reported in
 * `errors` and leaves `resultText` empty.
 */
export function parseClaudeOutput(jsonOutput: string): ClaudeResult {
  const result: ClaudeResult = {
    resultText: "",
    sessionId: null,
    costUsd: null,
    errors: [],
  };

  const trimmed = jsonOutput.trim();
  if (!trimmed) {
    result.errors.push("Empty output from Claude CLI");
    return result;
  }

  let parsed: Obj;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isObject(value)) throw new Error("not an object");
    parsed = value;
  } catch {
    const events: Obj[] = [];
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isObject(value)) events.push(value);
      } catch {
        // stray non-JSON lines (warnings) do not break a stream
      }
    }
    if (events.length === 0) {
      // Claude may have output plain text instead of JSON
      logger.debug("Failed to parse Claude output as JSON, using raw text");
      result.resultText = trimmed;
      return result;
    }
    return fromStream(events, result);
  }
  // A lone stream event (a run cut off after one line) is not a legacy result object.
  if (typeof parsed["type"] === "string" && parsed["type"] !== "result")
    return fromStream([parsed], result);
  return fromObject(parsed, result);
}

/** Stream-json: the last `result` event wins; a stream cut off before one yields the last assistant text, flagged `partial`. */
function fromStream(events: Obj[], result: ClaudeResult): ClaudeResult {
  const last = lastWhere(events, (event) => event["type"] === "result");
  for (const event of events) {
    if (typeof event["session_id"] === "string") result.sessionId = event["session_id"];
  }
  if (!last) {
    // Cut off (timeout, cancel, crash): the last thing the assistant said is the partial output.
    const text = lastAssistantText(events);
    if (text) {
      result.resultText = text;
      result.partial = true;
    }
    return result;
  }

  if (typeof last["session_id"] === "string") result.sessionId = last["session_id"];
  if (typeof last["total_cost_usd"] === "number") result.costUsd = last["total_cost_usd"];

  if (last["is_error"] === true) {
    const text = typeof last["result"] === "string" ? last["result"].trim() : "";
    const subtype = typeof last["subtype"] === "string" ? last["subtype"] : "";
    result.errors.push(text || subtype || "Claude reported an error");
    return result;
  }

  if (typeof last["result"] === "string" && last["result"]) {
    result.resultText = last["result"];
    return result;
  }
  result.resultText = lastAssistantText(events);
  return result;
}

/** The text of the last assistant message that has any; empty when there is none. */
function lastAssistantText(events: Obj[]): string {
  const lastAssistant = lastWhere(
    events,
    (event) => event["type"] === "assistant" && contentText(messageOf(event)["content"]) !== "",
  );
  return lastAssistant ? contentText(messageOf(lastAssistant)["content"]) : "";
}

const messageOf = (event: Obj): Obj => (isObject(event["message"]) ? event["message"] : {});

/** Legacy `--output-format json`: one object, in a few historical shapes. */
function fromObject(parsed: Obj, result: ClaudeResult): ClaudeResult {
  // Extract result text from structured output
  // Claude JSON format: { result: string, ... } or { result: { content: [...] }, ... }
  const resultField = parsed["result"];
  if (typeof resultField === "string") {
    result.resultText = resultField;
  } else if (resultField && typeof resultField === "object") {
    const content = (resultField as Record<string, unknown>)["content"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      result.resultText = content
        .filter((c) => c["type"] === "text")
        .map((c) => c["text"] as string)
        .join("\n");
    }
  }

  // If result field didn't yield text, try other common fields
  if (!result.resultText) {
    const message = parsed["message"] as string | undefined;
    const text = parsed["text"] as string | undefined;
    const output = parsed["output"] as string | undefined;
    result.resultText = message ?? text ?? output ?? "";
  }

  // If still nothing, stringify the whole response
  if (!result.resultText && Object.keys(parsed).length > 0) {
    result.resultText = JSON.stringify(parsed, null, 2);
  }

  // Extract metadata
  result.sessionId = (parsed["session_id"] as string) ?? (parsed["sessionId"] as string) ?? null;
  result.costUsd =
    (parsed["cost_usd"] as number) ??
    (parsed["total_cost_usd"] as number) ??
    (parsed["costUsd"] as number) ??
    null;

  // Check for errors
  const error = parsed["error"] as string | Record<string, unknown> | undefined;
  if (error) {
    const msg =
      typeof error === "string" ? error : ((error["message"] as string) ?? JSON.stringify(error));
    result.errors.push(msg);
  }

  if (parsed["type"] === "result" && parsed["is_error"] === true) {
    const text = typeof parsed["result"] === "string" ? parsed["result"].trim() : "";
    const subtype = typeof parsed["subtype"] === "string" ? parsed["subtype"] : "";
    result.errors.push(text || subtype || "Claude reported an error");
    result.resultText = "";
  }

  return result;
}
