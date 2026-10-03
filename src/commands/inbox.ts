import { defineCommand } from "citty";
import { userFacing } from "../lib/errors.js";
import {
  ackInbox,
  readInbox,
  renderInbox,
  renderInboxEntry,
  unreadInbox,
  type InboxEntry,
} from "../jobs/inbox.js";

const POLL_MS = 1_000;
const DEFAULT_LIMIT = 20;

const newest = (entries: InboxEntry[]): string | undefined => entries.at(-1)?.ts;

/** Polls every second and prints new lines until SIGINT. */
async function follow(cwd: string | undefined, ack: boolean, initial: InboxEntry[]) {
  let last = newest(initial) ?? new Date().toISOString();
  let stop = false;
  process.once("SIGINT", () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const entries = readInbox({ cwd, since: last });
    if (entries.length === 0) continue;
    for (const entry of entries) console.log(renderInboxEntry(entry));
    last = newest(entries) ?? last;
    if (ack && cwd !== undefined) ackInbox(cwd, last);
  }
}

export default defineCommand({
  meta: {
    name: "inbox",
    description:
      "Inbox: what finished, failed or reported in your background jobs (unread for this directory by default)",
  },
  args: {
    cwd: {
      type: "string",
      description: "Directory to read the inbox for (defaults to the current one)",
    },
    all: {
      type: "boolean",
      description: "Show the latest entries from every directory, read or not (never acknowledges)",
    },
    ack: {
      type: "boolean",
      default: true,
      description: "Mark what was printed as read (use --no-ack to only look)",
    },
    follow: { type: "boolean", description: "Keep running and print new entries every second" },
  },
  run: userFacing(async ({ args }) => {
    const cwd = args.all ? undefined : (args.cwd ?? process.cwd());
    const entries =
      cwd === undefined ? readInbox({ limit: DEFAULT_LIMIT }) : unreadInbox(cwd, DEFAULT_LIMIT);
    if (entries.length > 0 || !args.follow) console.log(renderInbox(entries));
    const last = newest(entries);
    if (args.ack && cwd !== undefined && last) ackInbox(cwd, last);
    if (args.follow) await follow(cwd, args.ack, entries);
  }),
});
