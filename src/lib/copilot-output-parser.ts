import type { Usage } from "../agents/types.js";

type Obj = Record<string, unknown>;

/** What `parseCopilotOutput` makes of a GitHub Copilot CLI run (`-p … --output-format json`). */
export interface CopilotResult {
  resultText: string;
  /** The session id of the final `result` event, which `--resume` takes to continue the run. */
  sessionId: string | null;
  errors: string[];
  /** `resultText` is the last assistant text of a stream that ended without a `result` event. */
  partial?: boolean;
  /** A final `result` event was seen. */
  completed: boolean;
  /** The model that answered and the premium requests the run used. */
  usage?: Usage;
}

const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const MAX_RAW_CHARS = 300;

/** The data object of an event (`{ type, data: {...} }`), or an empty one. */
export const eventData = (event: Obj): Obj => (isObject(event["data"]) ? event["data"] : {});

/** One readable line for an error event: its `message`, else its `error`, else the type. */
export function copilotErrorText(event: Obj): string {
  const data = eventData(event);
  const error = data["error"];
  return (
    str(data["message"]).trim() ||
    (isObject(error) ? str(error["message"]).trim() : str(error).trim()) ||
    str(event["type"])
  );
}

const isErrorEvent = (type: string) => type === "error" || type.endsWith(".error");

/**
 * Reads the JSONL of `copilot -p --output-format json`: one `{ type, data }` event per line and a
 * final `{ type: "result", sessionId, exitCode, usage }`. The answer is the last non-empty
 * `assistant.message` content; text printed before the first `{` (an `Error: …` line) is an error.
 */
export function parseCopilotOutput(stdout: string, exitCode: number): CopilotResult {
  const result: CopilotResult = { resultText: "", sessionId: null, errors: [], completed: false };
  const raw: string[] = [];
  let lastText = "";
  let model = "";
  let premiumRequests: number | undefined;

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
    const data = eventData(event);
    if (type === "session.auto_mode_resolved") model = str(data["chosenModel"]) || model;
    else if (type === "assistant.message") {
      model = str(data["model"]) || model;
      const content = str(data["content"]).trim();
      if (content) lastText = content;
    } else if (type === "result") {
      result.completed = true;
      result.sessionId = str(event["sessionId"]) || null;
      const usage = event["usage"];
      if (isObject(usage) && typeof usage["premiumRequests"] === "number")
        premiumRequests = usage["premiumRequests"];
      const code = event["exitCode"];
      if (typeof code === "number" && code !== 0)
        result.errors.push(`copilot reported exit code ${code}`);
    } else if (isErrorEvent(type)) result.errors.push(copilotErrorText(event));
  }

  result.resultText = lastText;
  if (!result.completed && lastText) result.partial = true;
  if (!result.completed && !lastText && raw.length > 0)
    result.errors.push(raw.join(" ").slice(0, MAX_RAW_CHARS));
  else if (!result.completed && exitCode !== 0)
    result.errors.push(`copilot exited ${exitCode} without a final result`);
  if (model || premiumRequests !== undefined)
    result.usage = {
      ...(model ? { model } : {}),
      ...(premiumRequests !== undefined ? { premiumRequests } : {}),
    };
  return result;
}
