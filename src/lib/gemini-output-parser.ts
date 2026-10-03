import { logger } from "./logger.js";

type Obj = Record<string, unknown>;

/** What `parseGeminiOutput` makes of a Gemini CLI run. */
export interface GeminiResult {
  resultText: string;
  sessionId: string | null;
  errors: string[];
  /** `resultText` is what the stream printed before it ended without a `result` event. */
  partial?: boolean;
}

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Roles that mean the assistant is speaking (the API calls it `model`). */
const ASSISTANT_ROLES = new Set(["assistant", "model", "gemini"]);

/**
 * The text of one message event. The documented field is `content`; `text`, `delta` (a string, since
 * the real stream also uses `delta: true` as a flag) and `response` are tolerated, and `content` may
 * be a list of parts.
 */
export function messageText(event: Obj): string {
  for (const key of ["content", "text", "delta", "response"]) {
    const value = event[key];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) {
      const joined = value
        .map((part) => (typeof part === "string" ? part : isObject(part) ? str(part["text"]) : ""))
        .join("");
      if (joined) return joined;
    }
  }
  return "";
}

/** True for a message event that carries assistant text (a missing role counts as assistant). */
export function isAssistantMessage(event: Obj): boolean {
  if (event["type"] !== "message") return false;
  const role = event["role"];
  return role === undefined || (typeof role === "string" && ASSISTANT_ROLES.has(role));
}

/** `{ message }`, `{ type, message }` or a bare string, as one readable line. */
export function errorMessage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isObject(value)) return "";
  const message = str(value["message"]).trim();
  const type = str(value["type"]).trim();
  if (message) return type && !message.includes(type) ? `${type}: ${message}` : message;
  return type;
}

/** The error an `error` or `result` event reports: its `error` object or string, else its `message`. */
export function eventErrorText(event: Obj): string {
  return errorMessage(event["error"]) || str(event["message"]).trim();
}

/**
 * Parses the output of `gemini -p`: either the single JSON object of `--output-format json`
 * (`{ session_id?, response?, stats?, error? }`) or stream-json (one event per line: `init`,
 * `message`, `tool_use`, `tool_result`, `error`, `result`). For a stream the final text is the
 * `result` event's `response` when it has one, else the assistant message chunks concatenated; a
 * stream with no `result` event returns the chunks so far with `partial: true`.
 */
export function parseGeminiOutput(stdout: string): GeminiResult {
  const result: GeminiResult = { resultText: "", sessionId: null, errors: [] };
  const trimmed = stdout.trim();
  if (!trimmed) {
    result.errors.push("Empty output from Gemini CLI");
    return result;
  }

  try {
    const value: unknown = JSON.parse(trimmed);
    if (isObject(value)) {
      // A lone stream event (a run cut off after one line) is not the single-object format.
      if (typeof value["type"] === "string") return fromStream([value], result);
      return fromObject(value, result);
    }
  } catch {
    // not one JSON document: try JSONL below
  }

  const events: Obj[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) events.push(value);
    } catch {
      // stray non-JSON lines (warnings, banners) do not break a stream
    }
  }
  if (events.length === 0) {
    logger.debug("Failed to parse Gemini output as JSON, using raw text");
    result.resultText = trimmed;
    return result;
  }
  return fromStream(events, result);
}

function fromStream(events: Obj[], result: GeminiResult): GeminiResult {
  const chunks: string[] = [];
  let final: Obj | undefined;
  for (const event of events) {
    const sid = str(event["session_id"]) || str(event["sessionId"]);
    if (sid) result.sessionId = sid;
    switch (event["type"]) {
      case "message":
        if (isAssistantMessage(event)) {
          const text = messageText(event);
          // A complete (non-delta) message after earlier text is a new paragraph, not a continuation.
          if (text)
            chunks.push(event["delta"] === false && chunks.length > 0 ? `\n\n${text}` : text);
        }
        break;
      case "error": {
        result.errors.push(eventErrorText(event) || "Gemini reported an error");
        break;
      }
      case "result":
        final = event;
        break;
      default:
        break;
    }
  }
  const streamed = chunks.join("");

  if (!final) {
    // Cut off (timeout, cancel, crash): what the assistant said so far is the partial output.
    if (streamed) {
      result.resultText = streamed;
      result.partial = true;
    }
    return result;
  }

  const failed = final["error"] !== undefined || final["status"] === "error";
  if (failed) result.errors.push(eventErrorText(final) || "Gemini reported an error");
  result.resultText = str(final["response"]) || streamed;
  return result;
}

/** `--output-format json`: one object. */
function fromObject(parsed: Obj, result: GeminiResult): GeminiResult {
  result.sessionId = str(parsed["session_id"]) || str(parsed["sessionId"]) || null;
  const error = parsed["error"];
  if (error !== undefined && error !== null) {
    result.errors.push(errorMessage(error) || "Gemini reported an error");
  }
  result.resultText = str(parsed["response"]);
  if (!result.resultText && result.errors.length === 0) {
    result.resultText = str(parsed["text"]) || str(parsed["result"]) || str(parsed["output"]);
  }
  return result;
}
