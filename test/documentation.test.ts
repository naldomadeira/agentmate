import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

describe("project documentation", () => {
  it("keeps the README in English and links its Portuguese translation", () => {
    const readme = read("README.md");

    expect(readme).toContain("[Português (Brasil)](./docs/README.pt-BR.md)");
    expect(readme).not.toContain("Instalação por plugin");
    expect(readme).toContain("./assets/illustrations/cli-bridge.png");
    expect(readme).toContain("./assets/illustrations/background-jobs.png");
    expect(readme).toContain("## Usage examples");
    expect(readme).toContain("--mode write");
    expect(readme).toContain("--continue <job-id>");
    expect(readme).toContain("explicit deny of `Edit`");
    expect(readme).toContain("AGENTS_BRIDGE_CLAUDE_WRITE_TOOLS");
    expect(readme).toContain("waitSeconds: 45");

    const portugueseReadme = read("docs/README.pt-BR.md");
    expect(portugueseReadme).toContain("## Exemplos de uso");
    expect(portugueseReadme).toContain("--mode write");
    expect(portugueseReadme).toContain("--continue <job-id>");
    expect(portugueseReadme).toContain("## Requisitos");
    expect(portugueseReadme).toContain("## Configuração legada");
    expect(portugueseReadme).toContain("negação explícita de `Edit`");
    expect(portugueseReadme).toContain("AGENTS_BRIDGE_CLAUDE_WRITE_TOOLS");
    expect(portugueseReadme).toContain("waitSeconds: 45");
    expect(portugueseReadme).toContain("git clone");
  });

  it("documents the slash commands in both READMEs and both install guides", () => {
    const readme = read("README.md");
    expect(readme).toContain("## Slash commands");
    expect(readme).toContain("/agents-bridge:ask");
    expect(readme).toContain("/prompts:ask");
    expect(readme).toContain("install commands");
    expect(readme).toContain("deprecated");
    expect(readme.indexOf("## Slash commands")).toBeGreaterThan(
      readme.indexOf("## What you can do"),
    );
    expect(readme.indexOf("## Slash commands")).toBeLessThan(readme.indexOf("## Team lead mode"));

    const portuguese = read("docs/README.pt-BR.md");
    expect(portuguese).toContain("## Comandos de barra");
    expect(portuguese).toContain("/prompts:ask");
    expect(portuguese).toContain("install commands");

    for (const guide of ["docs/INSTALL_FOR_AGENTS.md", "docs/INSTALL_FOR_AGENTS.pt-BR.md"]) {
      expect(read(guide), guide).toContain("install commands");
    }
  });

  it("provides installation guides in English and Portuguese", () => {
    expect(read("docs/INSTALL_FOR_AGENTS.md")).toContain("# Install Agents Bridge as a plugin");
    expect(read("docs/INSTALL_FOR_AGENTS.pt-BR.md")).toContain(
      "# Instale o Agents Bridge como plugin",
    );
  });

  it("uses an explicit relative plugin path in the Codex marketplace", () => {
    const marketplace = JSON.parse(read(".agents/plugins/marketplace.json")) as {
      plugins: Array<{ source: { path: string } }>;
    };

    expect(marketplace.plugins[0]?.source.path).toBe("./");
  });

  it("documents the role tools, the team lead, the doctor command and every skill", () => {
    const readme = read("README.md");
    const skills = [
      "ask",
      "review",
      "research",
      "plan",
      "implement",
      "teamlead",
      "jobs",
      "delegate",
      "codex",
      "claude",
    ];

    for (const tool of [
      "bridge_ask",
      "bridge_review",
      "bridge_research",
      "bridge_plan",
      "bridge_implement",
      "bridge_teamlead",
    ]) {
      expect(readme).toContain(tool);
    }
    expect(readme).toContain("doctor");
    expect(readme).toContain("## Safety model");
    expect(readme).toContain("## Troubleshooting");
    for (const skill of skills) expect(readme).toContain(`\`${skill}\``);
  });

  it("documents the doctor command and the ask smoke test in both install guides", () => {
    for (const guide of ["docs/INSTALL_FOR_AGENTS.md", "docs/INSTALL_FOR_AGENTS.pt-BR.md"]) {
      const content = read(guide);
      expect(content, guide).toContain("agents-bridge-mcp doctor");
      expect(content, guide).toContain("jobs ask");
    }
    expect(read("docs/README.pt-BR.md")).toContain("bridge_teamlead");
  });

  it("keeps a changelog with the current release", () => {
    const changelog = read("CHANGELOG.md");

    expect(changelog).toContain("## [0.2.1]");
    expect(changelog).toContain("## [0.2.0]");
    expect(changelog).toContain("## [0.1.0]");
    expect(changelog).toContain("--allowedTools");
    expect(read("IMPLEMENTATION_PLAN.md")).toContain("v0.2 — Roles, commands and agents");
  });
});
