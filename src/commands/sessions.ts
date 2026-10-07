import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { userFacing } from "../lib/errors.js";
import { renderSession, renderSessionList } from "../jobs/render.js";
import {
  appendNotes,
  createSession,
  getSession,
  listSessions,
  readContext,
  readNotes,
  sessionJobCounts,
  sessionJobs,
  setContext,
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
        context: {
          type: "string",
          description: "Fixed session context text (spec, decisions, how to test)",
        },
        "context-file": {
          type: "string",
          description: "Path to a file containing fixed session context",
        },
      },
      run: userFacing(({ args }) => {
        const textArg = args.context;
        const fileArg = args["context-file"] || (args as Record<string, unknown>)["contextFile"];
        if (textArg && fileArg)
          throw new Error("Pass either --context or --context-file, not both.");
        let context = textArg;
        if (typeof fileArg === "string") {
          try {
            context = fs.readFileSync(path.resolve(fileArg), "utf8");
          } catch (error) {
            throw new Error(`Failed to read context file ${fileArg}: ${(error as Error).message}`);
          }
        }
        console.log(
          createSession({
            title: args.title,
            cwd: args.cwd ?? process.cwd(),
            context,
          }).id,
        );
      }),
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show a session: its context, notes (tail) and its jobs" },
      args: idArg,
      run: userFacing(({ args }) => {
        console.log(
          renderSession(
            getSession(args.id),
            readNotes(args.id),
            sessionJobs(args.id),
            readContext(args.id),
          ),
        );
      }),
    }),
    context: defineCommand({
      meta: {
        name: "context",
        description: "Set, append or view the fixed context for a session",
      },
      args: {
        ...idArg,
        text: { type: "positional", required: false, description: "Context text" },
        file: { type: "string", description: "Path to a file containing context" },
        append: { type: "boolean", description: "Append to existing context instead of replacing" },
      },
      run: userFacing(({ args }) => {
        if (args.text && args.file)
          throw new Error("Pass either context text or --file, not both.");
        let content = args.text;
        if (args.file) {
          try {
            content = fs.readFileSync(path.resolve(args.file), "utf8");
          } catch (error) {
            throw new Error(
              `Failed to read context file ${args.file}: ${(error as Error).message}`,
            );
          }
        }
        if (content === undefined) {
          if (args.append)
            throw new Error("Provide context text or --file to append to session context.");
          const existing = readContext(args.id);
          if (existing) console.log(existing);
          return;
        }
        setContext(args.id, content, args.append ? "append" : "replace");
        console.log(`${args.append ? "Appended to" : "Set"} context for session ${args.id}.`);
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
        console.log(renderSessionList(listSessions({ cwd: args.cwd }), sessionJobCounts()));
      }),
    }),
  },
});
