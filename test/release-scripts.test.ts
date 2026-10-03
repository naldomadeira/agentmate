import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");

type Mismatch = { file: string; version: string | null };
type BumpModule = {
  VERSION_FILES: string[];
  bumpVersion: (root: string, version: string) => string[];
  checkVersions: (root: string) => { expected: string; mismatches: Mismatch[] };
};

const load = async () =>
  (await import(pathToFileURL(resolve(repo, "scripts/bump-version.mjs")).href)) as BumpModule;

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "abm-bump-"));
  const { VERSION_FILES } = await load();
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(resolve(repo, file), join(root, file));
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bump-version", () => {
  it("covers the five version carriers", async () => {
    expect((await load()).VERSION_FILES.sort()).toEqual(
      [
        ".agents/plugins/marketplace.json",
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        "package.json",
        "src/lib/version.ts",
      ].sort(),
    );
  });

  it("passes --check on aligned files", async () => {
    const { checkVersions } = await load();

    expect(checkVersions(root).mismatches).toEqual([]);
  });

  it("bumps every file and keeps the rest of each file intact", async () => {
    const { bumpVersion, checkVersions } = await load();
    const before = readFileSync(join(root, "package.json"), "utf8");

    const changed = bumpVersion(root, "9.8.7");

    expect(changed).toHaveLength(5);
    expect(checkVersions(root)).toEqual({ expected: "9.8.7", mismatches: [] });
    expect(readFileSync(join(root, "src/lib/version.ts"), "utf8")).toContain('"9.8.7"');
    const after = readFileSync(join(root, "package.json"), "utf8");
    expect(after).toBe(before.replace(/"version": "[^"]+"/, '"version": "9.8.7"'));
  });

  it("reports the files whose version differs from package.json", async () => {
    const { checkVersions } = await load();
    const manifest = join(root, ".codex-plugin/plugin.json");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(/"version": "[^"]+"/, '"version": "0.0.1"'),
    );
    const source = join(root, "src/lib/version.ts");
    writeFileSync(source, 'export const VERSION = "0.0.2";\n');

    const { mismatches } = checkVersions(root);

    expect(mismatches.map((m) => m.file).sort()).toEqual([
      ".codex-plugin/plugin.json",
      "src/lib/version.ts",
    ]);
  });

  it("rejects a malformed version", async () => {
    const { bumpVersion } = await load();

    expect(() => bumpVersion(root, "v1")).toThrow(/x\.y\.z/);
  });
});
