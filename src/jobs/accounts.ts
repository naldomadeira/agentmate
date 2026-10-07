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
  if (!/^[a-z0-9_-]+$/i.test(account))
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
