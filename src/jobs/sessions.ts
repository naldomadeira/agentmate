import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homeDir, newJobId, readJob, type Job } from "./store.js";

/** A session groups jobs across agents and carries short shared notes that workers read in their briefing. */
export interface Session {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  /** Ids of the jobs started in the session, oldest first. */
  jobs: string[];
}

const DEFAULT_NOTES_CHARS = 4_000;
const DEFAULT_LIST_LIMIT = 20;

export function sessionDir(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
  return path.join(homeDir(), "sessions", id);
}

const sessionFile = (id: string) => path.join(sessionDir(id), "session.json");
const notesFile = (id: string) => path.join(sessionDir(id), "notes.md");

/** Atomic replace, like job.json: readers never observe a half-written session. */
function writeSession(session: Session): void {
  fs.mkdirSync(path.join(homeDir(), "sessions"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionDir(session.id), { recursive: true, mode: 0o700 });
  const tmp = `${sessionFile(session.id)}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, sessionFile(session.id));
}

function readSession(id: string): Session | null {
  const file = sessionFile(id); // validates the id; must stay outside the try so a bad id throws
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Session;
  } catch {
    return null;
  }
}

export function createSession(options: { title: string; cwd: string }): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: newJobId(),
    title: options.title,
    cwd: options.cwd,
    createdAt: now,
    updatedAt: now,
    jobs: [],
  };
  writeSession(session);
  return session;
}

export function getSession(id: string): Session {
  const session = readSession(id);
  if (!session) throw new Error(`Session not found: ${id}. Run \`agentmate sessions list\`.`);
  return session;
}

/** Newest first. */
export function listSessions(options: { cwd?: string; limit?: number } = {}): Session[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(path.join(homeDir(), "sessions"));
  } catch {
    return [];
  }
  return ids
    .filter((id) => /^[a-z0-9-]+$/.test(id))
    .map((id) => readSession(id))
    .filter((session): session is Session => session !== null)
    .filter((session) => !options.cwd || session.cwd === options.cwd)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, options.limit ?? DEFAULT_LIST_LIMIT);
}

/** Appends `\n### <ISO> · <author>\n<text>\n` to the session notes. */
export function appendNotes(id: string, text: string, author: string): void {
  const session = getSession(id);
  const now = new Date().toISOString();
  fs.appendFileSync(notesFile(id), `\n### ${now} · ${author}\n${text}\n`, { mode: 0o600 });
  writeSession({ ...session, updatedAt: now });
}

/** The last `maxChars` characters of the notes; empty when there are none. */
export function readNotes(id: string, maxChars = DEFAULT_NOTES_CHARS): string {
  getSession(id);
  try {
    const text = fs.readFileSync(notesFile(id), "utf8");
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } catch {
    return "";
  }
}

/** Registers a job in the session (once). */
export function attachJob(id: string, jobId: string): void {
  const session = getSession(id);
  if (session.jobs.includes(jobId)) return;
  writeSession({ ...session, jobs: [...session.jobs, jobId], updatedAt: new Date().toISOString() });
}

/** The session's jobs in start order; ids whose job.json is gone are skipped. */
export function sessionJobs(id: string): Job[] {
  return getSession(id)
    .jobs.map((jobId) => readJob(jobId))
    .filter((job): job is Job => job !== null);
}

/** `## Shared session notes` header and notes in front of a prompt; the prompt itself when there are no notes. */
export function withSessionNotes(id: string, prompt: string): string {
  const session = getSession(id);
  const notes = readNotes(id).trim();
  if (!notes) return prompt;
  return `## Shared session notes (session ${session.id}: ${session.title})\n${notes}\n\n---\n\n${prompt}`;
}
