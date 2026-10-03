import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

/** Lists files under a repository directory, relative to the repository root. */
function filesUnder(relativeDir: string): string[] {
  return readdirSync(resolve(root, relativeDir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

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
    expect(readme).toContain("AGENTMATE_CLAUDE_WRITE_TOOLS");
    expect(readme).toContain("waitSeconds: 45");
    expect(readme).toContain("docs/ARCHITECTURE.md");
    expect(readme).toContain("mate_events");
    expect(readme).toContain("quota_exhausted");
    expect(readme).toContain("AGENTMATE_QUOTA_PATTERNS");
    expect(readme).toContain("AGENTMATE_HOOK_QUIET");
    expect(readme).toContain("Cutting a release");
    expect(readme).toContain("clean working tree");
    expect(readme).not.toContain("## Legacy setup");
    expect(readme).toContain("Removed in 0.6.0");

    const portugueseReadme = read("docs/README.pt-BR.md");
    expect(portugueseReadme).toContain("## Exemplos de uso");
    expect(portugueseReadme).toContain("--mode write");
    expect(portugueseReadme).toContain("--continue <job-id>");
    expect(portugueseReadme).toContain("## Requisitos");
    expect(portugueseReadme).not.toContain("## Configuração legada");
    expect(portugueseReadme).toContain("## Removido na 0.6.0");
    expect(portugueseReadme).toContain("negação explícita de `Edit`");
    expect(portugueseReadme).toContain("AGENTMATE_CLAUDE_WRITE_TOOLS");
    expect(portugueseReadme).toContain("waitSeconds: 45");
    expect(portugueseReadme).toContain("git clone");
    expect(portugueseReadme).toContain("ARCHITECTURE.md");
    expect(portugueseReadme).toContain("mate_events");
    expect(portugueseReadme).toContain("quota_exhausted");
    expect(portugueseReadme).toContain("AGENTMATE_QUOTA_PATTERNS");
    expect(portugueseReadme).toContain("AGENTMATE_HOOK_QUIET");
    expect(portugueseReadme).toContain("Publicar uma versão");
    expect(portugueseReadme).toContain("árvore de trabalho limpa");
  });

  it("documents the slash commands in both READMEs and both install guides", () => {
    const readme = read("README.md");
    expect(readme).toContain("## Slash commands");
    expect(readme).toContain("/mate:ask");
    expect(readme).toContain("$mate:ask");
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

  it("documents the mate command namespace, agent snippet, upgrade and use cases", () => {
    const readme = read("README.md");
    expect(readme).toContain("mate@agentmate");
    expect(readme).toContain("## Use cases");
    expect(readme).toContain("For agents");
    expect(readme).toMatch(/^#{2,3} Upgrade$/m);
    expect(readme).toContain(
      "https://raw.githubusercontent.com/naldomadeira/agentmate/main/docs/INSTALL_FOR_AGENTS.md",
    );
    expect(read("docs/README.pt-BR.md")).toContain("## Casos de uso");
    expect(read("docs/README.pt-BR.md")).toContain("mate@agentmate");
    for (const guide of ["docs/INSTALL_FOR_AGENTS.md", "docs/INSTALL_FOR_AGENTS.pt-BR.md"]) {
      expect(read(guide), guide).toContain("mate@agentmate");
      expect(read(guide), guide).toContain("bridge@agents-bridge");
    }
  });

  it("uses only the mate namespace for plugin commands", () => {
    const files = [
      "README.md",
      "docs/README.pt-BR.md",
      "docs/INSTALL_FOR_AGENTS.md",
      "docs/INSTALL_FOR_AGENTS.pt-BR.md",
      ...["skills", "agents", "templates", ".claude/skills"].flatMap(filesUnder),
    ];

    for (const file of files) {
      const content = read(file);
      expect(content, file).not.toContain("/agentmate:");
      expect(content, file).not.toMatch(
        /\$(ask|review|research|plan|implement|teamlead|jobs|delegate)\b/,
      );
    }
  });

  it("provides installation guides in English and Portuguese", () => {
    expect(read("docs/INSTALL_FOR_AGENTS.md")).toContain("# Install AgentMate as a plugin");
    expect(read("docs/INSTALL_FOR_AGENTS.pt-BR.md")).toContain("# Instale o AgentMate como plugin");
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
      "crossreview",
      "split",
      "jobs",
      "delegate",
      "codex",
      "claude",
    ];

    for (const tool of [
      "mate_ask",
      "mate_review",
      "mate_research",
      "mate_plan",
      "mate_implement",
      "mate_teamlead",
      "mate_crossreview",
      "mate_split",
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
      expect(content, guide).toContain("agentmate doctor");
      expect(content, guide).toContain("jobs ask");
    }
    expect(read("docs/README.pt-BR.md")).toContain("mate_teamlead");
  });

  it("documents cross-review in both READMEs and the architecture notes", () => {
    const readme = read("README.md");
    expect(readme).toContain("mate_crossreview");
    expect(readme).toContain("## Cross-review");
    expect(readme).toContain("--role crossreview");
    expect(readme).toContain("Verdict: approve");
    expect(readme.indexOf("## Cross-review")).toBeGreaterThan(readme.indexOf("## Team lead mode"));
    expect(readme.indexOf("## Cross-review")).toBeLessThan(readme.indexOf("## How it works"));

    const portuguese = read("docs/README.pt-BR.md");
    expect(portuguese).toContain("mate_crossreview");
    expect(portuguese).toContain("## Revisão cruzada");
    expect(portuguese).toContain("Verdict: approve");

    expect(read("docs/ARCHITECTURE.md")).toContain("Cross-review shipped in phase 1");
  });

  it("documents task splitting and sessions in both READMEs and the architecture notes", () => {
    const readme = read("README.md");
    expect(readme).toContain("mate_split");
    expect(readme).toContain("## Task splitting");
    expect(readme).toContain("--role split");
    expect(readme).toContain("agentmate/<split-id>/<part-id>");
    expect(readme).toContain("conflicts between parts are not resolved automatically");
    for (const tool of [
      "mate_session_start",
      "mate_session_show",
      "mate_session_notes",
      "mate_session_list",
    ])
      expect(readme).toContain(tool);
    expect(readme.indexOf("## Task splitting")).toBeGreaterThan(readme.indexOf("## Cross-review"));
    expect(readme.indexOf("## Task splitting")).toBeLessThan(readme.indexOf("## How it works"));

    const portuguese = read("docs/README.pt-BR.md");
    expect(portuguese).toContain("mate_split");
    expect(portuguese).toContain("## Divisão de tarefas");
    expect(portuguese).toContain("mate_session_start");
    expect(portuguese).toContain("### Sessões");

    const architecture = read("docs/ARCHITECTURE.md");
    expect(architecture).toContain("Sessions (shipped in phase 2)");
    expect(architecture).toContain("## Split (workflow job)");
  });

  it("announces the removal of the legacy servers and setup in 0.6.0", () => {
    for (const file of [
      "README.md",
      "docs/README.pt-BR.md",
      "docs/INSTALL_FOR_AGENTS.md",
      "docs/INSTALL_FOR_AGENTS.pt-BR.md",
    ]) {
      const content = read(file);
      expect(content, file).toContain("0.6.0");
      expect(content, file).toMatch(/deprecated|obsolet|descontinu/i);
    }
  });

  it("keeps a changelog with the current release", () => {
    const changelog = read("CHANGELOG.md");

    expect(changelog).toContain("## [0.6.0]");
    expect(changelog).toContain("### Removed");
    expect(changelog).toContain("## [0.5.0]");
    expect(changelog).toContain("## [0.4.0]");
    expect(changelog).toContain("crossreview");
    expect(changelog).toContain("split");
    expect(changelog).toContain("SessionStart");
    expect(changelog).toContain("mate_session_start");
    expect(changelog).toContain("### Deprecated");
    expect(changelog).toContain("0.6.0");
    expect(changelog).toContain("mate@agentmate");
    expect(changelog).toContain("## [0.2.0]");
    expect(changelog).toContain("## [0.1.0]");
    expect(changelog).toContain("--allowedTools");
    expect(read("IMPLEMENTATION_PLAN.md")).toContain("v0.2 — Roles, commands and agents");
  });
});
