import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/lib/exec-runner.js";
import { INIT_BLOCK, applyInit } from "../src/lib/init.js";
import { readMarkedSection, upsertMarkedSection } from "../src/lib/marked-section.js";

const START = "<!-- agentmate:start -->";
const END = "<!-- agentmate:end -->";
const block = `${START}\n${INIT_BLOCK}\n${END}`;

describe("upsertMarkedSection", () => {
  it("appends a section to content that has none, after a blank line", () => {
    expect(upsertMarkedSection("# Repo\n", "agentmate", "body")).toBe(
      `# Repo\n\n${START}\nbody\n${END}\n`,
    );
  });

  it("starts a file when the content is empty", () => {
    expect(upsertMarkedSection("", "agentmate", "body")).toBe(`${START}\nbody\n${END}\n`);
  });

  it("is idempotent", () => {
    const once = upsertMarkedSection("# Repo\n\ntext\n", "agentmate", "body");
    expect(upsertMarkedSection(once, "agentmate", "body")).toBe(once);
  });

  it("replaces an old section in place and keeps everything around it", () => {
    const old = `before\n\n${START}\nold body\nmore old\n${END}\n\nafter\n`;
    expect(upsertMarkedSection(old, "agentmate", "new body")).toBe(
      `before\n\n${START}\nnew body\n${END}\n\nafter\n`,
    );
  });

  it("uses the id for the markers", () => {
    expect(upsertMarkedSection("", "other", "x")).toBe(
      "<!-- other:start -->\nx\n<!-- other:end -->\n",
    );
    // Another section's markers are not touched.
    const both = upsertMarkedSection(upsertMarkedSection("", "a", "1"), "b", "2");
    expect(upsertMarkedSection(both, "a", "3")).toContain("<!-- b:start -->\n2\n<!-- b:end -->");
  });

  it.each([
    ["a start without an end", `x\n${START}\nbody\n`, /without <!-- agentmate:end -->/],
    ["an end without a start", `x\nbody\n${END}\n`, /without <!-- agentmate:start -->/],
    ["an end before the start", `${END}\n${START}\n`, /comes before/],
    ["two sections", `${START}\na\n${END}\n${START}\nb\n${END}\n`, /more than once/],
  ])("throws on %s and never rewrites", (_name, content, message) => {
    expect(() => upsertMarkedSection(content, "agentmate", "body")).toThrow(message);
  });
});

describe("readMarkedSection", () => {
  it("returns the body, or null when there is no section", () => {
    expect(readMarkedSection(`x\n${START}\nbody\nline\n${END}\n`, "agentmate")).toBe("body\nline");
    expect(readMarkedSection("nothing", "agentmate")).toBeNull();
  });
});

describe("INIT_BLOCK", () => {
  it("fits in 25 lines with its markers and is English text that names the essentials", () => {
    expect(block.split("\n").length).toBeLessThanOrEqual(25);
    for (const word of ["/mate:", "$mate:", "agentmate inbox", "agentmate jobs list", "commit"])
      expect(INIT_BLOCK).toContain(word);
  });
});

describe("applyInit", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-init-"));
  });
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

  it("adds the block to existing files and leaves the rest alone", () => {
    write("AGENTS.md", "# Agents\n\nBe kind.\n");
    const results = applyInit({ cwd: dir, files: ["AGENTS.md"] });
    expect(results).toEqual([{ file: "AGENTS.md", status: "updated" }]);
    expect(read("AGENTS.md")).toBe(`# Agents\n\nBe kind.\n\n${block}\n`);
  });

  it("reports unchanged on a second run", () => {
    write("AGENTS.md", "# Agents\n");
    applyInit({ cwd: dir, files: ["AGENTS.md"] });
    const before = read("AGENTS.md");
    expect(applyInit({ cwd: dir, files: ["AGENTS.md"] })).toEqual([
      { file: "AGENTS.md", status: "unchanged" },
    ]);
    expect(read("AGENTS.md")).toBe(before);
  });

  it("refreshes an old block", () => {
    write("CLAUDE.md", `intro\n\n${START}\nstale text\n${END}\n\noutro\n`);
    expect(applyInit({ cwd: dir, files: ["CLAUDE.md"] })).toEqual([
      { file: "CLAUDE.md", status: "updated" },
    ]);
    expect(read("CLAUDE.md")).toBe(`intro\n\n${block}\n\noutro\n`);
  });

  it("does not create a file without create, and reports it missing", () => {
    expect(applyInit({ cwd: dir, files: ["AGENTS.md"] })).toEqual([
      { file: "AGENTS.md", status: "missing" },
    ]);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });

  it("creates a file with only the block when create is set", () => {
    expect(applyInit({ cwd: dir, files: ["AGENTS.md"], create: true })).toEqual([
      { file: "AGENTS.md", status: "created" },
    ]);
    expect(read("AGENTS.md")).toBe(`${block}\n`);
  });

  it("with check, writes nothing and reports drift", () => {
    write("AGENTS.md", "# Agents\n");
    write("CLAUDE.md", `${block}\n`);
    const results = applyInit({
      cwd: dir,
      files: ["AGENTS.md", "CLAUDE.md", "OTHER.md"],
      check: true,
      create: true,
    });
    expect(results).toEqual([
      { file: "AGENTS.md", status: "outdated" },
      { file: "CLAUDE.md", status: "unchanged" },
      { file: "OTHER.md", status: "missing" },
    ]);
    expect(read("AGENTS.md")).toBe("# Agents\n");
    expect(fs.existsSync(path.join(dir, "OTHER.md"))).toBe(false);
  });

  it("names the file when its markers are broken and leaves it untouched", () => {
    write("AGENTS.md", `x\n${START}\nno end\n`);
    expect(() => applyInit({ cwd: dir, files: ["AGENTS.md"] })).toThrow(
      /^AGENTS\.md: Found <!-- agentmate:start --> without <!-- agentmate:end -->/,
    );
    expect(read("AGENTS.md")).toBe(`x\n${START}\nno end\n`);
  });
});

describe("agentmate init", () => {
  let dir: string;
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const run = (...args: string[]) =>
    execCommand({
      command: process.execPath,
      args: ["--import", "tsx", cli, "init", "--cwd", dir, ...args],
      timeoutMs: 30_000,
    });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-init-cli-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("updates AGENTS.md, then --check passes, a hand edit makes --check fail, and init repairs it", async () => {
    const file = path.join(dir, "AGENTS.md");
    fs.writeFileSync(file, "# Agents\n");

    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("AGENTS.md: updated");
    // CLAUDE.md does not exist and is not created without --create.
    expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);

    const ok = await run("--check");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("AGENTS.md: already up to date");

    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("Do not commit", "Feel free to commit"),
    );
    const drift = await run("--check");
    expect(drift.exitCode).toBe(1);
    expect(drift.stdout).toContain("AGENTS.md: out of date");
    expect(drift.stderr).toContain("agentmate init");

    const fixed = await run();
    expect(fixed.stdout).toContain("AGENTS.md: updated");
    expect((await run("--check")).exitCode).toBe(0);
  }, 90_000);

  it("--create starts AGENTS.md when neither default file exists, and --files picks others", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "abm-init-empty-"));
    try {
      const exec = (...args: string[]) =>
        execCommand({
          command: process.execPath,
          args: ["--import", "tsx", cli, "init", "--cwd", empty, ...args],
          timeoutMs: 30_000,
        });
      const none = await exec();
      expect(none.exitCode).toBe(0);
      expect(none.stdout).toContain("Nothing to update");
      expect((await exec("--check")).exitCode).toBe(1);

      const created = await exec("--create");
      expect(created.stdout).toContain("AGENTS.md: created");
      expect(fs.existsSync(path.join(empty, "CLAUDE.md"))).toBe(false);

      const other = await exec("--create", "--files", "GEMINI.md");
      expect(other.stdout).toContain("GEMINI.md: created");
      expect(fs.readFileSync(path.join(empty, "GEMINI.md"), "utf8")).toContain(START);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }, 90_000);

  it("prints a broken marker as one error line and exits 1", async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "abm-init-broken-"));
    try {
      fs.writeFileSync(path.join(broken, "AGENTS.md"), `${START}\nno end\n`);
      const result = await execCommand({
        command: process.execPath,
        args: ["--import", "tsx", cli, "init", "--cwd", broken],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error: AGENTS.md: Found");
      expect(result.stderr).not.toContain("    at ");
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  }, 60_000);
});
