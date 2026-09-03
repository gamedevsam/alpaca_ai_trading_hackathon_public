import { buildOccSymbol, optionQuoteMid, parseOccSymbol } from '../alpaca.types';

describe('OCC option symbol helpers (B52)', () => {
  it('builds the standard OCC contract symbol', () => {
    expect(buildOccSymbol('AAPL', '2025-06-20', 'call', 200)).toBe('AAPL250620C00200000');
    expect(buildOccSymbol('SPY', '2026-01-16', 'put', 512.5)).toBe('SPY260116P00512500');
    // Lower-case root is normalized.
    expect(buildOccSymbol('aapl', '2026-07-13', 'call', 210)).toBe('AAPL260713C00210000');
  });

  it('parses a real OCC symbol back into its parts', () => {
    expect(parseOccSymbol('AAPL260713C00210000')).toEqual({
      underlying: 'AAPL',
      expiration: '2026-07-13',
      right: 'call',
      strike: 210,
    });
    expect(parseOccSymbol('SPY260116P00512500')).toEqual({
      underlying: 'SPY',
      expiration: '2026-01-16',
      right: 'put',
      strike: 512.5,
    });
  });

  it('round-trips build → parse across a grid of contracts', () => {
    for (const underlying of ['AAPL', 'MSFT', 'NVDA', 'A', 'GOOGL']) {
      for (const right of ['call', 'put'] as const) {
        for (const strike of [1, 5, 42.5, 200, 512.5, 9999.99]) {
          const occ = buildOccSymbol(underlying, '2026-07-13', right, strike);
          expect(parseOccSymbol(occ)).toEqual({ underlying, expiration: '2026-07-13', right, strike });
        }
      }
    }
  });

  it('returns null for anything that is not a valid OCC symbol', () => {
    expect(parseOccSymbol('')).toBeNull();
    expect(parseOccSymbol('AAPL')).toBeNull();
    expect(parseOccSymbol('AAPL260713X00210000')).toBeNull(); // bad right code
    expect(parseOccSymbol('AAPL261399C00210000')).toBeNull(); // month 13 / day 99
    expect(parseOccSymbol('AAPL260713C0021000')).toBeNull(); // strike not 8 digits
    expect(parseOccSymbol('TOOLONGROOT260713C00210000')).toBeNull(); // root > 6 chars
  });

  describe('optionQuoteMid', () => {
    it('averages a two-sided quote', () => {
      expect(optionQuoteMid(1.0, 1.2)).toBe(1.1);
      expect(optionQuoteMid(104.86, 108.97)).toBeCloseTo(106.92, 2);
    });

    it('returns null for a one-sided, absent, non-positive, or crossed quote', () => {
      expect(optionQuoteMid(null, 1.2)).toBeNull();
      expect(optionQuoteMid(1.0, null)).toBeNull();
      expect(optionQuoteMid(0, 1.2)).toBeNull();
      expect(optionQuoteMid(1.5, 1.2)).toBeNull(); // ask < bid (crossed)
    });
  });
});
