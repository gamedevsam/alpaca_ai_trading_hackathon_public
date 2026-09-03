import {
  BlackScholesGreeksSource,
  DEFAULT_RISK_FREE_RATE,
  FeedGreeksSource,
  blackScholesGreeks,
  impliedVolatility,
  normalCdf,
  yearsUntilExpiration,
} from '../option_greeks';

describe('option_greeks — normalCdf', () => {
  it('matches known standard-normal values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 5);
    expect(normalCdf(0.35)).toBeCloseTo(0.6368307, 5);
  });
});

describe('option_greeks — blackScholesGreeks golden fixture', () => {
  // Textbook / widely-published Black–Scholes benchmark: S=K=100, r=5%, q=0, T=1yr, σ=20%.
  // Reference: call ≈ 10.4506, put ≈ 5.5735, call Δ ≈ 0.6368, Γ ≈ 0.018762, vega(1%) ≈ 0.37524,
  // call θ/day ≈ -0.017573.
  const base = {
    underlyingPrice: 100,
    strike: 100,
    yearsToExpiry: 1,
    volatility: 0.2,
    riskFreeRate: 0.05,
    dividendYield: 0,
  };

  it('prices a call to the published value', () => {
    const bs = blackScholesGreeks({ right: 'call', ...base })!;
    expect(bs.price).toBeCloseTo(10.450584, 3);
    expect(bs.delta).toBeCloseTo(0.636831, 4);
    expect(bs.gamma).toBeCloseTo(0.018762, 5);
    expect(bs.vega).toBeCloseTo(0.37524, 4);
    expect(bs.theta).toBeCloseTo(-0.017573, 4); // per calendar day
  });

  it('prices a put to the published value', () => {
    const bs = blackScholesGreeks({ right: 'put', ...base })!;
    expect(bs.price).toBeCloseTo(5.573526, 3);
    expect(bs.delta).toBeCloseTo(-0.363169, 4);
    // Gamma and vega are right-agnostic.
    expect(bs.gamma).toBeCloseTo(0.018762, 5);
    expect(bs.vega).toBeCloseTo(0.37524, 4);
  });
});

describe('option_greeks — structural invariants', () => {
  const grid = [
    { underlyingPrice: 100, strike: 95, yearsToExpiry: 0.5, volatility: 0.3 },
    { underlyingPrice: 50, strike: 55, yearsToExpiry: 0.25, volatility: 0.45 },
    { underlyingPrice: 200, strike: 200, yearsToExpiry: 2, volatility: 0.18 },
    { underlyingPrice: 30, strike: 20, yearsToExpiry: 1.5, volatility: 0.6 },
  ];
  const r = 0.04;
  const q = 0.01;

  it('satisfies put–call parity: C - P = S·e^{-qT} - K·e^{-rT}', () => {
    for (const g of grid) {
      const call = blackScholesGreeks({ right: 'call', ...g, riskFreeRate: r, dividendYield: q })!;
      const put = blackScholesGreeks({ right: 'put', ...g, riskFreeRate: r, dividendYield: q })!;
      const parity = g.underlyingPrice * Math.exp(-q * g.yearsToExpiry) - g.strike * Math.exp(-r * g.yearsToExpiry);
      expect(call.price - put.price).toBeCloseTo(parity, 6);
    }
  });

  it('gamma and vega are identical for calls and puts; call delta minus put delta ≈ e^{-qT}', () => {
    for (const g of grid) {
      const call = blackScholesGreeks({ right: 'call', ...g, riskFreeRate: r, dividendYield: q })!;
      const put = blackScholesGreeks({ right: 'put', ...g, riskFreeRate: r, dividendYield: q })!;
      expect(call.gamma).toBeCloseTo(put.gamma, 9);
      expect(call.vega).toBeCloseTo(put.vega, 9);
      expect(call.delta - put.delta).toBeCloseTo(Math.exp(-q * g.yearsToExpiry), 6);
    }
  });

  it('a long option has negative theta and a call delta within (0,1)', () => {
    for (const g of grid) {
      const call = blackScholesGreeks({ right: 'call', ...g })!;
      const put = blackScholesGreeks({ right: 'put', ...g })!;
      expect(call.theta).toBeLessThan(0);
      expect(put.theta).toBeLessThan(0);
      expect(call.delta).toBeGreaterThan(0);
      expect(call.delta).toBeLessThan(1);
      expect(put.delta).toBeGreaterThan(-1);
      expect(put.delta).toBeLessThan(0);
    }
  });

  it('returns null for degenerate inputs', () => {
    expect(
      blackScholesGreeks({ right: 'call', underlyingPrice: 0, strike: 100, yearsToExpiry: 1, volatility: 0.2 }),
    ).toBeNull();
    expect(
      blackScholesGreeks({ right: 'call', underlyingPrice: 100, strike: 0, yearsToExpiry: 1, volatility: 0.2 }),
    ).toBeNull();
    expect(
      blackScholesGreeks({ right: 'call', underlyingPrice: 100, strike: 100, yearsToExpiry: 0, volatility: 0.2 }),
    ).toBeNull();
    expect(
      blackScholesGreeks({ right: 'call', underlyingPrice: 100, strike: 100, yearsToExpiry: 1, volatility: 0 }),
    ).toBeNull();
  });
});

describe('option_greeks — impliedVolatility round-trips', () => {
  it('recovers the volatility used to price the option (Newton path)', () => {
    const cases = [
      { right: 'call' as const, underlyingPrice: 100, strike: 100, yearsToExpiry: 1, sigma: 0.2 },
      { right: 'call' as const, underlyingPrice: 100, strike: 110, yearsToExpiry: 0.5, sigma: 0.35 },
      { right: 'put' as const, underlyingPrice: 100, strike: 90, yearsToExpiry: 0.75, sigma: 0.28 },
      { right: 'put' as const, underlyingPrice: 250, strike: 260, yearsToExpiry: 0.1, sigma: 0.55 },
      { right: 'call' as const, underlyingPrice: 20, strike: 15, yearsToExpiry: 2, sigma: 0.8 },
    ];
    for (const c of cases) {
      const priced = blackScholesGreeks({
        right: c.right,
        underlyingPrice: c.underlyingPrice,
        strike: c.strike,
        yearsToExpiry: c.yearsToExpiry,
        volatility: c.sigma,
      })!;
      const iv = impliedVolatility({
        right: c.right,
        underlyingPrice: c.underlyingPrice,
        strike: c.strike,
        yearsToExpiry: c.yearsToExpiry,
        marketPrice: priced.price,
      });
      expect(iv).not.toBeNull();
      expect(iv!).toBeCloseTo(c.sigma, 4);
    }
  });

  it('returns null for an impossible price (below intrinsic / above underlying / non-positive)', () => {
    // Deep ITM call, T=1, mid below its discounted intrinsic value is unsolvable.
    expect(
      impliedVolatility({ right: 'call', underlyingPrice: 100, strike: 50, yearsToExpiry: 1, marketPrice: 1 }),
    ).toBeNull();
    // Above the underlying price — no σ produces it.
    expect(
      impliedVolatility({ right: 'call', underlyingPrice: 100, strike: 100, yearsToExpiry: 1, marketPrice: 200 }),
    ).toBeNull();
    expect(
      impliedVolatility({ right: 'put', underlyingPrice: 100, strike: 100, yearsToExpiry: 1, marketPrice: 0 }),
    ).toBeNull();
  });
});

describe('option_greeks — BlackScholesGreeksSource', () => {
  const source = new BlackScholesGreeksSource();

  it('computes greeks from a quote mid and labels them as computed', () => {
    // Build a realistic mid by pricing at a known σ, then round-trip through the source.
    const sigma = 0.32;
    const priced = blackScholesGreeks({
      right: 'call',
      underlyingPrice: 150,
      strike: 155,
      yearsToExpiry: 0.25,
      volatility: sigma,
    })!;
    const greeks = source.compute({
      right: 'call',
      underlyingPrice: 150,
      strike: 155,
      yearsToExpiry: 0.25,
      optionMidPrice: priced.price,
    });
    expect(greeks).not.toBeNull();
    expect(greeks!.impliedVol).toBeCloseTo(sigma, 3);
    expect(greeks!.delta).toBeCloseTo(priced.delta, 3);
    expect(greeks!.source).toBe('black_scholes_indicative');
  });

  it('returns null when the quote cannot yield a solvable IV', () => {
    expect(
      source.compute({ right: 'call', underlyingPrice: 100, strike: 100, yearsToExpiry: 1, optionMidPrice: 0 }),
    ).toBeNull();
    expect(
      source.compute({ right: 'call', underlyingPrice: 100, strike: 50, yearsToExpiry: 1, optionMidPrice: 1 }),
    ).toBeNull();
  });

  it('has a stable, human-readable label', () => {
    expect(source.label).toMatch(/black.?scholes/i);
  });
});

describe('option_greeks — FeedGreeksSource', () => {
  const source = new FeedGreeksSource();

  it("uses the feed's own greeks and labels them as feed-supplied", () => {
    const greeks = source.compute({
      right: 'put',
      underlyingPrice: 765,
      strike: 745,
      yearsToExpiry: 0.02,
      optionMidPrice: 1.85,
      feedGreeks: { delta: -0.19, gamma: 0.012, theta: -0.23, vega: 0.15, impliedVol: 0.3179 },
    });
    expect(greeks).toMatchObject({ delta: -0.19, gamma: 0.012, impliedVol: 0.3179, source: 'feed_indicative' });
  });

  it('falls back to the Black–Scholes solve when the feed reported no greeks', () => {
    const priced = blackScholesGreeks({
      right: 'call',
      underlyingPrice: 150,
      strike: 155,
      yearsToExpiry: 0.25,
      volatility: 0.32,
    })!;
    const greeks = source.compute({
      right: 'call',
      underlyingPrice: 150,
      strike: 155,
      yearsToExpiry: 0.25,
      optionMidPrice: priced.price,
      feedGreeks: null,
    });
    expect(greeks!.source).toBe('black_scholes_indicative');
    expect(greeks!.delta).toBeCloseTo(priced.delta, 3);
  });

  it('ignores a partial/garbage feed greek rather than mixing it with a solved one', () => {
    const greeks = source.compute({
      right: 'call',
      underlyingPrice: 150,
      strike: 155,
      yearsToExpiry: 0.25,
      optionMidPrice: 0, // no usable mid either ⇒ nothing to fall back to
      feedGreeks: { delta: Number.NaN, gamma: 0.01, theta: -0.1, vega: 0.2, impliedVol: null },
    });
    expect(greeks).toBeNull();
  });
});

describe('option_greeks — yearsUntilExpiration', () => {
  it('annualizes days-to-expiry on a 365-day year against a fixed now', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(yearsUntilExpiration('2027-01-01', now)).toBeCloseTo(1, 2);
    expect(yearsUntilExpiration('2026-04-02', now)).toBeCloseTo(91 / 365, 4);
  });

  it('floors an already-expired / same-day contract at a small positive T', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(yearsUntilExpiration('2026-01-01', now)).toBeGreaterThan(0);
    expect(yearsUntilExpiration('2025-01-01', now)).toBeGreaterThan(0);
  });

  it('exposes a sane default risk-free rate', () => {
    expect(DEFAULT_RISK_FREE_RATE).toBeGreaterThan(0);
    expect(DEFAULT_RISK_FREE_RATE).toBeLessThan(0.15);
  });
});
