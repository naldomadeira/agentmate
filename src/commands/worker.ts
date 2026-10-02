import { defineCommand } from "citty";
import { runWorker } from "../jobs/worker.js";

/** Internal: the detached process that executes one job. Not meant to be run by hand. */
export default defineCommand({
  meta: { name: "worker", description: "Internal: execute a job", hidden: true },
  args: { id: { type: "positional", required: true, description: "Job id" } },
  async run({ args }) {
    await runWorker(args.id);
  },
});
