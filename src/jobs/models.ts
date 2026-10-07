import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agyModelId } from "../agents/agy.js";
import { getAgent, resolveBinary } from "../agents/registry.js";
import { effectiveCodexHome } from "./accounts.js";
import { homeDir, type Effort, type Provider } from "./store.js";

export interface ModelInfo {
  id: string;
  label?: string;
  /** Efforts the model accepts; for agy each one is a suffix of a real id (`<id>-<effort>`). */
  efforts?: string[];
  defaultEffort?: string;
}

/** What one provider's CLI accepts; `available: false` means no list could be read, not "no models". */
export interface ModelCatalog {
  provider: Provider;
  available: boolean;
  /** Where the list came from and how old it is. */
  source: string;
  models: ModelInfo[];
  note?: string;
}

export interface ListModelsOptions {
  /** agy: ignore the disk cache and ask `agy models` again. */
  refresh?: boolean;
  /** codex: the CODEX_HOME whose catalog to read (an account's), default the inherited one. */
  codexHome?: string;
}

const AGY_TIMEOUT_MS = 15_000;
const AGY_CACHE_TTL_MS = 6 * 60 * 60_000;
const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;
const SUGGESTIONS = 3;

const minutesSince = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 60_000));
const unavailable = (provider: Provider, note: string): ModelCatalog => ({
  provider,
  available: false,
  source: "none",
  models: [],
  note,
});

interface CodexCacheModel {
  slug?: unknown;
  display_name?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: { effort?: unknown }[];
}

/** Codex keeps the catalog it fetched in `$CODEX_HOME/models_cache.json`; nothing is spawned. */
function codexCatalog(codexHome: string): ModelCatalog {
  const file = path.join(codexHome, "models_cache.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return unavailable("codex", `No catalog at ${file}; run codex once to fetch it.`);
  }
  try {
    const data = JSON.parse(raw) as { models?: CodexCacheModel[] };
    const models: ModelInfo[] = (data.models ?? [])
      .filter((m) => typeof m.slug === "string" && m.slug)
      .map((m) => {
        const efforts = (m.supported_reasoning_levels ?? [])
          .map((level) => level.effort)
          .filter((effort): effort is string => typeof effort === "string");
        return {
          id: m.slug as string,
          ...(typeof m.display_name === "string" ? { label: m.display_name } : {}),
          ...(efforts.length > 0 ? { efforts } : {}),
          ...(typeof m.default_reasoning_level === "string"
            ? { defaultEffort: m.default_reasoning_level }
            : {}),
        };
      });
    if (models.length === 0) return unavailable("codex", `${file} lists no models.`);
    return {
      provider: "codex",
      available: true,
      source: `${file} (${minutesSince(fs.statSync(file).mtimeMs)}m old)`,
      models,
    };
  } catch (error) {
    return unavailable("codex", `Could not read ${file}: ${(error as Error).message}`);
  }
}

/**
 * Parses `agy models`: `id<TAB>label` lines after a `Fetching…` banner. Ids that differ only by an
 * effort suffix are grouped under the base id, with the suffixes as its efforts.
 */
export function parseAgyModels(stdout: string): ModelInfo[] {
  const grouped = new Map<string, ModelInfo>();
  for (const line of stdout.split("\n")) {
    const [id, label] = line.split("\t").map((part) => part.trim());
    if (!id || label === undefined) continue;
    const suffix = AGY_EFFORT_SUFFIX.exec(id);
    const base = suffix ? id.slice(0, suffix.index) : id;
    const model = grouped.get(base) ?? { id: base };
    if (suffix) model.efforts = [...(model.efforts ?? []), suffix[1]!];
    else model.label = label;
    // A grouped id is labelled after its first variant, minus the effort in parentheses.
    model.label ??= label.replace(/\s*\((low|medium|high)\)\s*$/i, "");
    grouped.set(base, model);
  }
  return [...grouped.values()];
}

/** `agy models` asks the service, so its answer is kept on disk for six hours. */
function agyCatalog(refresh: boolean): ModelCatalog {
  const cacheFile = path.join(homeDir(), "cache", "models-agy.json");
  if (!refresh) {
    try {
      const { mtimeMs } = fs.statSync(cacheFile);
      if (Date.now() - mtimeMs < AGY_CACHE_TTL_MS) {
        const models = (JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { models: ModelInfo[] })
          .models;
        if (models.length > 0)
          return {
            provider: "agy",
            available: true,
            source: `agy models, cached ${minutesSince(mtimeMs)}m ago`,
            models,
          };
      }
    } catch {
      // No usable cache: ask agy below.
    }
  }
  let stdout: string;
  try {
    stdout = execFileSync(resolveBinary(getAgent("agy").binary(), process.cwd()), ["models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: AGY_TIMEOUT_MS,
    });
  } catch (error) {
    return unavailable("agy", `agy models failed: ${(error as Error).message.split("\n")[0]}`);
  }
  const models = parseAgyModels(stdout);
  if (models.length === 0) return unavailable("agy", "agy models printed no model ids.");
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile, JSON.stringify({ models }), { mode: 0o600 });
  } catch {
    // The cache only saves a spawn next time.
  }
  return { provider: "agy", available: true, source: "agy models", models };
}

/** The model ids `provider` accepts. Never throws: a list it cannot read is `available: false`. */
export function listModels(provider: Provider, options: ListModelsOptions = {}): ModelCatalog {
  switch (provider) {
    case "codex":
      return codexCatalog(options.codexHome ?? effectiveCodexHome(undefined));
    case "agy":
      return agyCatalog(options.refresh ?? false);
    case "claude":
      return unavailable(
        "claude",
        "Claude Code has no model list command; it accepts aliases (opus, sonnet, haiku) and full ids, so they are not checked.",
      );
    case "gemini":
      return unavailable("gemini", "Headless Gemini CLI has no model list command.");
    case "copilot":
      return unavailable(
        "copilot",
        "Copilot has no model list command, and the models it accepts depend on your Copilot plan and policies; `auto` (the default) always works. An unavailable model fails with Copilot's own message.",
      );
  }
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}

/** The `limit` ids closest to `target` by edit distance. */
export function closestModels(target: string, ids: string[], limit = SUGGESTIONS): string[] {
  return ids
    .map((id) => ({ id, distance: editDistance(target, id) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ id }) => id);
}

/**
 * Refuses a model id (and, where the catalog knows them, an effort) the provider does not list.
 * Skipped when the catalog cannot be read, and with `AGENTMATE_SKIP_MODEL_CHECK=1`.
 */
export function assertKnownModel(
  provider: Provider,
  model: string,
  effort: Effort | undefined,
  codexHome?: string,
): void {
  if (process.env["AGENTMATE_SKIP_MODEL_CHECK"] === "1") return;
  const catalog = listModels(provider, codexHome ? { codexHome } : {});
  if (!catalog.available) return;
  const unknown = (id: string, ids: string[]) =>
    new Error(
      `Unknown ${provider} model "${id}". Closest: ${closestModels(id, ids).join(", ")}. Run mate_models to see all, or set AGENTMATE_SKIP_MODEL_CHECK=1 to skip this check.`,
    );
  if (provider === "agy") {
    // agy runs the id with the effort folded in, so that full id is what must exist.
    // A grouped id exists only with one of its effort suffixes.
    const ids = catalog.models.flatMap((m) =>
      m.efforts ? m.efforts.map((e) => `${m.id}-${e}`) : [m.id],
    );
    const finalId = agyModelId(model, effort);
    if (!ids.includes(finalId)) throw unknown(finalId, ids);
    return;
  }
  const found = catalog.models.find((m) => m.id === model);
  if (!found)
    throw unknown(
      model,
      catalog.models.map((m) => m.id),
    );
  if (effort && found.efforts && !found.efforts.includes(effort))
    throw new Error(
      `${provider} model ${model} does not take effort ${effort}; it takes ${found.efforts.join(", ")}.`,
    );
}
