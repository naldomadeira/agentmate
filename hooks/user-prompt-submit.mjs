#!/usr/bin/env node
// AgentMate UserPromptSubmit hook: hands a Claude Code session the inbox entries (finished,
// failed or reported jobs) that arrived for this directory since it last looked, so it does not
// have to sit in `wait`. Plain Node ESM, no dependencies, fail-open: any error exits 0 silently.
// The inbox layout mirrors src/jobs/inbox.ts (copied on purpose; test/inbox.test.ts and
// test/hook.test.ts pin both sides).
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const COOLDOWN_MS = 10_000;
const FIRST_RUN_WINDOW_MS = 24 * 3_600_000;
const MAX_ENTRIES = 5;
const MAX_ENTRY_CHARS = 120;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), 1000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => (clearTimeout(timer), resolve(data)));
    process.stdin.on("error", () => (clearTimeout(timer), resolve(data)));
  });
}

function homeDir() {
  const env = process.env.AGENTMATE_HOME;
  return env && env.trim() ? env : join(homedir(), ".agentmate");
}

function realDir(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `dir` is `root` or lies below it. */
function within(root, dir) {
  if (typeof dir !== "string" || !dir) return false;
  const real = realDir(dir);
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

function oneLine(text, max) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function main() {
  if (process.env.AGENTMATE_HOOK_QUIET === "1") return;

  let cwd = process.cwd();
  try {
    const input = JSON.parse(await readStdin());
    if (input && typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    // no or invalid stdin: keep process.cwd()
  }

  const dir = homeDir();
  const root = realDir(cwd);
  const key = sha1(root);
  const now = Date.now();

  const stamp = join(dir, "hooks", `${key}.prompt.stamp`);
  try {
    const last = Date.parse(readFileSync(stamp, "utf8").trim());
    if (!Number.isNaN(last) && now >= last && now - last < COOLDOWN_MS) return;
  } catch {
    // no stamp yet
  }

  const cursorPath = join(dir, "inbox-cursors", `${key}.json`);
  let lastTs = null;
  try {
    const parsed = JSON.parse(readFileSync(cursorPath, "utf8"));
    if (typeof parsed?.lastTs === "string" && parsed.lastTs) lastTs = parsed.lastTs;
  } catch {
    // no cursor yet
  }
  // Without a cursor only the last day counts, so the first prompt here is not a flood of history.
  const since = lastTs ?? new Date(now - FIRST_RUN_WINDOW_MS).toISOString();

  let raw;
  try {
    raw = readFileSync(join(dir, "inbox.jsonl"), "utf8");
  } catch {
    return;
  }
  const unread = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.ts === "string" && entry.ts > since && within(root, entry.cwd)) {
        unread.push(entry);
      }
    } catch {
      // a line cut off mid-write
    }
  }
  if (unread.length === 0) return;
  unread.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const shown = unread.slice(0, MAX_ENTRIES);
  const lines = shown.map(
    (e) =>
      `${e.job} ${e.role ?? "custom"}/${e.provider ?? "?"} ${e.kind}: ${oneLine(e.text, MAX_ENTRY_CHARS)}`,
  );
  const more = unread.length - shown.length;
  const text =
    `AgentMate inbox: ${shown.length} new — ${lines.join("; ")}` +
    `${more > 0 ? `; ${more} more unread (run \`agentmate inbox\`)` : ""}. ` +
    "Run `agentmate jobs result <id>` for details.";

  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    }),
  );

  try {
    mkdirSync(join(dir, "inbox-cursors"), { recursive: true, mode: 0o700 });
    const tmp = `${cursorPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastTs: shown[shown.length - 1].ts }), { mode: 0o600 });
    renameSync(tmp, cursorPath);
    mkdirSync(join(dir, "hooks"), { recursive: true, mode: 0o700 });
    writeFileSync(stamp, new Date(now).toISOString());
  } catch {
    // an unwritable cursor only means the entries are shown again
  }
}

try {
  await main();
} catch {
  // fail open
}
process.exit(0);
