/**
 * Spots a provider that is out of usage (a plan limit, credits or a quota) rather than failing for
 * another reason, so the job ends `quota_exhausted` with a hand-off hint instead of a bare `error`.
 */

const MAX_LINE_CHARS = 200;

/** Phrases that mean the usage allowance is spent. Case-insensitive. */
const STRONG_PATTERNS = [
  "usage limit",
  "hit your limit",
  "quota",
  "insufficient_quota",
  "exceeded your current quota",
  "out of credits",
  "rate limit.*(reset|try again at)",
];
/** Weaker: also what some transient 429 messages say, so it never counts on a 429 line. */
const WEAK_PATTERNS = ["limit reached"];

/** `QUOTA_PATTERNS` default regex list, before `AGENTMATE_QUOTA_PATTERNS` extends it. */
export const QUOTA_PATTERNS: readonly RegExp[] = [...STRONG_PATTERNS, ...WEAK_PATTERNS].map(
  (source) => new RegExp(source, "i"),
);

/** A plain transient rate-limit line, which `exec-runner` already retried. */
const TRANSIENT_429 = /\b429\b|too many requests/i;

function extraPatterns(): RegExp[] {
  const patterns: RegExp[] = [];
  for (const source of (process.env["AGENTMATE_QUOTA_PATTERNS"] ?? "").split("|")) {
    if (!source.trim()) continue;
    try {
      patterns.push(new RegExp(source.trim(), "i"));
    } catch {
      // an invalid pattern is ignored on purpose
    }
  }
  return patterns;
}

/** The default patterns plus the ones from `AGENTMATE_QUOTA_PATTERNS` (alternatives separated by `|`). */
export function quotaPatterns(): RegExp[] {
  return [...QUOTA_PATTERNS, ...extraPatterns()];
}

/**
 * The first line of stderr, parsed errors or the result text that says the quota is spent (trimmed,
 * at most 200 characters), or null. A 429 alone is not exhaustion: such a line counts only when it
 * also carries a reset or limit phrase.
 */
export function detectQuotaExhaustion(
  stderr: string,
  errors: string[],
  resultText: string,
): string | null {
  const extra = extraPatterns();
  const all = [...QUOTA_PATTERNS, ...extra];
  const strong = [...STRONG_PATTERNS.map((source) => new RegExp(source, "i")), ...extra];
  const lines = [stderr, ...errors, resultText].flatMap((text) => text.split(/\r?\n/));
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const patterns = TRANSIENT_429.test(line) ? strong : all;
    if (patterns.some((pattern) => pattern.test(line))) return line.slice(0, MAX_LINE_CHARS);
  }
  return null;
}
