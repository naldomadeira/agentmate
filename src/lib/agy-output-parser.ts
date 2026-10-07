type Obj = Record<string, unknown>;

/** What `parseAgyOutput` makes of an Antigravity CLI (`agy`) run. */
export interface AgyResult {
  resultText: string;
  /** The conversation id, which `--conversation` takes to continue the run. */
  sessionId: string | null;
  errors: string[];
  /**
   * `resultText` is not a trustworthy final answer: the run ended without a result, or reported an
   * error next to its text.
   */
  partial?: boolean;
  /** A final `result` event or the single JSON object of `--output-format json` was seen. */
  completed: boolean;
  usage?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
}

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const MAX_ID_CHARS = 256;
const MAX_RAW_CHARS = 300;

/** `{ message }`, `{ type, message }` or a bare string, as one readable line. */
export function agyErrorMessage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isObject(value)) return "";
  const message = str(value["message"]).trim();
  const type = str(value["type"]).trim();
  if (message) return type && !message.includes(type) ? `${type}: ${message}` : message;
  return type;
}

/** The payload of a stream event: `{ event: "x", x: {...} }` carries it under its own name, else the event itself. */
export function eventBody(event: Obj): Obj {
  const body = event[str(event["event"])];
  return isObject(body) ? body : event;
}

/** The conversation id an event or payload carries, or "". */
export function conversationId(body: Obj): string {
  const id = str(body["conversation_id"]) || str(body["conversationId"]);
  return id.length <= MAX_ID_CHARS ? id : "";
}

/** The failure a result payload reports (its `error`, else its non-success `status`), or "". */
export function payloadFailure(payload: Obj): string {
  const error = payload["error"];
  const status = str(payload["status"]).trim();
  const message = error === undefined || error === null ? "" : agyErrorMessage(error);
  if (message) return message;
  if (error !== undefined && error !== null) return "agy reported an error";
  return status && status.toUpperCase() !== "SUCCESS" ? `agy reported status ${status}` : "";
}

/**
 * Parses the output of `agy -p`: either the single JSON object of `--output-format json`
 * (`{ status, response, error?, conversation_id }`, possibly after banner noise, so parsing starts at
 * the first `{`) or `stream-json` (one event per line: `init`, `step_update` and a final `result`
 * whose body is that same object). The final text is the payload's `response`, else the
 * `agent_response` text deltas streamed so far. A payload whose `status` is not `SUCCESS` or that
 * carries an `error` keeps its text with `partial: true`; a run with no result at all (cut off, or
 * output that holds no JSON) is an error, with `partial: true` when text streamed before it ended.
 */
export function parseAgyOutput(stdout: string, exitCode: number): AgyResult {
  const result: AgyResult = { resultText: "", sessionId: null, errors: [], completed: false };
  const trimmed = stdout.trim();
  if (!trimmed) {
    result.errors.push("Empty output from agy");
    return result;
  }

  const events: Obj[] = [];
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (isObject(value) && typeof value["event"] === "string") events.push(value);
    } catch {
      // banner lines and the pieces of a pretty-printed object do not break a stream
    }
  }
  if (events.length > 0) return fromStream(events, exitCode, result);

  const start = trimmed.indexOf("{");
  if (start >= 0) {
    try {
      const value: unknown = JSON.parse(trimmed.slice(start));
      if (isObject(value)) return fromObject(value, result);
    } catch {
      // not a JSON object either
    }
  }
  result.errors.push(
    `agy did not return parseable JSON (exit ${exitCode}): ${trimmed.slice(0, MAX_RAW_CHARS)}`,
  );
  return result;
}

function missingResult(exitCode: number): string {
  return exitCode === 0
    ? "agy ended without a final result"
    : `agy exited ${exitCode} without a final result`;
}

function fromStream(events: Obj[], exitCode: number, result: AgyResult): AgyResult {
  /** Agent-response text per step, in step order of first appearance. */
  const texts = new Map<number, string>();
  let final: Obj | undefined;
  for (const event of events) {
    const body = eventBody(event);
    const id = conversationId(body);
    if (id) result.sessionId = id;
    if (event["event"] === "init" && typeof body["model"] === "string") {
      result.usage = { model: body["model"] };
    }
    if (event["event"] === "result" && body !== event) final = body;
    else if (event["event"] === "step_update" && body["step_type"] === "agent_response") {
      const delta = str(body["text_delta"]);
      const index = typeof body["step_index"] === "number" ? body["step_index"] : -1;
      if (delta) texts.set(index, (texts.get(index) ?? "") + delta);
    }
  }
  const streamed = [...texts.values()].join("\n\n");

  if (!final) {
    // Cut off (timeout, cancel, crash): what the agent said so far is the partial output.
    result.errors.push(missingResult(exitCode));
    if (streamed) {
      result.resultText = streamed;
      result.partial = true;
    }
    return result;
  }
  return fromPayload(final, result, streamed);
}

/** `--output-format json`: one object. */
function fromObject(parsed: Obj, result: AgyResult): AgyResult {
  const id = conversationId(parsed);
  if (id) result.sessionId = id;
  return fromPayload(parsed, result, "");
}

function fromPayload(payload: Obj, result: AgyResult, streamed: string): AgyResult {
  result.completed = true;
  const failure = payloadFailure(payload);
  if (failure) result.errors.push(failure);
  result.resultText = str(payload["response"]).trim() || streamed;
  // A failed run that still printed text is not a finished answer; the caller keeps the text and ends in error.
  if (failure && result.resultText) result.partial = true;
  return result;
}
