/** The comment that opens the section `id`, for example `<!-- agentmate:start -->`. */
export const startMarker = (id: string): string => `<!-- ${id}:start -->`;
/** The comment that closes the section `id`. */
export const endMarker = (id: string): string => `<!-- ${id}:end -->`;

interface Span {
  /** Index of the first character of the start marker. */
  start: number;
  /** Index just past the end marker. */
  end: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where `marker` stands alone on its line (surrounding spaces and tabs allowed), as marker offsets. */
function markerLines(content: string, marker: string): number[] {
  const pattern = new RegExp(`^([ \\t]*)${escapeRegExp(marker)}[ \\t]*\\r?$`, "gm");
  return [...content.matchAll(pattern)].map((match) => match.index + (match[1]?.length ?? 0));
}

/** Where the section `id` sits in `content`; null when it has no markers. Throws on a broken pair. */
function locate(content: string, id: string): Span | null {
  const open = startMarker(id);
  const close = endMarker(id);
  const starts = markerLines(content, open);
  const ends = markerLines(content, close);
  if (starts.length === 0 && ends.length === 0) return null;
  const [start] = starts;
  const [end] = ends;
  if (start === undefined)
    throw new Error(`Found ${close} without ${open}. Fix or remove it by hand.`);
  if (end === undefined)
    throw new Error(`Found ${open} without ${close}. Fix or remove it by hand.`);
  if (end < start) throw new Error(`${close} comes before ${open}. Fix or remove them by hand.`);
  if (starts.length > 1)
    throw new Error(`Found ${open} more than once. Keep a single section by hand.`);
  if (ends.length > 1)
    throw new Error(`Found ${close} more than once. Keep a single section by hand.`);
  return { start, end: end + close.length };
}

/** `\r\n` when the file uses it, otherwise `\n`. */
const eolOf = (content: string): string => (content.includes("\r\n") ? "\r\n" : "\n");

/** Line endings as `\n`, for comparing text that may differ only in how its lines end. */
export const normalizeEol = (text: string): string => text.replace(/\r\n/g, "\n");

const render = (id: string, body: string, eol: string): string =>
  [startMarker(id), ...normalizeEol(body).replace(/\n+$/, "").split("\n"), endMarker(id)].join(eol);

/** The body between the markers of section `id` (lines joined with `\n`), or null when absent. */
export function readMarkedSection(content: string, id: string): string | null {
  const span = locate(content, id);
  if (!span) return null;
  return normalizeEol(
    content.slice(span.start + startMarker(id).length, span.end - endMarker(id).length),
  )
    .replace(/^[ \t]*\n/, "")
    .replace(/\n[ \t]*$/, "");
}

/**
 * Puts `body` between `<!-- id:start -->` and `<!-- id:end -->` (each alone on its line): replaces
 * the existing section in place, or appends one after a blank line. A file that uses CRLF gets a
 * CRLF block. Running it twice with the same body changes nothing. A marker without its partner
 * throws instead of guessing, so a file is never corrupted.
 */
export function upsertMarkedSection(content: string, id: string, body: string): string {
  const eol = eolOf(content);
  const block = render(id, body, eol);
  const span = locate(content, id);
  if (span) return content.slice(0, span.start) + block + content.slice(span.end);
  if (!content.trim()) return `${block}${eol}`;
  return `${content.replace(/\s+$/, "")}${eol}${eol}${block}${eol}`;
}
