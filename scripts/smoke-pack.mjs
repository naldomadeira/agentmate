#!/usr/bin/env node
// Verifies the npm tarball ships what the plugin and CLI need and nothing it should not.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED_DIRS = ["dist/", "skills/", "agents/", "templates/", "hooks/", "assets/"];
const FORBIDDEN_DIRS = ["src/", "test/"];

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  shell: process.platform === "win32",
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
console.log(
  `smoke:pack OK ${pkg.name}@${pkg.version}: ${files.length} files, bins ${Object.keys(bins).join(", ")}`,
);
