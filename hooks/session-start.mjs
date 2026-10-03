#!/usr/bin/env node
// AgentMate SessionStart hook: tells a new Claude Code session which background jobs
// finished (or went stale) in this directory since the last session here.
// Plain Node ESM, no dependencies, fail-open: any error exits 0 without output.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const COOLDOWN_MS = 120_000;
const FIRST_RUN_WINDOW_MS = 24 * 3_600_000;
const MAX_CHARS = 400;
// Keep in sync with TERMINAL in src/jobs/store.ts (test/hook.test.ts enforces it).
const TERMINAL = new Set(["done", "error", "canceled", "timeout", "quota_exhausted"]);

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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  // Recycled-pid guard: when the command line is readable it must belong to a worker.
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("worker");
  } catch {
    return true;
  }
}

function realDir(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `jobCwd` is `root` or lies below it. */
function within(root, jobCwd) {
  if (typeof jobCwd !== "string" || !jobCwd) return false;
  const dir = realDir(jobCwd);
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function readJobs(dir) {
  const jobs = [];
  let ids = [];
  try {
    ids = readdirSync(join(dir, "jobs"));
  } catch {
    // no jobs yet; the inbox may still have something
  }
  for (const id of ids) {
    try {
      const job = JSON.parse(readFileSync(join(dir, "jobs", id, "job.json"), "utf8"));
      if (job && typeof job === "object" && typeof job.id === "string") jobs.push(job);
    } catch {
      // unreadable or corrupt job: skip it
    }
  }
  return jobs;
}

/** Inbox entries for `root` newer than its cursor (see src/jobs/inbox.ts; copied, not imported). */
function unreadInbox(dir, root, fallbackSince) {
  try {
    let since = new Date(fallbackSince).toISOString();
    try {
      const file = join(
        dir,
        "inbox-cursors",
        `${createHash("sha1").update(root).digest("hex")}.json`,
      );
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed?.lastTs === "string" && parsed.lastTs) since = parsed.lastTs;
    } catch {
      // no cursor: only entries since the previous session here
    }
    let count = 0;
    for (const line of readFileSync(join(dir, "inbox.jsonl"), "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.ts === "string" && entry.ts > since && within(root, entry.cwd))
          count++;
      } catch {
        // blank or truncated line
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function compose(finished, running, stale, now, unread = 0) {
  const inbox = unread ? ` · ${unread} unread inbox ${unread === 1 ? "entry" : "entries"}` : "";
  const head = (n) =>
    `AgentMate: ${n} job${n === 1 ? "" : "s"} finished since your last session here: `;
  const tail = (n) =>
    `${n ? ` … and ${n} more` : ""} · ${running} running · ${stale} stale${inbox}. Run \`agentmate jobs list\`${finished.length ? " or `agentmate jobs result <id>`" : ""}.`;
  if (finished.length === 0) {
    if (!running && !stale) return `AgentMate:${inbox.replace(" ·", "")}. Run \`agentmate inbox\`.`;
    return `AgentMate: ${running} running · ${stale} stale${inbox}. Run \`agentmate jobs list\`.`;
  }
  const entries = finished.map(
    (j) =>
      `${j.id} ${j.status} (${j.role ?? "custom"}, ${j.provider ?? "?"}, ${ago(now - Date.parse(j.finishedAt))})${j.status === "quota_exhausted" ? " needs hand-off" : ""}`,
  );
  for (let shown = entries.length; shown >= 1; shown--) {
    const text =
      head(finished.length) + entries.slice(0, shown).join(", ") + tail(entries.length - shown);
    if (text.length <= MAX_CHARS) return text;
  }
  return (head(finished.length) + entries[0] + tail(entries.length - 1)).slice(0, MAX_CHARS);
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
  const now = Date.now();
  const stamp = join(dir, "hooks", `${createHash("sha1").update(cwd).digest("hex")}.stamp`);

  let previous = now - FIRST_RUN_WINDOW_MS;
  try {
    const last = Date.parse(readFileSync(stamp, "utf8").trim());
    if (!Number.isNaN(last)) {
      if (now - last < COOLDOWN_MS && now >= last) return;
      previous = last;
    }
  } catch {
    // first run in this directory
  }
  try {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(stamp, new Date(now).toISOString());
  } catch {
    // an unwritable stamp only disables the cooldown
  }

  const jobs = readJobs(dir);
  const root = realDir(cwd);
  const inScope = new Set(jobs.filter((j) => within(root, j.cwd)).map((j) => j.id));
  // Children of in-scope jobs (workflow steps) count towards running/stale, not the finished list.
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of jobs) {
      if (!inScope.has(j.id) && j.parentJob && inScope.has(j.parentJob)) {
        inScope.add(j.id);
        grew = true;
      }
    }
  }
  const scoped = jobs.filter((j) => inScope.has(j.id));

  const finished = scoped
    .filter((j) => !j.parentJob && TERMINAL.has(j.status) && Date.parse(j.finishedAt) > previous)
    .sort(
      (a, b) =>
        Number(b.status === "quota_exhausted") - Number(a.status === "quota_exhausted") ||
        Date.parse(b.finishedAt) - Date.parse(a.finishedAt),
    );
  const active = scoped.filter((j) => j.status === "running");
  const stale = active.filter((j) => !pidAlive(j.workerPid)).length;
  const running = active.length - stale;

  const unread = unreadInbox(dir, root, previous);

  if (finished.length === 0 && running === 0 && stale === 0 && unread === 0) return;

  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: compose(finished, running, stale, now, unread),
      },
    }),
  );
}

try {
  await main();
} catch {
  // fail open
}
process.exit(0);
