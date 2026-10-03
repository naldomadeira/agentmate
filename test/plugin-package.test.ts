import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_NAMES } from "../src/lib/installer.js";

const root = resolve(import.meta.dirname, "..");

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as T;
}

type McpServer = { command: string; args: string[] };
type PluginManifest = {
  name: string;
  version: string;
  skills?: string;
  agents?: string[];
  hooks?: string;
  mcpServers?: string | Record<string, McpServer>;
};

describe("plugin package", () => {
  it("declares the jobs server for Codex through the compatibility manifest", () => {
    const manifest = json<PluginManifest>(".codex-plugin/plugin.json");
    const mcp = json<{ mcpServers: Record<string, McpServer> }>(".mcp.json");

    expect(manifest).toMatchObject({
      name: "mate",
      version: "0.6.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
    expect(mcp.mcpServers["agentmate"]).toEqual({
      command: "npx",
      args: ["-y", "agentmate", "serve", "jobs"],
    });
  });

  it("publishes the plugin through a Codex marketplace", () => {
    const marketplace = json<{
      name: string;
      plugins: Array<{ name: string; source: { source: string; path: string } }>;
    }>(".agents/plugins/marketplace.json");

    expect(marketplace.name).toBe("agentmate");
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "mate",
        source: { source: "local", path: "./" },
      }),
    );
  });

  it("names the plugin mate in the Claude manifest and marketplace, keeping the marketplace name", () => {
    const manifest = json<PluginManifest>(".claude-plugin/plugin.json");
    const marketplace = json<{ name: string; plugins: Array<{ name: string }> }>(
      ".claude-plugin/marketplace.json",
    );

    expect(manifest.name).toBe("mate");
    expect(marketplace.name).toBe("agentmate");
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(["mate"]);
  });

  it("registers only the jobs server in the Claude plugin", () => {
    const manifest = json<PluginManifest>(".claude-plugin/plugin.json");

    expect(manifest.mcpServers).toEqual({
      agentmate: {
        command: "npx",
        args: ["-y", "agentmate", "serve", "jobs"],
      },
    });
  });

  it("exposes only the agentmate binary", () => {
    const pkg = json<{ bin: Record<string, string> }>("package.json");

    expect(pkg.bin).toEqual({ agentmate: "./dist/cli.mjs" });
  });

  it("ships the CLI runtime and delegation skill in the npm package", () => {
    const pkg = json<{ files: string[] }>("package.json");

    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "skills", "agents", "assets", "templates", "hooks"]),
    );
  });

  it("declares the SessionStart hook in the Claude plugin manifest", () => {
    const manifest = json<PluginManifest>(".claude-plugin/plugin.json");
    const hooks = json<{
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
      >;
    }>("hooks/hooks.json");

    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(existsSync(resolve(root, "hooks/session-start.mjs"))).toBe(true);
    expect(hooks.hooks["SessionStart"]).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"',
          },
        ],
      },
    ]);
  });

  it("keeps plugin and marketplace versions aligned with the npm package", () => {
    const pkg = json<{ version: string }>("package.json");
    const codex = json<{ version: string }>(".codex-plugin/plugin.json");
    const claude = json<{ version: string }>(".claude-plugin/plugin.json");
    const codexMarketplace = json<{ version: string }>(".agents/plugins/marketplace.json");

    expect(codex.version).toBe(pkg.version);
    expect(claude.version).toBe(pkg.version);
    expect(codexMarketplace.version).toBe(pkg.version);
  });

  it("keeps the shared runtime version aligned with the npm package", () => {
    const pkg = json<{ version: string }>("package.json");
    const source = readFileSync(resolve(root, "src/lib/version.ts"), "utf8");

    expect(pkg.version).toBe("0.6.0");
    expect(source).toMatch(/VERSION\s*=\s*"0\.6\.0"/);
  });

  it("points package metadata at the public repository", () => {
    const pkg = json<{ repository: { url: string }; keywords: string[]; description: string }>(
      "package.json",
    );

    expect(pkg.repository.url).toBe("git+https://github.com/naldomadeira/agentmate.git");
    expect(pkg.keywords).toEqual(
      expect.arrayContaining(["claude-code", "codex-cli", "multi-agent", "delegation", "plugin"]),
    );
    expect(pkg.description).toContain("AI agents work better together");
  });

  it("declares the skills directory and every agent file in the Claude plugin manifest", () => {
    const manifest = json<PluginManifest>(".claude-plugin/plugin.json");

    expect(manifest.skills).toBe("./skills/");
    // Claude Code requires explicit agent files (a directory path fails validation).
    expect(manifest.agents).toEqual(AGENTS.map((name) => `./agents/${name}.md`));
  });
});

/** Reads the `key: value` pairs of a Markdown file's YAML frontmatter. */
function frontmatter(path: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error(`${path} has no YAML frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

function filesUnder(relativeDir: string): string[] {
  const dir = resolve(root, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => statSync(path).isFile());
}

const SKILLS = [
  "ask",
  "review",
  "research",
  "plan",
  "implement",
  "teamlead",
  "crossreview",
  "jobs",
  "delegate",
  "codex",
  "claude",
];
const AGENTS = ["codex-teammate", "codex-reviewer", "codex-researcher", "codex-teamlead"];

describe("skills", () => {
  it("ships the eleven skills", () => {
    const names = readdirSync(resolve(root, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(names.sort()).toEqual([...SKILLS].sort());
  });

  it.each(SKILLS)("%s has complete frontmatter and a compact body", (name) => {
    const path = resolve(root, "skills", name, "SKILL.md");
    const fields = frontmatter(path);

    expect(fields.name).toBe(name);
    expect(fields.description?.length ?? 0).toBeGreaterThan(20);
    expect(fields.description).toContain("/mate:");
    expect(fields["argument-hint"]).toBeTruthy();
    expect(fields["allowed-tools"]).toBeUndefined();
    expect(readFileSync(path, "utf8").split("\n").length).toBeLessThanOrEqual(80);
  });

  it("keeps the project-local codex skill identical to the shared one", () => {
    expect(readFileSync(resolve(root, ".claude/skills/codex/SKILL.md"), "utf8")).toBe(
      readFileSync(resolve(root, "skills/codex/SKILL.md"), "utf8"),
    );
  });

  it("documents the Codex MCP timeout workaround and the depth numbering in the skills", () => {
    const read = (name: string) => readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");

    expect(read("ask")).toContain("waitSeconds: 45");
    expect(read("claude")).toContain("waitSeconds: 45");
    expect(read("teamlead")).toContain("teamlead job (depth 0, started by you)");
    expect(read("teamlead")).toContain("child jobs (depth 1, cannot start jobs)");
    expect(read("implement")).toContain("always runs in write mode");
    expect(read("crossreview")).toContain("write mode");
    expect(read("crossreview")).toContain("mate_crossreview");
  });
});

describe("agents", () => {
  it("ships the four agents", () => {
    const names = readdirSync(resolve(root, "agents"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md"));

    expect(names.sort()).toEqual([...AGENTS].sort());
  });

  it.each(AGENTS)("%s has frontmatter that mentions Codex and omits tools", (name) => {
    const fields = frontmatter(resolve(root, "agents", `${name}.md`));

    expect(fields.name).toBe(name);
    expect(fields.description).toContain("Codex");
    expect(fields.tools).toBeUndefined();
  });
});

describe("legacy tool references", () => {
  it("does not reference the legacy synchronous MCP servers", () => {
    const files = ["skills", "agents", ".claude/skills"].flatMap(filesUnder);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, file).not.toContain("mcp__codex__");
      expect(content, file).not.toContain("mcp__claude__");
    }
  });
});

const COMMANDS: Record<string, string> = {
  ask: "mate_ask",
  review: "mate_review",
  research: "mate_research",
  plan: "mate_plan",
  implement: "mate_implement",
  teamlead: "mate_teamlead",
  crossreview: "mate_crossreview",
  jobs: "mate_list",
};
const TEMPLATE_DIRS = ["templates/claude-commands", "templates/codex-prompts"];

describe("command templates", () => {
  it.each(TEMPLATE_DIRS)("%s ships exactly the eight command files", (dir) => {
    const names = readdirSync(resolve(root, dir))
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md"));

    expect(names.sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it("registers every template as an installable command", () => {
    expect(COMMAND_NAMES).toHaveLength(8);
    expect([...COMMAND_NAMES].sort()).toEqual(Object.keys(COMMANDS).sort());
    expect(COMMAND_NAMES).toContain("crossreview");
  });

  it("keeps templates out of the directories the hosts scan", () => {
    expect(existsSync(resolve(root, "commands"))).toBe(false);
    expect(existsSync(resolve(root, "prompts"))).toBe(false);
  });

  describe.each(TEMPLATE_DIRS)("%s", (dir) => {
    it.each(Object.entries(COMMANDS))("%s has frontmatter and mentions %s", (name, tool) => {
      const path = resolve(root, dir, `${name}.md`);
      const fields = frontmatter(path);
      const content = readFileSync(path, "utf8");

      expect(fields.description?.length ?? 0).toBeGreaterThan(20);
      expect(fields["argument-hint"]).toBeTruthy();
      expect(content).toContain(tool);
      expect(content.split("\n").length).toBeLessThanOrEqual(25 + 5);
    });
  });

  it("uses positional $1 for Claude Code and only $ARGUMENTS for Codex", () => {
    for (const name of Object.keys(COMMANDS)) {
      const claude = readFileSync(resolve(root, TEMPLATE_DIRS[0]!, `${name}.md`), "utf8");
      const codex = readFileSync(resolve(root, TEMPLATE_DIRS[1]!, `${name}.md`), "utf8");

      expect(claude, name).toContain("$ARGUMENTS");
      expect(claude, name).toContain("$1");
      expect(claude, name).toContain(`/mate:${name}`);
      expect(codex, name).toContain("$ARGUMENTS");
      expect(codex, name).not.toMatch(/\$1\b/);
      expect(codex, name).toContain(`$mate:${name}`);
    }
  });
});
