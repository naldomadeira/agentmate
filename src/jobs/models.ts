import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getAgent, resolveBinary } from "../agents/registry.js";
import { homeDir, type Provider } from "./store.js";

export interface ModelInfo {
  id: string;
  label?: string;
  efforts?: string[];
  defaultEffort?: string;
}

export interface ModelCatalog {
  provider: Provider;
  available: boolean;
  source: string;
  models: ModelInfo[];
  note?: string;
}

export interface ListModelsOptions {
  refresh?: boolean;
}

const memoryCache = new Map<Provider, ModelCatalog>();

function parseCodexCatalog(): ModelCatalog {
  const codexHome = process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
  const cacheFile = path.join(codexHome, "models_cache.json");
  if (!fs.existsSync(cacheFile)) {
    return {
      provider: "codex",
      available: false,
      source: "none",
      models: [],
      note: `No models cache found at ${cacheFile}`,
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!data.models || !Array.isArray(data.models)) {
      return {
        provider: "codex",
        available: false,
        source: "disk",
        models: [],
        note: "Invalid cache format",
      };
    }
    const stat = fs.statSync(cacheFile);
    const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60000);
    const models: ModelInfo[] = data.models.map((m: any) => ({
      id: m.slug,
      label: m.display_name,
      efforts: m.supported_reasoning_levels?.map((l: any) => l.effort),
      defaultEffort: m.default_reasoning_level,
    }));
    return {
      provider: "codex",
      available: true,
      source: `disk cache (${ageMins}m old)`,
      models,
    };
  } catch (error) {
    return {
      provider: "codex",
      available: false,
      source: "none",
      models: [],
      note: `Error parsing models cache: ${error}`,
    };
  }
}

function parseAgyCatalog(refresh: boolean): ModelCatalog {
  const cacheDir = path.join(homeDir(), "cache");
  const cacheFile = path.join(cacheDir, "models-agy.json");
  const TTL = 6 * 60 * 60 * 1000;

  if (!refresh && fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < TTL) {
        const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        return {
          provider: "agy",
          available: true,
          source: `disk cache (${Math.round((Date.now() - stat.mtimeMs) / 60000)}m old)`,
          models: data.models,
        };
      }
    } catch {}
  }

  try {
    const binary = getAgent("agy").binary();
    const resolved = resolveBinary(binary, process.cwd());
    const stdout = execFileSync(resolved, ["models"], {
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    const grouped = new Map<string, { label?: string; efforts: Set<string> }>();

    for (const line of stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const fullId = parts[0].trim();
        const label = parts[1].trim();

        const effortMatch = fullId.match(/-(low|medium|high|xhigh)$/);
        let base = fullId;
        let effort = "";
        if (effortMatch) {
          effort = effortMatch[1];
          base = fullId.slice(0, -effortMatch[0].length);
        }

        if (!grouped.has(base)) grouped.set(base, { label, efforts: new Set() });
        if (effort) grouped.get(base)!.efforts.add(effort);
        else grouped.get(base)!.label = label;
      }
    }

    if (grouped.size === 0) {
      return {
        provider: "agy",
        available: false,
        source: "none",
        models: [],
        note: "Empty list from agy models",
      };
    }

    const models: ModelInfo[] = [];
    for (const [base, info] of grouped.entries()) {
      models.push({
        id: base,
        label: info.label,
        efforts: info.efforts.size > 0 ? Array.from(info.efforts) : undefined,
      });
    }

    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile, JSON.stringify({ models }), "utf8");

    return {
      provider: "agy",
      available: true,
      source: "fresh",
      models,
    };
  } catch (error) {
    return {
      provider: "agy",
      available: false,
      source: "none",
      models: [],
      note: `Error fetching models: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function listModels(provider: Provider, opts?: ListModelsOptions): ModelCatalog {
  if (!opts?.refresh && memoryCache.has(provider)) {
    return memoryCache.get(provider)!;
  }

  let catalog: ModelCatalog;
  switch (provider) {
    case "codex":
      catalog = parseCodexCatalog();
      break;
    case "agy":
      catalog = parseAgyCatalog(opts?.refresh || false);
      break;
    case "claude":
      catalog = {
        provider: "claude",
        available: false,
        source: "none",
        models: [],
        note: "Claude adapter does not support a local models list command. Aliases like opus, sonnet, haiku and full ids are accepted.",
      };
      break;
    case "gemini":
      catalog = {
        provider: "gemini",
        available: false,
        source: "none",
        models: [],
        note: "Headless Gemini CLI does not support a list models command.",
      };
      break;
    default:
      catalog = { provider, available: false, source: "none", models: [] };
  }

  memoryCache.set(provider, catalog);
  return catalog;
}

export function getClosestModels(target: string, choices: string[], limit: number = 3): string[] {
  const distance = (a: string, b: string) => {
    const m = a.length,
      n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  };
  return choices
    .map((c) => ({ c, d: distance(target, c) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.c);
}
