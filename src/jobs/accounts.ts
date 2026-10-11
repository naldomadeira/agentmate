import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The account behind the default `CODEX_HOME` (`~/.codex`); `default` is accepted as an alias. */
export const DEFAULT_ACCOUNT = "principal";

const LIMITES_TIMEOUT_MS = 10_000;

/** Where the extra Codex accounts live, one full `CODEX_HOME` per directory. */
export function codexProfilesDir(): string {
  return process.env["AGENTMATE_CODEX_PROFILES"] || path.join(os.homedir(), ".codex-profiles");
}

/** A profile is a full CODEX_HOME: a directory holding the login or the config codex reads. */
const isProfile = (dir: string) =>
  fs.existsSync(path.join(dir, "auth.json")) || fs.existsSync(path.join(dir, "config.toml"));

const isDefault = (account: string | undefined) =>
  !account || account === DEFAULT_ACCOUNT || account === "default";

const isAccountName = (account: string) => /^[a-z0-9_-]+$/i.test(account);

/** The `CODEX_HOME` a job on `account` runs with; undefined keeps the inherited one. */
export function codexHomeFor(account: string | undefined): string | undefined {
  return isDefault(account) ? undefined : path.join(codexProfilesDir(), account!);
}

/** The `CODEX_HOME` the codex CLI reads for `account`, resolving the default one too. */
export function effectiveCodexHome(account: string | undefined): string {
  return codexHomeFor(account) ?? (process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex"));
}

/** `limites --json` names the account with the most headroom in `suggestion.name`. */
function suggestedAccount(): { account: string; note?: string } {
  const bin = process.env["AGENTMATE_LIMITES_BIN"] || "limites";
  try {
    const out = execFileSync(bin, ["--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LIMITES_TIMEOUT_MS,
    });
    const name = (JSON.parse(out) as { suggestion?: { name?: unknown } }).suggestion?.name;
    if (typeof name === "string" && name) return { account: name };
    return {
      account: DEFAULT_ACCOUNT,
      note: `${bin} --json gave no suggestion; used ${DEFAULT_ACCOUNT}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      account: DEFAULT_ACCOUNT,
      note: `${bin} --json failed (${reason}); used ${DEFAULT_ACCOUNT}`,
    };
  }
}

/**
 * Turns the requested account into the one the job stores: `auto` asks `limites`, the default
 * account becomes `principal`, and any other name must be a directory under `codexProfilesDir()`.
 */
export function resolveAccount(requested: string): { account: string; note?: string } {
  const { account, note } = requested === "auto" ? suggestedAccount() : { account: requested };
  if (isDefault(account)) return { account: DEFAULT_ACCOUNT, ...(note ? { note } : {}) };
  if (!isAccountName(account))
    throw new Error(`Invalid Codex account name: ${account}. Use a profile directory name.`);
  const home = codexHomeFor(account)!;
  if (!isProfile(home)) {
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(codexProfilesDir(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .filter((name) => isProfile(path.join(codexProfilesDir(), name)));
    } catch {
      // No profiles directory: only the default account exists.
    }
    throw new Error(
      `Codex account "${account}" is not a profile (no auth.json or config.toml in ${home}). Available: ${[DEFAULT_ACCOUNT, ...names].join(", ")}.`,
    );
  }
  return { account, ...(note ? { note } : {}) };
}

/** True when two stored accounts name the same `CODEX_HOME`. */
export const sameAccount = (a: string | undefined, b: string | undefined) =>
  codexHomeFor(a) === codexHomeFor(b);

/** Explicit Claude account directories, preserving their strings for the Keychain-derived identity. */
function claudeAccountMap(): Map<string, string> {
  const accounts = new Map<string, string>();
  for (const item of (process.env["AGENTMATE_CLAUDE_ACCOUNTS"] ?? "").split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    accounts.set(item.slice(0, separator).trim(), item.slice(separator + 1));
  }
  return accounts;
}

/** A Claude config directory contains either its top-level state or its settings. */
const isClaudeConfig = (dir: string) =>
  fs.existsSync(path.join(dir, ".claude.json")) || fs.existsSync(path.join(dir, "settings.json"));

function availableClaudeAccounts(): string[] {
  const mapped = [...claudeAccountMap().keys()].filter(isAccountName);
  let conventional: string[] = [];
  try {
    conventional = fs
      .readdirSync(os.homedir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".claude-"))
      .map((entry) => entry.name.slice(".claude-".length))
      .filter(
        (name) => isAccountName(name) && isClaudeConfig(path.join(os.homedir(), `.claude-${name}`)),
      );
  } catch {
    // A missing home directory means only explicitly mapped accounts may be available.
  }
  return [DEFAULT_ACCOUNT, ...new Set([...mapped, ...conventional])];
}

/** The exact `CLAUDE_CONFIG_DIR` for a named account; undefined is the main Claude account. */
export function claudeConfigDirFor(account: string | undefined): string | undefined {
  if (isDefault(account)) return undefined;
  return claudeAccountMap().get(account!) ?? path.join(os.homedir(), `.claude-${account}`);
}

/** Resolves a Claude account name and verifies that its isolated config directory is usable. */
export function resolveClaudeAccount(requested: string): { account: string } {
  if (requested === "auto")
    throw new Error(
      "auto applies only to codex accounts. Use principal or a named Claude account.",
    );
  if (isDefault(requested)) return { account: DEFAULT_ACCOUNT };
  if (!isAccountName(requested))
    throw new Error(`Invalid Claude account name: ${requested}. Use a config directory name.`);

  const mapped = claudeAccountMap().get(requested);
  if (mapped !== undefined && !path.isAbsolute(mapped))
    throw new Error(
      `Claude account "${requested}" in AGENTMATE_CLAUDE_ACCOUNTS must use an absolute directory: ${mapped}.`,
    );
  const dir = claudeConfigDirFor(requested)!;
  if (!isClaudeConfig(dir))
    throw new Error(
      `Claude account "${requested}" is not a config directory (no .claude.json or settings.json in ${dir}). Available: ${availableClaudeAccounts().join(", ")}.`,
    );
  return { account: requested };
}

/** True when two stored accounts resolve to the same Claude config directory. */
export const sameClaudeAccount = (a: string | undefined, b: string | undefined) => {
  // An omitted account inherits the server environment, so it cannot safely stand for `principal`.
  if (a === undefined || b === undefined) return a === b;
  return claudeConfigDirFor(a) === claudeConfigDirFor(b);
};
