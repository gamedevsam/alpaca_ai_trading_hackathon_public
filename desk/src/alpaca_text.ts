// Shortening the free text the desk shows a reader.
//
// The persona's `rationale` and its decline reasons are stored capped, and they are the fields a reader
// judges the desk's reasoning by. A hard slice at the cap ends mid-word, which reads as a rendering bug
// rather than as "there was more" — so text is cut on a word boundary and marked with an ellipsis.

/** Cut to `max` characters (ellipsis included) on a word boundary. Text already within `max` is returned as-is. */
export function truncateOnWordBoundary(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  // The ellipsis costs one character, so the text budget is `max - 1`.
  const head = trimmed.slice(0, max - 1);
  // The first character the budget excluded. If it is whitespace the head already ends on a whole word,
  // so keeping it costs nothing; otherwise the head ends mid-word and falls back to the last space.
  const brokeOnBoundary = /\s/.test(trimmed.charAt(max - 1));
  const lastSpace = head.lastIndexOf(' ');
  // A single token longer than the whole budget has no space to break on and is cut where it is —
  // better a cut word than an empty field.
  const body = brokeOnBoundary || lastSpace <= 0 ? head : head.slice(0, lastSpace);
  return `${body.replace(/[\s,;:.!?\-–—]+$/, '')}…`;
}

/**
 * Tidy text that a WRITER already cut at `cap`, for display. Reaching the cap exactly is the signature of
 * a truncation, so the dangling partial word is dropped and an ellipsis added; anything shorter is
 * untouched. This repairs records written before the writer cut cleanly, without rewriting stored data —
 * the characters are gone either way, and only the ragged edge is ours to fix.
 */
export function tidyTruncatedText(value: string, cap: number): string {
  if (value.length < cap) {
    return value;
  }
  // Sitting exactly on the cap, the tail is a fragment of whatever came next. Budget one character below
  // it so the cut is forced — passing `cap` itself would find the text already within budget and no-op.
  return truncateOnWordBoundary(value, cap - 1);
}
