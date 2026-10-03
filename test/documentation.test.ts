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
});
