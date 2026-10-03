import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { userFacing } from "../lib/errors.js";
import { DEFAULT_INIT_FILES, applyInit, type InitResult } from "../lib/init.js";

const DESCRIBE: Record<InitResult["status"], string> = {
  created: "created",
  updated: "updated",
  unchanged: "already up to date",
  missing: "not found",
  outdated: "out of date",
};

/** `--files AGENTS.md,CLAUDE.md` as a list; blank entries are dropped. */
function parseFiles(value: string): string[] {
  const files = value
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  if (files.length === 0) throw new Error("files must be a comma-separated list of file names");
  return files;
}

export default defineCommand({
  meta: {
    name: "init",
    description:
      "Add or refresh the AgentMate block in AGENTS.md and CLAUDE.md so every agent in the repo knows the commands and job rules",
  },
  args: {
    cwd: { type: "string", description: "Repository directory (default: the current one)" },
    check: {
      type: "boolean",
      description: "Change nothing; exit 1 if a block is missing or out of date",
    },
    create: {
      type: "boolean",
      description:
        "Create the file(s) that do not exist (default files: AGENTS.md and a CLAUDE.md that imports it)",
    },
    files: {
      type: "string",
      description: `Comma-separated files to manage (default ${DEFAULT_INIT_FILES.join(",")})`,
    },
  },
  run: userFacing(({ args }) => {
    const cwd = path.resolve(args.cwd ?? process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
      throw new Error(`cwd is not a directory: ${cwd}`);
    let files: string[];
    if (args.files !== undefined) files = parseFiles(args.files);
    else if (args.create)
      files = [...DEFAULT_INIT_FILES]; // starts the missing ones: AGENTS.md and a CLAUDE.md that imports it
    else {
      // Without --files and --create only the files that exist are managed.
      const existing = DEFAULT_INIT_FILES.filter((file) => fs.existsSync(path.join(cwd, file)));
      files = existing.length > 0 ? existing : [...DEFAULT_INIT_FILES];
    }
    const results = applyInit({
      cwd,
      files,
      create: Boolean(args.create),
      check: Boolean(args.check),
    });
    for (const { file, status } of results) console.log(`${file}: ${DESCRIBE[status]}`);
    if (args.check) {
      if (results.some(({ status }) => status !== "unchanged")) {
        console.error("Run `agentmate init` to add or refresh the AgentMate block.");
        process.exitCode = 1;
      }
      return;
    }
    if (results.every(({ status }) => status === "missing"))
      console.log(
        "Nothing to update. Run `agentmate init --create` to start AGENTS.md and CLAUDE.md, or pass --files to pick others.",
      );
  }),
});
