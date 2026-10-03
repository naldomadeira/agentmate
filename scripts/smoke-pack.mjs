#!/usr/bin/env node
// Verifies the npm tarball ships what the plugin and CLI need and nothing it should not, then
// installs the real tarball into a scratch project and runs the installed CLI.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_DIRS = ["dist/", "skills/", "agents/", "templates/", "hooks/"];
const FORBIDDEN_DIRS = ["src/", "test/"];

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const shell = process.platform === "win32";

if (!existsSync("dist")) {
  console.error("smoke:pack FAIL dist/ is missing: run `pnpm build` first");
  process.exit(1);
}

const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  shell,
});
const files = JSON.parse(raw)[0].files.map((f) => f.path.replace(/\\/g, "/"));
const failures = [];

const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
for (const [name, target] of Object.entries(bins)) {
  const path = target.replace(/^\.\//, "");
  if (!files.includes(path)) failures.push(`bin "${name}" -> ${path} is not in the tarball`);
}
for (const dir of REQUIRED_DIRS) {
  if (!files.some((f) => f.startsWith(dir))) failures.push(`no file under ${dir}`);
}
for (const dir of FORBIDDEN_DIRS) {
  const hit = files.find((f) => f.startsWith(dir));
  if (hit) failures.push(`tarball contains ${hit} (nothing under ${dir} may ship)`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`smoke:pack FAIL ${failure}`);
  process.exit(1);
}

/** Runs a command, returning stdout; throws with the captured output on failure. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell, timeout: 240_000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}): ${result.error?.message ?? ""}${result.stderr.slice(-600)}`,
    );
  }
  return result.stdout;
}

// Real install: pack the tarball, install it into a fresh project and run the installed CLI.
const packDir = mkdtempSync(join(tmpdir(), "agentmate-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "agentmate-install-"));
try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      process.cwd(),
    ),
  );
  const tarball = join(packDir, packed[0].filename);
  run("npm", ["init", "-y"], installDir);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDir);

  const bin = join(installDir, "node_modules", ".bin", shell ? "agentmate.cmd" : "agentmate");
  const env = { ...process.env, AGENTMATE_HOME: join(installDir, "state"), NO_COLOR: "1" };
  const exec = (args) =>
    spawnSync(bin, args, { cwd: installDir, env, encoding: "utf8", shell, timeout: 60_000 });

  const version = exec(["--version"]);
  if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
    failures.push(
      `installed --version printed "${version.stdout.trim()}" (exit ${version.status}), expected ${pkg.version}`,
    );
  }
  const help = exec(["--help"]);
  if (help.status !== 0 || !/jobs/.test(help.stdout + help.stderr)) {
    failures.push(`installed --help exit ${help.status} or no "jobs" command listed`);
  }
} catch (error) {
  failures.push(`real install failed: ${error.message}`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`smoke:pack FAIL ${failure}`);
  process.exit(1);
}
console.log(
  `smoke:pack OK ${pkg.name}@${pkg.version}: ${files.length} files, bins ${Object.keys(bins).join(", ")}, installed CLI --version/--help`,
);
