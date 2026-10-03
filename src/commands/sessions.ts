import { defineCommand } from "citty";
import { userFacing } from "../lib/errors.js";
import { renderSession, renderSessionList } from "../jobs/render.js";
import {
  appendNotes,
  createSession,
  getSession,
  listSessions,
  readNotes,
  sessionJobs,
} from "../jobs/sessions.js";

const idArg = { id: { type: "positional", required: true, description: "Session id" } } as const;

export default defineCommand({
  meta: {
    name: "sessions",
    description:
      "Sessions: shared notes and context across jobs and agents (workers read the notes, so keep them short)",
  },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: "Create a session and print its id" },
      args: {
        title: { type: "positional", required: true, description: "A short name for the work" },
        cwd: { type: "string", description: "Working directory (defaults to the current one)" },
      },
      run: userFacing(({ args }) => {
        console.log(createSession({ title: args.title, cwd: args.cwd ?? process.cwd() }).id);
      }),
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show a session: its notes (tail) and its jobs" },
      args: idArg,
      run: userFacing(({ args }) => {
        console.log(renderSession(getSession(args.id), readNotes(args.id), sessionJobs(args.id)));
      }),
    }),
    notes: defineCommand({
      meta: {
        name: "notes",
        description: "Append a short, factual note that every worker in the session will read",
      },
      args: {
        ...idArg,
        text: { type: "positional", required: true, description: "The note" },
        author: { type: "string", description: 'Who writes it (default "host")' },
      },
      run: userFacing(({ args }) => {
        appendNotes(args.id, args.text, args.author ?? "host");
        console.log(`Added a note to session ${args.id}.`);
      }),
    }),
    list: defineCommand({
      meta: { name: "list", description: "List recent sessions" },
      args: { cwd: { type: "string", description: "Only sessions about this directory" } },
      run: userFacing(({ args }) => {
        console.log(renderSessionList(listSessions({ cwd: args.cwd })));
      }),
    }),
  },
});
