import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startJob } from "../src/jobs/api.js";
import { listModels } from "../src/jobs/models.js";

describe("models", () => {
  let home: string;
  const saved = { ...process.env };

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "amw-models-test-"));
    process.env["AGENTMATE_HOME"] = home;
    process.env["CODEX_HOME"] = home;
    delete process.env["AGENTMATE_DEPTH"];

    // Set up codex cache
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-4",
            display_name: "GPT 4",
            default_reasoning_level: "low",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          {
            slug: "gpt-4o",
            display_name: "GPT 4o",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "medium" }],
          },
        ],
      }),
      "utf8",
    );

    // Set up fake agy binary
    const agyBin = path.join(home, "fake-agy");
    const script = `#!/bin/sh
if [ "$1" = "models" ]; then
  echo "Fetching available models..."
  echo "gemini-3.1-pro-high\tGemini 3.1 Pro (High)"
  echo "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)"
  echo "gemini-3.8-flash-medium\tGemini 3.8 Flash"
  exit 0
fi
exit 0
`;
    fs.writeFileSync(agyBin, script, { mode: 0o755 });
    process.env["AGENTMATE_AGY_BIN"] = agyBin;

    // Set up fake codex binary so assertAgentAvailable doesn't throw
    const codexBin = path.join(home, "fake-codex");
    fs.writeFileSync(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env["AGENTMATE_CODEX_BIN"] = codexBin;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parses codex cache", () => {
    const catalog = listModels("codex", { refresh: true });
    expect(catalog.available).toBe(true);
    expect(catalog.models).toHaveLength(2);
    const gpt4 = catalog.models.find((m) => m.id === "gpt-4");
    expect(gpt4?.efforts).toEqual(["low", "high"]);
    expect(gpt4?.defaultEffort).toBe("low");
  });

  it("parses agy output, skipping Fetching line", () => {
    const catalog = listModels("agy", { refresh: true });
    expect(catalog.available).toBe(true);
    expect(catalog.models).toHaveLength(2); // grouped by base id
    const pro = catalog.models.find((m) => m.id === "gemini-3.1-pro");
    expect(pro?.efforts).toEqual(["high", "low"]);
  });

  it("startJob refusal with suggestions for agy", () => {
    expect(() =>
      startJob({
        provider: "agy",
        role: "custom",
        prompt: "q",
        model: "gemini-3.1-pro-max",
        cwd: home,
      }),
    ).toThrow(/Unknown agy model "gemini-3.1-pro-max". Closest:.*Run mate_models to see all./);
  });

  it("startJob refusal with suggestions for codex", () => {
    expect(() =>
      startJob({ provider: "codex", role: "custom", prompt: "q", model: "gpt-5", cwd: home }),
    ).toThrow(/Unknown codex model "gpt-5". Closest: gpt-4, gpt-4o/);
  });

  it("codex effort not supported refusal", () => {
    expect(() =>
      startJob({
        provider: "codex",
        role: "custom",
        prompt: "q",
        model: "gpt-4",
        effort: "medium",
        cwd: home,
      }),
    ).toThrow(/Model gpt-4 does not support effort "medium". Supported efforts: low, high./);
  });

  it("AGENTMATE_SKIP_MODEL_CHECK skips validation", () => {
    process.env["AGENTMATE_SKIP_MODEL_CHECK"] = "1";
    const job = startJob({
      provider: "codex",
      role: "custom",
      prompt: "q",
      model: "gpt-5",
      cwd: home,
    });
    expect(job.model).toBe("gpt-5");
    delete process.env["AGENTMATE_SKIP_MODEL_CHECK"];
  });

  it("skips on unavailable catalog", () => {
    fs.rmSync(path.join(home, "models_cache.json"));
    listModels("codex", { refresh: true }); // update memory cache
    const job = startJob({
      provider: "codex",
      role: "custom",
      prompt: "q",
      model: "gpt-5",
      cwd: home,
    });
    expect(job.model).toBe("gpt-5");
  });
});
