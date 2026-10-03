/**
 * Spots a provider that is out of usage (a plan limit, credits or a quota) rather than failing for
 * another reason, so the job ends `quota_exhausted` with a hand-off hint instead of a bare `error`.
 */

const MAX_LINE_CHARS = 200;
/** Only the end of stderr is scanned: that is where a CLI reports why it stopped, and earlier lines are tool noise. */
const STDERR_TAIL_LINES = 20;

/**
 * Phrases that mean the usage allowance is spent. Case-insensitive, matched per line.
 *
 * Deliberately narrow: bare `quota` and bare `limit reached` are gone because they matched
 * `Disk quota exceeded`, a path such as `src/jobs/quota.ts` or `connection limit reached`. A generic
 * `rate limit ... exceeded` is not here either: it is what transient 429s and third-party APIs (a
 * GitHub call made by the agent) say, so a rate limit counts only as a `usage` limit or when the
 * line also promises a reset (`reset`, `try again at`); lines naming GitHub or a disk are
 * excluded below (a line naming a disk is never an agent allowance).
 */
export const QUOTA_PATTERNS: readonly RegExp[] = [
  /\b(usage|weekly|monthly|daily|\d+-hour|session) limit\b.*\b(reached|exceeded|hit)\b/i,
  /\b(hit|reached|exceeded) your (\w+ )?limit\b/i,
  /\bquota\b.*\b(exceeded|exhausted|reached)\b/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /out of credits/i,
  /\brate limit\b.*(\breset|\btry again at\b)/i,
  // The Antigravity CLI (agy) reports an exhausted allowance as a gRPC status: `RESOURCE_EXHAUSTED (code
  // 429): Individual quota reached. Resets in 4h1m13s`. The upper-case status is specific to that
  // CLI; its `quota reached` wording is already covered above. A bare `code 429` is not added.
  /\bRESOURCE_EXHAUSTED\b/,
];

/** Lines that look like a quota but are not the agent's own allowance. */
const NOT_QUOTA = /\bdisk\b|\bgithub\b/i;

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
 * The first line of `errors` or of the last 20 lines of stderr that says the quota is spent
 * (trimmed, at most 200 characters), or null. The result text is not scanned: an agent that quotes
 * a log or a file would otherwise look out of quota. The third argument is ignored and kept so
 * callers need not change.
 */
export function detectQuotaExhaustion(
  stderr: string,
  errors: string[],
  _resultText?: string,
): string | null {
  const patterns = quotaPatterns();
  const stderrLines = stderr.split(/\r?\n/).filter((line) => line.trim());
  const lines = [
    ...errors.flatMap((text) => text.split(/\r?\n/)),
    ...stderrLines.slice(-STDERR_TAIL_LINES),
  ];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || NOT_QUOTA.test(line)) continue;
    if (patterns.some((pattern) => pattern.test(line))) return line.slice(0, MAX_LINE_CHARS);
  }
  return null;
}
