#!/usr/bin/env node
// Keeps the version in lockstep across the npm package, the shared runtime constant and the
// plugin manifests. Usage: node scripts/bump-version.mjs <x.y.z> | --check
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const JSON_VERSION = /("version"\s*:\s*")([^"]+)(")/;
const TS_VERSION = /(VERSION\s*=\s*")([^"]+)(")/;

/** Every file that carries the release version, relative to the repo root. */
export const VERSION_FILES = [
  "package.json",
  "src/lib/version.ts",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
];

const pattern = (file) => (file.endsWith(".ts") ? TS_VERSION : JSON_VERSION);

/** Reads the version a file declares, or null when it declares none. */
export function readVersion(root, file) {
  const match = pattern(file).exec(readFileSync(join(root, file), "utf8"));
  return match ? match[2] : null;
}

/** Rewrites the version of every carrier; returns the files that were updated. */
export function bumpVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error(`Version must look like x.y.z, got "${version}"`);
  }
  const changed = [];
  for (const file of VERSION_FILES) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    if (!pattern(file).test(text)) throw new Error(`${file} has no version field`);
    writeFileSync(path, text.replace(pattern(file), `$1${version}$3`));
    changed.push(file);
  }
  return changed;
}

/** Compares every carrier with package.json; `mismatches` lists the ones that differ. */
export function checkVersions(root) {
  const expected = readVersion(root, "package.json");
  const mismatches = [];
  for (const file of VERSION_FILES) {
    const version = readVersion(root, file);
    if (version !== expected) mismatches.push({ file, version });
  }
  return { expected, mismatches };
}

function main(argv) {
  const root = process.cwd();
  const [arg] = argv;
  if (arg === "--check") {
    const { expected, mismatches } = checkVersions(root);
    if (mismatches.length === 0) {
      console.log(`All ${VERSION_FILES.length} version files are at ${expected}`);
      return 0;
    }
    console.error(`Version mismatch (package.json is ${expected}):`);
    for (const { file, version } of mismatches) console.error(`  ${file}: ${version ?? "missing"}`);
    return 1;
  }
  if (!arg) {
    console.error("Usage: node scripts/bump-version.mjs <x.y.z> | --check");
    return 1;
  }
  try {
    const changed = bumpVersion(root, arg);
    console.log(`Bumped ${changed.length} files to ${arg}: ${changed.join(", ")}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
