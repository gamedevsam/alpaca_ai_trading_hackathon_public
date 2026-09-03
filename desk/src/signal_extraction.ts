// Signal extraction (H14) — the pure half: everything that turns one LLM reply into a falsifiable claim,
// with no I/O, no Nest and no broker, so it is all directly testable.
//
// The load-bearing piece is `recoverVerbatimQuote`. The plan's rule is absolute — *a signal whose quote is
// not a verbatim substring of the transcript is dropped* — because the quote is the only thing standing
// between "the creator said this" and "a language model said the creator said this". A naive
// `transcript.includes(quote)` would enforce that rule in name only: models silently re-case, re-punctuate
// and collapse whitespace, so a true quote fails and the honest signal is thrown away, which pushes the
// prompt toward accepting paraphrase. So the match runs on a normalized projection of BOTH strings and
// then returns the transcript's OWN span — the stored quote is the source's characters, never the model's
// rendering of them. A model that invents words still finds no match and is still dropped.

import type { VideoTranscript } from './transcript_source';

/** Directions a creator's call can take. Mirrors the `alpaca/signal` entity enum. */
export const SIGNAL_DIRECTIONS = ['bullish', 'bearish', 'neutral'] as const;
export type SignalDirection = (typeof SIGNAL_DIRECTIONS)[number];

/** One extracted call, after parsing and validation but before it is priced or persisted. */
export interface ExtractedSignal {
  ticker: string;
  direction: SignalDirection;
  thesis: string;
  horizonDays: number;
  confidence: number;
  /** The transcript's own characters, recovered by {@link recoverVerbatimQuote} — never the model's copy. */
  quote: string;
  /** Where the quote starts in the video, derived from the matched cue. Null when the source has no timings. */
  timestampSec: number | null;
}

/**
 * Why a candidate signal the model proposed did not survive validation. Reported, never swallowed — and
 * named at **field granularity**, because a coarse reason is only half a report. A live run over three
 * real videos returned seven candidates with perfectly good tickers and dropped every one as "malformed",
 * which said the videos yielded nothing without saying what was actually wrong with them.
 */
export type DroppedSignalReason =
  'missing_quote' | 'missing_direction' | 'bad_ticker' | 'quote_not_verbatim' | 'quote_too_short' | 'duplicate_ticker';

export interface DroppedSignal {
  reason: DroppedSignalReason;
  ticker: string | null;
  quote: string | null;
}

export interface ParsedSignals {
  signals: ExtractedSignal[];
  dropped: DroppedSignal[];
}

/** Below this many normalized characters a "quote" matches too much of any transcript to prove anything. */
export const MIN_QUOTE_CHARS = 24;
/** A quote long enough to be a whole segment of the video is a summary, not a citation. */
export const MAX_QUOTE_CHARS = 600;
/** Bounds on the horizon the model may claim, so an absent timeframe cannot become "resolve in 2 days". */
export const MIN_HORIZON_DAYS = 14;
export const MAX_HORIZON_DAYS = 730;
/** A neutral call resolves as a band around the reference price rather than a direction. */
export const NEUTRAL_BAND_PCT = 5;

/** Broad index/market ETFs — a call on one of these is market timing, not stock selection. */
const INDEX_TICKERS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VT', 'SPX', 'NDX', 'RUT']);

/**
 * A claim on the whole market is a *market_timing* claim; a claim on one company is *stock_selection*.
 * They are scored apart on the scorecard, so getting this wrong blends two different skills into one rate.
 */
export function claimTypeForTicker(ticker: string): 'market_timing' | 'stock_selection' {
  return INDEX_TICKERS.has(ticker) ? 'market_timing' : 'stock_selection';
}

/**
 * How firmly the call was stated, from the model's own confidence. Hedging is *how* a claim becomes
 * unfalsifiable, and it must be on record before the outcome tempts anyone to grade a mushy claim as firm.
 */
export function hedgeLevelForConfidence(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 0.7) return 'low';
  if (confidence >= 0.4) return 'medium';
  return 'high';
}

/**
 * The falsifiable condition, written so a resolver a year from now needs nothing but a price history.
 *
 * `referencePrice` is deliberately the price *when the claim was logged*, not when the video published —
 * the desk has a last trade, not a historical bar — so the sentence says which one it is. With no price at
 * all the condition anchors on the publish-day close instead, which is still falsifiable, just without a
 * number stated up front. Either way the claim never degrades into "the ticker does well".
 */
export function buildFalsifiableCondition(params: {
  ticker: string;
  direction: SignalDirection;
  referencePrice: number | null;
  referenceAsOf: string;
  resolveBy: string;
  publishedAt: string | null;
}): string {
  const { ticker, direction, referencePrice, resolveBy } = params;
  const by = isoDay(resolveBy);
  const anchorDay = isoDay(params.referenceAsOf);

  if (referencePrice === null) {
    const publishedDay = params.publishedAt ? isoDay(params.publishedAt) : anchorDay;
    if (direction === 'neutral') {
      return `${ticker} closes within ${NEUTRAL_BAND_PCT}% of its ${publishedDay} close on ${by}.`;
    }
    return `${ticker} closes ${direction === 'bullish' ? 'above' : 'below'} its ${publishedDay} close on ${by}.`;
  }

  const anchor = `$${money(referencePrice)} (its price when this call was logged, ${anchorDay})`;
  if (direction === 'neutral') {
    const low = money(referencePrice * (1 - NEUTRAL_BAND_PCT / 100));
    const high = money(referencePrice * (1 + NEUTRAL_BAND_PCT / 100));
    return `${ticker} closes between $${low} and $${high} on ${by} — within ${NEUTRAL_BAND_PCT}% of ${anchor}.`;
  }
  return `${ticker} closes ${direction === 'bullish' ? 'above' : 'below'} ${anchor} on ${by}.`;
}

/**
 * `publishedAt + horizonDays` — the creator's own horizon, dated from when he said it rather than from
 * when we happened to read it.
 *
 * **Never in the past.** Back-reading a channel means the publish-anchored date has often already elapsed,
 * and a claim that resolves before the price it is measured against was even taken cannot be graded at
 * all: the first live run produced two of them ("closes above [today's price] on [a date two months
 * ago]"). When that happens the horizon runs from now instead — the same length the creator implied,
 * measured from the first moment it could actually be checked.
 */
export function resolveByFor(publishedAt: string | null, horizonDays: number, now: Date): string {
  const span = horizonDays * 24 * 60 * 60 * 1000;
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  const from = Number.isNaN(published) ? now.getTime() : published;
  const anchored = from + span;
  return new Date(anchored > now.getTime() ? anchored : now.getTime() + span).toISOString();
}

/** The provenance link a reader clicks to hear the quote themselves. */
export function buildSourceRef(videoId: string, timestampSec: number | null): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return timestampSec && timestampSec > 0 ? `${base}&t=${Math.floor(timestampSec)}s` : base;
}

// ── Parsing + validation ────────────────────────────────────────────────────────────────────────────

/**
 * Parse the model's reply and keep only signals that survive every check. Everything rejected is returned
 * in `dropped` with its reason rather than silently vanishing — "this video had no calls" and "the model
 * made three up" must never look the same from the outside.
 *
 * Returns `null` (not an empty result) when the reply is not JSON at all: an unparseable provider reply is
 * a failure to report, whereas `{"signals": []}` is a real, honest answer.
 */
export function parseExtractedSignals(text: string, transcript: VideoTranscript): ParsedSignals | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: { signals?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { signals?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.signals)) return null;

  const index = buildQuoteIndex(transcript.text);
  const offsets = segmentStartOffsets(transcript);
  const signals: ExtractedSignal[] = [];
  const dropped: DroppedSignal[] = [];
  const seenTickers = new Set<string>();

  for (const raw of parsed.signals) {
    const candidate = raw as Record<string, unknown>;
    const ticker = normalizeTicker(candidate?.ticker);
    const quote = typeof candidate?.quote === 'string' ? candidate.quote : null;
    const direction = normalizeDirection(candidate?.direction);
    // The model reliably answers with `reason` where the prompt asked for `thesis` (observed on every
    // live reply), and both mean the same thing here. Accepting the alias recovers the model's real
    // one-line summary; without it the quote-fallback below would silently replace a good summary with
    // the sentence it was summarising.
    const thesis = firstString(candidate?.thesis, candidate?.reason, candidate?.rationale);

    // Checked one field at a time so the reported reason names what the model actually omitted. Only the
    // ticker, the direction and the quote are load-bearing — see `thesis` below for why it is not.
    if (!quote) {
      dropped.push({ reason: 'missing_quote', ticker, quote: null });
      continue;
    }
    if (!direction) {
      dropped.push({ reason: 'missing_direction', ticker, quote });
      continue;
    }
    if (!ticker) {
      dropped.push({ reason: 'bad_ticker', ticker: null, quote });
      continue;
    }
    if (normalizeForMatch(quote).length < MIN_QUOTE_CHARS) {
      dropped.push({ reason: 'quote_too_short', ticker, quote });
      continue;
    }
    const recovered = recoverVerbatimQuote(index, quote);
    if (!recovered) {
      dropped.push({ reason: 'quote_not_verbatim', ticker, quote });
      continue;
    }
    // One call per ticker per video: a creator repeating himself is one belief, and two ledger claims from
    // one belief would double-count him on his own scorecard.
    if (seenTickers.has(ticker)) {
      dropped.push({ reason: 'duplicate_ticker', ticker, quote });
      continue;
    }
    seenTickers.add(ticker);

    signals.push({
      ticker,
      direction,
      // A missing thesis does NOT lose the call. The model routinely returns a good ticker, direction and
      // quote and simply omits this field, and dropping those was throwing away entire videos' worth of
      // real signals (a live run over three videos yielded zero this way). The thesis is a convenience
      // summary of the quote, so when it is absent the creator's own words stand in — which is arguably
      // the better record anyway: a verbatim sentence rather than a model's paraphrase of one.
      thesis: (thesis || recovered.text).slice(0, 400),
      horizonDays: clampHorizon(candidate?.horizonDays),
      confidence: clampConfidence(candidate?.confidence),
      quote: recovered.text,
      timestampSec: timestampAt(offsets, recovered.start),
    });
  }

  return { signals, dropped };
}

/** `$aapl`, ` AAPL ` → `AAPL`; anything that is not a plausible US ticker → null. */
export function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().replace(/^\$/, '').toUpperCase();
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(ticker) ? ticker : null;
}

/** The first of several candidate keys that actually carries text. */
function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeDirection(value: unknown): SignalDirection | null {
  const direction = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SIGNAL_DIRECTIONS as readonly string[]).includes(direction) ? (direction as SignalDirection) : null;
}

/** An absent or absurd horizon becomes a bounded one rather than a claim that resolves tomorrow. */
function clampHorizon(value: unknown): number {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days)) return 90;
  return Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, days));
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0.5;
  return Math.min(1, Math.max(0, Math.round(confidence * 100) / 100));
}

// ── Verbatim recovery ───────────────────────────────────────────────────────────────────────────────

/** A transcript projected to a comparable form, with every projected character mapped back to its origin. */
export interface QuoteIndex {
  source: string;
  normalized: string;
  /** `originAt[i]` is the index in `source` of the character that produced `normalized[i]`. */
  originAt: number[];
}

/**
 * Project text down to the words alone: lower-cased, whitespace collapsed, and **punctuation dropped
 * entirely**.
 *
 * Punctuation is dropped rather than folded because most YouTube transcripts are machine captions with no
 * punctuation at all, while a language model asked for a quote writes it as a sentence — commas, a full
 * stop, an apostrophe the captioner never produced. Comparing those two strings byte for byte fails on
 * every true quote from a captioned video, which would silently turn the verbatim rule into a rule that
 * throws away honest signals and keeps none. Matching on the words is the guarantee that actually matters:
 * *these words, in this order, are in this transcript*. A model that invents a sentence still finds no
 * match, and what gets STORED is the transcript's own characters either way (see `recoverVerbatimQuote`) —
 * so this widens what matches without ever widening what is recorded as the creator's words.
 */
export function normalizeForMatch(text: string): string {
  return buildQuoteIndex(text).normalized;
}

export function buildQuoteIndex(source: string): QuoteIndex {
  const normalized: string[] = [];
  const originAt: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (/\s/.test(char)) {
      // A run of whitespace becomes at most one space, and never a leading one.
      pendingSpace = normalized.length > 0;
      continue;
    }
    const folded = foldChar(char);
    // Punctuation folds away to nothing; it must not become a space, or "don't" and "dont" would differ.
    if (!folded) continue;
    if (pendingSpace) {
      normalized.push(' ');
      originAt.push(i);
      pendingSpace = false;
    }
    normalized.push(folded);
    originAt.push(i);
  }

  return { source, normalized: normalized.join(''), originAt };
}

/** Letters, digits and the marks inside them (a decimal point, a percent) survive; the rest is noise. */
const KEPT_CHARACTER = /[\p{L}\p{N}]/u;

function foldChar(char: string): string {
  const lower = char.toLowerCase();
  return KEPT_CHARACTER.test(lower) ? lower : '';
}

/**
 * Find the model's quote in the transcript and return the transcript's own characters for it.
 * `null` when the words are not there — which is exactly when the signal must be dropped.
 */
export function recoverVerbatimQuote(
  index: QuoteIndex,
  quote: string,
): { text: string; start: number; end: number } | null {
  const needle = normalizeForMatch(quote).trim();
  if (needle.length < MIN_QUOTE_CHARS) return null;

  const at = index.normalized.indexOf(needle);
  if (at < 0) return null;

  const start = index.originAt[at];
  const end = index.originAt[at + needle.length - 1] + 1;
  const text = index.source.slice(start, end).trim();
  return text.length > MAX_QUOTE_CHARS ? null : { text, start, end };
}

// ── Cue timing ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Where each cue begins inside `transcript.text`. Mirrors how the transcript is assembled (trimmed cue
 * texts joined by a single space) — kept next to the consumer of that convention so a change to one is a
 * visibly local change to the other.
 */
export function segmentStartOffsets(transcript: VideoTranscript): Array<{ start: number; offsetSec: number }> {
  const offsets: Array<{ start: number; offsetSec: number }> = [];
  let cursor = 0;
  for (const segment of transcript.segments) {
    const text = segment.text.trim();
    offsets.push({ start: cursor, offsetSec: segment.offsetSec });
    cursor += text.length + 1;
  }
  return offsets;
}

/** The cue a character index falls in — the quote's timestamp, derived rather than asked of the model. */
export function timestampAt(offsets: Array<{ start: number; offsetSec: number }>, charIndex: number): number | null {
  let found: number | null = null;
  for (const offset of offsets) {
    if (offset.start > charIndex) break;
    found = offset.offsetSec;
  }
  return found;
}

function isoDay(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toISOString().slice(0, 10);
}

function money(value: number): string {
  return value.toFixed(2);
}
