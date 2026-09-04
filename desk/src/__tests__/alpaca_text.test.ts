import { tidyTruncatedText, truncateOnWordBoundary } from '../alpaca_text';

describe('truncateOnWordBoundary', () => {
  it('leaves text that already fits untouched', () => {
    expect(truncateOnWordBoundary('Strong conviction, harvest premium.', 500)).toBe(
      'Strong conviction, harvest premium.',
    );
  });

  it('never ends mid-word, and marks the cut with an ellipsis', () => {
    const cut = truncateOnWordBoundary('alpha bravo charlie delta echo', 20);
    expect(cut).toBe('alpha bravo charlie…');
    expect(cut.length).toBeLessThanOrEqual(20);
  });

  it('drops the punctuation left dangling at the break', () => {
    expect(truncateOnWordBoundary('alpha bravo, charlie delta', 15)).toBe('alpha bravo…');
  });

  it('cuts inside a single token that is longer than the whole budget', () => {
    // No space to break on — a cut word still beats an empty field.
    expect(truncateOnWordBoundary('supercalifragilistic', 10)).toBe('supercali…');
  });

  it('trims surrounding whitespace', () => {
    expect(truncateOnWordBoundary('   spaced out   ', 500)).toBe('spaced out');
  });
});

describe('tidyTruncatedText', () => {
  const CAP = 500;

  it('repairs a record a writer cut mid-word at the cap', () => {
    // Exactly the shape the desk stored before the writer cut cleanly: 500 chars ending mid-word.
    const stored = `${'reason '.repeat(70)}market_timin`.slice(0, CAP);
    expect(stored).toHaveLength(CAP);

    const shown = tidyTruncatedText(stored, CAP);

    expect(shown.endsWith('…')).toBe(true);
    expect(shown.slice(0, -1)).toMatch(/\w$/);
    expect(stored.startsWith(shown.slice(0, -1))).toBe(true);
  });

  it('leaves a rationale that never reached the cap exactly as written', () => {
    const short = 'The 560 put is 4% out of the money on an 8-day contract.';
    expect(tidyTruncatedText(short, CAP)).toBe(short);
  });

  it('is idempotent — tidying an already-tidied string changes nothing', () => {
    const stored = `${'reason '.repeat(70)}market_timin`.slice(0, CAP);
    const once = tidyTruncatedText(stored, CAP);
    expect(tidyTruncatedText(once, CAP)).toBe(once);
  });
});
