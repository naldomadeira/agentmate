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

/** Where the section `id` sits in `content`; null when it has no markers. Throws on a broken pair. */
function locate(content: string, id: string): Span | null {
  const open = startMarker(id);
  const close = endMarker(id);
  const start = content.indexOf(open);
  const end = content.indexOf(close);
  if (start === -1 && end === -1) return null;
  if (start === -1) throw new Error(`Found ${close} without ${open}. Fix or remove it by hand.`);
  if (end === -1) throw new Error(`Found ${open} without ${close}. Fix or remove it by hand.`);
  if (end < start) throw new Error(`${close} comes before ${open}. Fix or remove them by hand.`);
  if (content.indexOf(open, start + open.length) !== -1)
    throw new Error(`Found ${open} more than once. Keep a single section by hand.`);
  if (content.indexOf(close, end + close.length) !== -1)
    throw new Error(`Found ${close} more than once. Keep a single section by hand.`);
  return { start, end: end + close.length };
}

const render = (id: string, body: string): string =>
  `${startMarker(id)}\n${body.replace(/\n+$/, "")}\n${endMarker(id)}`;

/** The body between the markers of section `id`, or null when the section is absent. */
export function readMarkedSection(content: string, id: string): string | null {
  const span = locate(content, id);
  if (!span) return null;
  return content
    .slice(span.start + startMarker(id).length, span.end - endMarker(id).length)
    .replace(/^\n/, "")
    .replace(/\n$/, "");
}

/**
 * Puts `body` between `<!-- id:start -->` and `<!-- id:end -->`: replaces the existing section in
 * place, or appends one after a blank line. Running it twice with the same body changes nothing.
 * A marker without its partner throws instead of guessing, so a file is never corrupted.
 */
export function upsertMarkedSection(content: string, id: string, body: string): string {
  const block = render(id, body);
  const span = locate(content, id);
  if (span) return content.slice(0, span.start) + block + content.slice(span.end);
  if (!content.trim()) return `${block}\n`;
  return `${content.replace(/\s+$/, "")}\n\n${block}\n`;
}
