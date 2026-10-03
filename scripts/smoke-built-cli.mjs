#!/usr/bin/env node
// Runs the built CLI (dist/cli.mjs) in an isolated HOME against a fake codex binary.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE_CODEX = `#!/usr/bin/env node
const emit = (e) => console.log(JSON.stringify(e));
emit({ type: "thread.started", thread_id: "smoke-1" });
emit({ type: "item.completed", item: { id: "i", type: "agent_message", text: "smoke-answer" } });
`;

const cli = resolve("dist", "cli.mjs");
const expected = /VERSION\s*=\s*"([^"]+)"/.exec(readFileSync("src/lib/version.ts", "utf8"))?.[1];
const failures = [];
const temp = mkdtempSync(join(tmpdir(), "agentmate-smoke-"));

try {
  const fake = join(temp, "fake-codex");
  writeFileSync(fake, FAKE_CODEX, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: temp,
    USERPROFILE: temp,
    AGENTMATE_HOME: join(temp, "state"),
    AGENTMATE_CODEX_BIN: fake,
    NO_COLOR: "1",
  };
  const run = (args, timeout = 60_000) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: temp, env, encoding: "utf8", timeout });

  const version = run(["--version"]);
  if (version.status !== 0 || version.stdout.trim() !== expected) {
    failures.push(
      `--version printed "${version.stdout.trim()}" (exit ${version.status}), expected ${expected}`,
    );
  }

  const help = run(["--help"]);
  if (help.status !== 0 || !/jobs/.test(help.stdout + help.stderr)) {
    failures.push(`--help exit ${help.status} or no "jobs" command listed`);
  }

  const doctor = run(["doctor"]);
  if (doctor.error || (doctor.status !== 0 && doctor.status !== 1)) {
    failures.push(
      `doctor exit ${doctor.status} ${doctor.error?.message ?? doctor.stderr.slice(0, 200)}`,
    );
  }

  const ask = run(["jobs", "ask", "codex", "hello", "--wait", "20s"], 60_000);
  if (ask.status !== 0 || !ask.stdout.includes("smoke-answer")) {
    failures.push(
      `jobs ask exit ${ask.status}, stdout "${ask.stdout.slice(0, 200)}", stderr "${ask.stderr.slice(0, 200)}"`,
    );
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`smoke:cli FAIL ${failure}`);
  process.exit(1);
}
console.log(`smoke:cli OK dist/cli.mjs ${expected}: --version, --help, doctor, jobs ask`);
