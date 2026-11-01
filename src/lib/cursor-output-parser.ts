import type { Usage } from "../agents/types.js";

type Obj = Record<string, unknown>;

/** What `parseCursorOutput` makes of a Cursor CLI run (`cursor-agent -p --output-format stream-json`). */
export interface CursorResult {
  resultText: string;
  /** The `session_id` of the `result` event, which `--resume` takes to continue the chat. */
  sessionId: string | null;
  errors: string[];
  /** `resultText` is the last assistant text of a stream that ended without a `result` event. */
  partial?: boolean;
  /** A final `result` event was seen. */
  completed: boolean;
  usage?: Usage;
}

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const MAX_RAW_CHARS = 300;

/** The text of an `assistant` event: its `message.content` text blocks joined. */
export function cursorAssistantText(event: Obj): string {
  const message = event["message"];
  if (!isObject(message)) return "";
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .map((block) => (block["type"] === "text" ? str(block["text"]) : ""))
    .join("");
}

/**
 * Reads the JSONL of `cursor-agent -p --output-format stream-json`: a `system` init (model,
 * session_id), `assistant` messages, `tool_call` started/completed events and a final `result` with
 * `is_error`, `result` text and `session_id`. Written against the documented format, never against the
 * real CLI. Text before the first `{` is an error.
 */
export function parseCursorOutput(stdout: string, exitCode: number): CursorResult {
  const result: CursorResult = { resultText: "", sessionId: null, errors: [], completed: false };
  const raw: string[] = [];
  let lastText = "";
  let model = "";

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
    if (type === "system") {
      model = str(event["model"]) || model;
      result.sessionId = str(event["session_id"]) || result.sessionId;
    } else if (type === "assistant") {
      const content = cursorAssistantText(event).trim();
      if (content) lastText = content;
    } else if (type === "result") {
      result.completed = true;
      result.sessionId = str(event["session_id"]) || result.sessionId;
      const answer = str(event["result"]).trim();
      if (answer) lastText = answer;
      if (event["is_error"] === true || str(event["subtype"]) === "error")
        result.errors.push(answer || "cursor reported an error");
    } else if (type === "error") {
      result.errors.push(
        str(event["message"]) || str(event["error"]) || "cursor reported an error",
      );
    }
  }

  result.resultText = result.errors.length > 0 && result.completed ? "" : lastText;
  if (!result.completed && lastText) result.partial = true;
  if (!result.completed && !lastText && raw.length > 0)
    result.errors.push(raw.join(" ").slice(0, MAX_RAW_CHARS));
  else if (!result.completed && exitCode !== 0)
    result.errors.push(`cursor exited ${exitCode} without a final result`);
  if (model) {
    const usage: Usage = { model };
    result.usage = usage;
  }
  return result;
}
