import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as T;
}

type McpServer = { command: string; args: string[] };
type PluginManifest = {
  name: string;
  version: string;
  skills?: string;
  mcpServers?: string | Record<string, McpServer>;
};

describe("plugin package", () => {
  it("declares the jobs server for Codex through the compatibility manifest", () => {
    const manifest = json<PluginManifest>(".codex-plugin/plugin.json");
    const mcp = json<{ mcpServers: Record<string, McpServer> }>(".mcp.json");

    expect(manifest).toMatchObject({
      name: "agents-bridge",
      version: "0.1.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
    expect(mcp.mcpServers["agents-bridge"]).toEqual({
      command: "npx",
      args: ["-y", "agents-bridge-mcp", "serve", "jobs"],
    });
  });

  it("publishes the plugin through a Codex marketplace", () => {
    const marketplace = json<{
      name: string;
      plugins: Array<{ name: string; source: { source: string; path: string } }>;
    }>(".agents/plugins/marketplace.json");

    expect(marketplace.name).toBe("agents-bridge");
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "agents-bridge",
        source: { source: "local", path: "." },
      }),
    );
  });

  it("registers only the jobs server in the Claude plugin", () => {
    const manifest = json<PluginManifest>(".claude-plugin/plugin.json");

    expect(manifest.mcpServers).toEqual({
      "agents-bridge": {
        command: "npx",
        args: ["-y", "agents-bridge-mcp", "serve", "jobs"],
      },
    });
  });

  it("ships the CLI runtime and delegation skill in the npm package", () => {
    const pkg = json<{ files: string[] }>("package.json");

    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "skills", "agents"]));
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
});
