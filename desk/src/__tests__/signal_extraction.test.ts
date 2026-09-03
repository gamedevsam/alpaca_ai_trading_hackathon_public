import { LocalTranscriptSource } from '../transcript_source';
import { dirname, join } from 'node:path';
import {
  buildFalsifiableCondition,
  buildQuoteIndex,
  buildSourceRef,
  claimTypeForTicker,
  hedgeLevelForConfidence,
  MIN_QUOTE_CHARS,
  normalizeTicker,
  parseExtractedSignals,
  recoverVerbatimQuote,
  resolveByFor,
  segmentStartOffsets,
  timestampAt,
} from '../signal_extraction';
import type { VideoTranscript } from '../transcript_source';

const CARLSON_CORPUS = join(dirname(__dirname), '../../../../shared/data/joseph_carlson');

function transcriptOf(segments: Array<[string, number]>): VideoTranscript {
  const kept = segments.map(([text, offsetSec]) => ({ text, offsetSec }));
  return { videoId: 'vid_1', lang: 'en', text: kept.map((s) => s.text).join(' '), segments: kept };
}

function reply(signals: unknown[]): string {
  return JSON.stringify({ signals });
}

describe('signal_extraction — verbatim recovery', () => {
  const transcript = transcriptOf([
    ["I think Apple's services margin is the story nobody is pricing", 0],
    ['so I am buying AAPL here and holding it into next year', 12],
    ['Anyway, that is enough about that.', 30],
  ]);

  it('recovers the transcript’s own characters when the model re-cased and re-spaced the quote', () => {
    const index = buildQuoteIndex(transcript.text);
    const recovered = recoverVerbatimQuote(index, '  so I AM   buying aapl here and holding it into next year ');
    expect(recovered?.text).toBe('so I am buying AAPL here and holding it into next year');
  });

  it('matches on the words, so a model that punctuates a machine caption still lands', () => {
    // What a YouTube auto-caption actually looks like: no punctuation, no capitals.
    const captions = transcriptOf([['so im buying more nvidia here because the data center demand is real', 0]]);
    const index = buildQuoteIndex(captions.text);
    const recovered = recoverVerbatimQuote(
      index,
      "So I'm buying more Nvidia here, because the data center demand is real.",
    );
    // The stored text is the SOURCE's characters — the caption, not the model's tidied sentence.
    expect(recovered?.text).toBe('so im buying more nvidia here because the data center demand is real');
  });

  it('still stores the transcriber’s own typography when the model straightens it', () => {
    const curly = transcriptOf([['the market’s reaction was — frankly — overdone this quarter', 0]]);
    const index = buildQuoteIndex(curly.text);
    const recovered = recoverVerbatimQuote(index, "the market's reaction was - frankly - overdone this quarter");
    expect(recovered?.text).toBe('the market’s reaction was — frankly — overdone this quarter');
  });

  it('a different WORD is still a different quote, however it is punctuated', () => {
    const captions = transcriptOf([['so im buying more nvidia here because the data center demand is real', 0]]);
    const index = buildQuoteIndex(captions.text);
    expect(
      recoverVerbatimQuote(index, 'so I am buying more Nvidia here because the data center demand is real'),
    ).toBeNull();
  });

  it('refuses a quote whose words are not in the transcript', () => {
    const index = buildQuoteIndex(transcript.text);
    expect(recoverVerbatimQuote(index, 'I am buying NVDA here and holding it into next year')).toBeNull();
  });

  it('refuses a quote too short to prove anything', () => {
    const index = buildQuoteIndex(transcript.text);
    expect('is enough about'.length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(recoverVerbatimQuote(index, 'is enough about')).toBeNull();
  });

  it('derives the timestamp from the cue the quote starts in, never from the model', () => {
    const offsets = segmentStartOffsets(transcript);
    const index = buildQuoteIndex(transcript.text);
    const recovered = recoverVerbatimQuote(index, 'so I am buying AAPL here and holding it into next year');
    expect(timestampAt(offsets, recovered!.start)).toBe(12);
  });
});

describe('signal_extraction — parsing the model reply', () => {
  const transcript = transcriptOf([
    ['I am buying AAPL here because services revenue keeps compounding', 5],
    ['and I would not touch TSLA at this multiple for the next year', 40],
  ]);

  it('keeps well-formed calls and normalizes their fields', () => {
    const parsed = parseExtractedSignals(
      reply([
        {
          ticker: '$aapl',
          direction: 'Bullish',
          thesis: 'Services revenue compounding',
          horizonDays: '180',
          confidence: 0.834,
          quote: 'I am buying AAPL here because services revenue keeps compounding',
        },
      ]),
      transcript,
    );
    expect(parsed!.signals).toHaveLength(1);
    expect(parsed!.signals[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'bullish',
      horizonDays: 180,
      confidence: 0.83,
      timestampSec: 5,
    });
    expect(parsed!.dropped).toEqual([]);
  });

  it('drops a fabricated quote and REPORTS it rather than swallowing it', () => {
    const parsed = parseExtractedSignals(
      reply([
        {
          ticker: 'NVDA',
          direction: 'bullish',
          thesis: 'Invented',
          horizonDays: 90,
          confidence: 0.9,
          quote: 'NVDA is going to double by the end of the year, I am certain of it',
        },
      ]),
      transcript,
    );
    expect(parsed!.signals).toEqual([]);
    expect(parsed!.dropped).toEqual([{ reason: 'quote_not_verbatim', ticker: 'NVDA', quote: expect.any(String) }]);
  });

  it('keeps one call per ticker per video', () => {
    const call = {
      ticker: 'AAPL',
      direction: 'bullish',
      thesis: 'Services',
      horizonDays: 90,
      confidence: 0.8,
      quote: 'I am buying AAPL here because services revenue keeps compounding',
    };
    const parsed = parseExtractedSignals(reply([call, { ...call, thesis: 'Services again' }]), transcript);
    expect(parsed!.signals).toHaveLength(1);
    expect(parsed!.dropped[0].reason).toBe('duplicate_ticker');
  });

  it('rejects a non-ticker and a malformed row without losing the good one', () => {
    const parsed = parseExtractedSignals(
      reply([
        {
          ticker: 'Apple Inc',
          direction: 'bullish',
          thesis: 'x',
          horizonDays: 90,
          confidence: 1,
          quote: 'a'.repeat(40),
        },
        { ticker: 'TSLA', direction: 'sideways', thesis: 'x', horizonDays: 90, confidence: 1, quote: 'a'.repeat(40) },
        {
          ticker: 'TSLA',
          direction: 'bearish',
          thesis: 'Multiple too rich',
          horizonDays: 365,
          confidence: 0.6,
          quote: 'and I would not touch TSLA at this multiple for the next year',
        },
      ]),
      transcript,
    );
    expect(parsed!.signals.map((s) => s.ticker)).toEqual(['TSLA']);
    expect(parsed!.dropped.map((d) => d.reason)).toEqual(['bad_ticker', 'missing_direction']);
  });

  it('names WHICH field the model omitted, so a barren video is diagnosable', () => {
    // The live failure this exists for: good tickers, and every row dropped. A count alone could not tell
    // "the model declined to quote" from "the model emitted garbage" — and the transcript is gone by then.
    const parsed = parseExtractedSignals(
      reply([
        { ticker: 'AMZN', direction: 'bullish', thesis: 'Retail margins', horizonDays: 90, confidence: 0.7, quote: '' },
        { ticker: 'MSFT', thesis: 'Azure', horizonDays: 90, confidence: 0.7, quote: 'a'.repeat(40) },
      ]),
      transcript,
    );
    expect(parsed!.signals).toEqual([]);
    expect(parsed!.dropped.map((d) => d.reason)).toEqual(['missing_quote', 'missing_direction']);
    expect(parsed!.dropped[0].ticker).toBe('AMZN');
  });

  it("accepts the model's own field name for the thesis", () => {
    // Every live reply used `reason`, never `thesis`. Taking it beats falling back to the quote.
    const parsed = parseExtractedSignals(
      reply([
        {
          ticker: 'AAPL',
          direction: 'bullish',
          reason: 'Services revenue compounds faster than the market prices in',
          quote: 'I am buying AAPL here because services revenue keeps compounding',
        },
      ]),
      transcript,
    );
    expect(parsed!.dropped).toEqual([]);
    expect(parsed!.signals[0].thesis).toBe('Services revenue compounds faster than the market prices in');
  });

  it('keeps a call whose thesis the model omitted, standing the quote in for it', () => {
    // Exactly the reply that made a live run yield nothing: ticker, direction and a real quote, no thesis.
    const parsed = parseExtractedSignals(
      reply([
        {
          ticker: 'AAPL',
          direction: 'bullish',
          quote: 'I am buying AAPL here because services revenue keeps compounding',
        },
      ]),
      transcript,
    );
    expect(parsed!.dropped).toEqual([]);
    expect(parsed!.signals[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'bullish',
      thesis: 'I am buying AAPL here because services revenue keeps compounding',
      // The bounded defaults still apply to the other fields the model skipped.
      horizonDays: 90,
      confidence: 0.5,
    });
  });

  it('an empty signal list is an honest answer; an unparseable reply is not', () => {
    expect(parseExtractedSignals(reply([]), transcript)).toEqual({ signals: [], dropped: [] });
    expect(parseExtractedSignals('I could not find any calls, sorry.', transcript)).toBeNull();
  });

  it('clamps an absurd horizon rather than letting a claim resolve tomorrow', () => {
    const parsed = parseExtractedSignals(
      reply([
        {
          ticker: 'AAPL',
          direction: 'bullish',
          thesis: 'Services',
          horizonDays: 1,
          confidence: 0.8,
          quote: 'I am buying AAPL here because services revenue keeps compounding',
        },
      ]),
      transcript,
    );
    expect(parsed!.signals[0].horizonDays).toBe(14);
  });
});

describe('signal_extraction — the claim it becomes', () => {
  it('scores an index call as market timing and a company call as stock selection', () => {
    expect(claimTypeForTicker('SPY')).toBe('market_timing');
    expect(claimTypeForTicker('AAPL')).toBe('stock_selection');
  });

  it('maps confidence to how hedged the claim was stated', () => {
    expect(hedgeLevelForConfidence(0.9)).toBe('low');
    expect(hedgeLevelForConfidence(0.5)).toBe('medium');
    expect(hedgeLevelForConfidence(0.1)).toBe('high');
  });

  it('names the price it is anchored to AND what that price is', () => {
    const condition = buildFalsifiableCondition({
      ticker: 'AAPL',
      direction: 'bullish',
      referencePrice: 232.1449,
      referenceAsOf: '2026-09-03T12:00:00.000Z',
      resolveBy: '2026-12-02T12:00:00.000Z',
      publishedAt: '2026-08-30T00:00:00.000Z',
    });
    expect(condition).toBe(
      'AAPL closes above $232.14 (its price when this call was logged, 2026-09-03) on 2026-12-02.',
    );
  });

  it('stays falsifiable with no price at all, anchoring on the publish-day close', () => {
    expect(
      buildFalsifiableCondition({
        ticker: 'TSLA',
        direction: 'bearish',
        referencePrice: null,
        referenceAsOf: '2026-09-03T12:00:00.000Z',
        resolveBy: '2026-12-02T12:00:00.000Z',
        publishedAt: '2026-08-30T00:00:00.000Z',
      }),
    ).toBe('TSLA closes below its 2026-08-30 close on 2026-12-02.');
  });

  it('gives a neutral call a band rather than a direction', () => {
    expect(
      buildFalsifiableCondition({
        ticker: 'MSFT',
        direction: 'neutral',
        referencePrice: 100,
        referenceAsOf: '2026-09-03T12:00:00.000Z',
        resolveBy: '2026-12-02T12:00:00.000Z',
        publishedAt: null,
      }),
    ).toContain('between $95.00 and $105.00');
  });

  it('dates the horizon from the video, not from when we happened to read it', () => {
    expect(resolveByFor('2026-08-30T00:00:00.000Z', 90, new Date('2026-09-03T00:00:00.000Z'))).toBe(
      '2026-11-28T00:00:00.000Z',
    );
    // No publish date → the read time is the only honest anchor available.
    expect(resolveByFor(null, 90, new Date('2026-09-03T00:00:00.000Z'))).toBe('2026-12-02T00:00:00.000Z');
  });

  it('never resolves a claim in the past, however old the video is', () => {
    // Back-reading a channel: publish + horizon elapsed months ago. Grading it against today's price on a
    // date already gone is not a hard claim, it is an ungradable one.
    expect(resolveByFor('2026-01-10T00:00:00.000Z', 90, new Date('2026-09-03T00:00:00.000Z'))).toBe(
      '2026-12-02T00:00:00.000Z',
    );
  });

  it('links to the moment the creator said it', () => {
    expect(buildSourceRef('abc123', 742)).toBe('https://www.youtube.com/watch?v=abc123&t=742s');
    // A source with no cue timings must not fake one.
    expect(buildSourceRef('abc123', 0)).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('normalizes tickers and refuses company names', () => {
    expect(normalizeTicker(' $msft ')).toBe('MSFT');
    expect(normalizeTicker('Berkshire Hathaway')).toBeNull();
    expect(normalizeTicker(42)).toBeNull();
  });
});

describe('signal_extraction — against a real cached transcript', () => {
  it('recovers a quote from the committed Carlson corpus', async () => {
    const source = new LocalTranscriptSource(CARLSON_CORPUS);
    const [videoId] = await source.listVideos('JosephCarlsonShow', 1);
    const transcript = await source.fetchTranscript(videoId);
    expect(transcript).not.toBeNull();

    // Take a genuine span out of the middle of the real transcript, mangle its casing and spacing the way a
    // model does, and prove the recovered text is byte-identical to what the creator actually said.
    const span = transcript!.text.slice(400, 520);
    const index = buildQuoteIndex(transcript!.text);
    const recovered = recoverVerbatimQuote(index, span.toUpperCase().replace(/\s+/g, '   '));
    expect(recovered?.text).toBe(span.trim());
  });
});
