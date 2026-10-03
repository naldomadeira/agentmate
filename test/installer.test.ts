import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import consola from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_NAMES, installClaudeCommands, installCodexPrompts } from "../src/lib/installer.js";

const root = resolve(import.meta.dirname, "..");
const template = (dir: string, name: string) =>
  readFileSync(resolve(root, "templates", dir, `${name}.md`), "utf8");

let tmp: string;
let saved: Record<string, string | undefined>;
let prompt: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "abm-installer-"));
  saved = { HOME: process.env["HOME"], CODEX_HOME: process.env["CODEX_HOME"] };
  process.env["HOME"] = tmp;
  process.env["CODEX_HOME"] = join(tmp, ".codex");
  vi.spyOn(console, "log").mockImplementation(() => {});
  // A prompt on a fresh directory would hang a non-interactive run, so fail loudly instead.
  prompt = vi.spyOn(consola, "prompt").mockRejectedValue(new Error("unexpected prompt"));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("installClaudeCommands", () => {
  it("copies the eight templates to ~/.claude/commands for global scope", async () => {
    const names = await installClaudeCommands("global");

    expect(COMMAND_NAMES).toHaveLength(8);
    expect(names).toEqual(COMMAND_NAMES.map((name) => `/${name}`));
    for (const name of COMMAND_NAMES) {
      const installed = readFileSync(join(tmp, ".claude", "commands", `${name}.md`), "utf8");
      expect(installed).toBe(template("claude-commands", name));
      expect(installed).toMatch(/^---\ndescription: .+\nargument-hint: .+\n---\n/);
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it("copies to ./.claude/commands for local scope", async () => {
    const project = join(tmp, "project");
    mkdirSync(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);

    await installClaudeCommands("local");

    expect(existsSync(join(project, ".claude", "commands", "ask.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "commands", "ask.md"))).toBe(false);
  });

  it("asks before overwriting and keeps the file when declined", async () => {
    const dir = join(tmp, ".claude", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ask.md"), "custom");
    prompt.mockResolvedValue(false);

    const names = await installClaudeCommands("global");

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "ask.md"), "utf8")).toBe("custom");
    expect(names).not.toContain("/ask");
    expect(names).toContain("/review");
  });
});

describe("installCodexPrompts", () => {
  it("copies the eight prompts to $CODEX_HOME/prompts", async () => {
    const names = await installCodexPrompts("global");

    expect(names).toEqual(COMMAND_NAMES.map((name) => `/prompts:${name}`));
    for (const name of COMMAND_NAMES) {
      const installed = readFileSync(join(tmp, ".codex", "prompts", `${name}.md`), "utf8");
      expect(installed).toBe(template("codex-prompts", name));
      expect(installed).toMatch(/^---\ndescription: .+\nargument-hint: .+\n---\n/);
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", async () => {
    delete process.env["CODEX_HOME"];

    await installCodexPrompts("global");

    expect(existsSync(join(tmp, ".codex", "prompts", "ask.md"))).toBe(true);
  });

  it("installs globally even for local scope, because prompts are user-level only", async () => {
    const project = join(tmp, "project");
    mkdirSync(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);

    await installCodexPrompts("local");

    expect(existsSync(join(tmp, ".codex", "prompts", "ask.md"))).toBe(true);
    expect(existsSync(join(project, ".codex"))).toBe(false);
  });
});
