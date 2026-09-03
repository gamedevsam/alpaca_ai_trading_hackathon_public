// Computed option Greeks — the free-feed path for B52 (A8 → Option B).
//
// WHY THIS EXISTS: greeks are not always handed to us. Alpaca's free `feed=indicative` snapshot *does*
// carry `greeks` + `impliedVolatility` on liquid near-the-money contracts (measured 2026-09-03 — B52's
// original "greeks need the paid OPRA feed" premise was wrong), but it reports nothing for thin/far-OTM
// contracts and the simulator has no feed at all. So we solve them ourselves from the real quote mid with
// Black–Scholes and label them honestly as computed estimates wherever they surface. `FeedGreeksSource`
// (below) prefers the feed's own numbers and falls back here; an OPRA-backed source drops in the same way.
//
// SWAPPABLE BY DESIGN: everything downstream depends on the `OptionGreeksSource` interface, not on
// Black–Scholes. `BlackScholesGreeksSource` is one implementation; a future `OpraGreeksSource` is another.
//
// MODEL CAVEATS (honest-estimates requirement — these are why the values are *estimates*, not exact):
//   - European-exercise formula applied to AMERICAN-style equity options. For the covered-call / CSP
//     Level-1 strategy (short OTM, held to expiry/assignment) the early-exercise premium is small, but it
//     is a real approximation — delta/theta near a dividend or deep ITM will drift from a true American model.
//   - DIVIDEND YIELD defaults to 0. Real dividend-paying underlyings will bias call greeks slightly high
//     and put greeks slightly low. Pass `dividendYield` when a better figure is available.
//   - RISK-FREE RATE is a static documented constant (`DEFAULT_RISK_FREE_RATE`), not a live curve. It is a
//     small second-order input for short-dated options; refresh it periodically or pass an override.
//   - IMPLIED VOL is solved from the quote MID. A wide/stale indicative spread yields a noisy IV and
//     therefore noisy greeks — callers should treat a null result (unsolvable) as "no greek available".
// These are acceptable for PAPER trading; re-examine before live money (arm-time gate, per B54).

export type OptionRight = 'call' | 'put';

// A static, documented risk-free-rate approximation (annualized, continuous). Chosen as a round stand-in
// near the prevailing short-term US Treasury yield; it is a minor input for the short-dated contracts this
// strategy trades. Override per-call when a live figure is available.
export const DEFAULT_RISK_FREE_RATE = 0.043;

// Greeks the data feed already computed for this contract, when it supplied any (structurally the same
// shape as `AlpacaFeedGreeks` — declared here so this pure model file keeps depending on nothing).
export interface FeedSuppliedGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  impliedVol: number | null;
}

export interface OptionGreeksQuery {
  right: OptionRight;
  underlyingPrice: number;
  strike: number;
  // Years to expiration (annualized). Use `yearsUntilExpiration()` to derive this from a YYYY-MM-DD date.
  yearsToExpiry: number;
  // The option contract's market MID price (per share, not per contract) from the indicative feed. Implied
  // vol — and thus every greek — is solved from this when the feed supplied none. 0/negative = no usable
  // mid, which the Black–Scholes source reports as "no greek" rather than solving off a bad price.
  optionMidPrice: number;
  // What the feed itself reported for this contract, when it reported anything. `FeedGreeksSource` prefers
  // these; every other source ignores them.
  feedGreeks?: FeedSuppliedGreeks | null;
  // Annualized continuous risk-free rate and dividend yield. Both default to documented approximations.
  riskFreeRate?: number;
  dividendYield?: number;
}

export interface ComputedOptionGreeks {
  // Per-share greeks, matching standard option-quote conventions.
  delta: number; // ∂price/∂underlying
  gamma: number; // ∂delta/∂underlying
  theta: number; // time decay, per CALENDAR DAY (negative for a long option)
  vega: number; // ∂price per 1.00% (one percentage point) change in implied vol
  impliedVol: number | null; // annualized — solved from the mid, or as the feed reported it
  // Provenance so every surface can label the number honestly (owner's honest-estimates requirement).
  // `feed_indicative` = the free feed's own model output; `black_scholes_indicative` = ours, solved from
  // the quote mid; `broker` = an OPRA/broker-authoritative greek (not wired yet).
  source: 'feed_indicative' | 'black_scholes_indicative' | 'broker';
}

// The swap point. `BlackScholesGreeksSource` computes from the free feed today; an OPRA-backed source is a
// drop-in replacement later (same interface, `source: 'broker'`), with no change to any call site.
export interface OptionGreeksSource {
  readonly label: string;
  // Returns null when a reliable greek can't be produced (bad inputs, or IV won't solve from the quote).
  compute(query: OptionGreeksQuery): ComputedOptionGreeks | null;
}

// ---- Black–Scholes core (pure, no dates, no I/O — golden-tested) --------------------------------------

// Standard normal PDF.
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation (max abs error ~1.5e-7 —
// comfortably tighter than the quote noise the greeks are built on).
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

export interface BlackScholesInputs {
  right: OptionRight;
  underlyingPrice: number; // S
  strike: number; // K
  yearsToExpiry: number; // T
  volatility: number; // σ, annualized
  riskFreeRate?: number; // r
  dividendYield?: number; // q
}

export interface BlackScholesResult {
  price: number;
  delta: number;
  gamma: number;
  theta: number; // per CALENDAR DAY
  vega: number; // per 1.00% (one percentage point) vol change
}

const DAYS_PER_YEAR = 365;

// Full Black–Scholes price + greeks for a European option with continuous dividend yield. Returns null for
// degenerate inputs (non-positive S/K/T/σ) rather than emitting NaN/Infinity downstream.
export function blackScholesGreeks(inputs: BlackScholesInputs): BlackScholesResult | null {
  const { right, underlyingPrice: s, strike: k, yearsToExpiry: t, volatility: sigma } = inputs;
  const r = inputs.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const q = inputs.dividendYield ?? 0;
  if (!(s > 0) || !(k > 0) || !(t > 0) || !(sigma > 0)) {
    return null;
  }

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discountS = Math.exp(-q * t);
  const discountK = Math.exp(-r * t);
  const pdfD1 = normalPdf(d1);

  // Gamma and vega are right-agnostic.
  const gamma = (discountS * pdfD1) / (s * sigma * sqrtT);
  const vegaPerUnitVol = s * discountS * pdfD1 * sqrtT;

  let price: number;
  let delta: number;
  let thetaPerYear: number;
  if (right === 'call') {
    const nD1 = normalCdf(d1);
    const nD2 = normalCdf(d2);
    price = s * discountS * nD1 - k * discountK * nD2;
    delta = discountS * nD1;
    thetaPerYear = -(s * discountS * pdfD1 * sigma) / (2 * sqrtT) - r * k * discountK * nD2 + q * s * discountS * nD1;
  } else {
    const nNegD1 = normalCdf(-d1);
    const nNegD2 = normalCdf(-d2);
    price = k * discountK * nNegD2 - s * discountS * nNegD1;
    delta = -discountS * nNegD1;
    thetaPerYear =
      -(s * discountS * pdfD1 * sigma) / (2 * sqrtT) + r * k * discountK * nNegD2 - q * s * discountS * nNegD1;
  }

  return {
    price,
    delta,
    gamma,
    theta: thetaPerYear / DAYS_PER_YEAR, // report per calendar day, the quote convention
    vega: vegaPerUnitVol / 100, // report per 1.00% vol change, the quote convention
  };
}

// ---- Implied-vol solver (Newton–Raphson with a bisection safety net) ---------------------------------

const IV_MIN = 1e-4;
const IV_MAX = 5; // 500% — an option quote implying more is treated as unsolvable, not clamped silently.
const IV_TOLERANCE = 1e-6; // price-match tolerance (per share)
const IV_MAX_ITERATIONS = 100;

// Solve annualized implied volatility from a market price. Newton–Raphson (fast, uses vega) with a
// bisection fallback for the rare cases where Newton steps out of the bracket or vega collapses. Returns
// null when no volatility in [IV_MIN, IV_MAX] reproduces the price — e.g. a price below intrinsic value or
// a garbage quote — so callers surface "no greek" rather than a fabricated number.
export function impliedVolatility(params: {
  right: OptionRight;
  underlyingPrice: number;
  strike: number;
  yearsToExpiry: number;
  marketPrice: number;
  riskFreeRate?: number;
  dividendYield?: number;
}): number | null {
  const { right, underlyingPrice: s, strike: k, yearsToExpiry: t, marketPrice } = params;
  const r = params.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const q = params.dividendYield ?? 0;
  if (!(s > 0) || !(k > 0) || !(t > 0) || !(marketPrice > 0)) {
    return null;
  }

  // No-arbitrage bounds: a price below intrinsic (or above the underlying) can't come from any σ.
  const discountS = Math.exp(-q * t);
  const discountK = Math.exp(-r * t);
  const intrinsic =
    right === 'call' ? Math.max(0, s * discountS - k * discountK) : Math.max(0, k * discountK - s * discountS);
  const upperBound = right === 'call' ? s * discountS : k * discountK;
  if (marketPrice < intrinsic - IV_TOLERANCE || marketPrice > upperBound + IV_TOLERANCE) {
    return null;
  }

  const priceAt = (sigma: number): number | null => {
    const bs = blackScholesGreeks({
      right,
      underlyingPrice: s,
      strike: k,
      yearsToExpiry: t,
      volatility: sigma,
      riskFreeRate: r,
      dividendYield: q,
    });
    return bs ? bs.price : null;
  };

  // Newton–Raphson from a reasonable seed.
  let sigma = 0.25;
  for (let i = 0; i < IV_MAX_ITERATIONS; i++) {
    const bs = blackScholesGreeks({
      right,
      underlyingPrice: s,
      strike: k,
      yearsToExpiry: t,
      volatility: sigma,
      riskFreeRate: r,
      dividendYield: q,
    });
    if (!bs) {
      break;
    }
    const diff = bs.price - marketPrice;
    if (Math.abs(diff) < IV_TOLERANCE) {
      return sigma;
    }
    const vegaPerUnitVol = bs.vega * 100; // undo the per-1% scaling for the derivative
    if (!(vegaPerUnitVol > 1e-8)) {
      break; // vega collapsed — hand off to bisection
    }
    const next = sigma - diff / vegaPerUnitVol;
    if (!Number.isFinite(next) || next <= IV_MIN || next >= IV_MAX) {
      break; // stepped out of the bracket — hand off to bisection
    }
    sigma = next;
  }

  // Bisection fallback over the full bracket.
  let lo = IV_MIN;
  let hi = IV_MAX;
  const priceLo = priceAt(lo);
  const priceHi = priceAt(hi);
  if (priceLo == null || priceHi == null) {
    return null;
  }
  // Price is monotonic increasing in σ; the target must be bracketed.
  if ((priceLo - marketPrice) * (priceHi - marketPrice) > 0) {
    return null;
  }
  for (let i = 0; i < IV_MAX_ITERATIONS; i++) {
    const mid = 0.5 * (lo + hi);
    const priceMid = priceAt(mid);
    if (priceMid == null) {
      return null;
    }
    const diff = priceMid - marketPrice;
    if (Math.abs(diff) < IV_TOLERANCE || hi - lo < IV_MIN) {
      return mid;
    }
    if (diff > 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return 0.5 * (lo + hi);
}

// ---- The default free-feed source --------------------------------------------------------------------

export class BlackScholesGreeksSource implements OptionGreeksSource {
  readonly label = 'Black–Scholes (computed from indicative quote)';

  compute(query: OptionGreeksQuery): ComputedOptionGreeks | null {
    const iv = impliedVolatility({
      right: query.right,
      underlyingPrice: query.underlyingPrice,
      strike: query.strike,
      yearsToExpiry: query.yearsToExpiry,
      marketPrice: query.optionMidPrice,
      riskFreeRate: query.riskFreeRate,
      dividendYield: query.dividendYield,
    });
    if (iv == null) {
      return null;
    }
    const bs = blackScholesGreeks({
      right: query.right,
      underlyingPrice: query.underlyingPrice,
      strike: query.strike,
      yearsToExpiry: query.yearsToExpiry,
      volatility: iv,
      riskFreeRate: query.riskFreeRate,
      dividendYield: query.dividendYield,
    });
    if (!bs) {
      return null;
    }
    return {
      delta: bs.delta,
      gamma: bs.gamma,
      theta: bs.theta,
      vega: bs.vega,
      impliedVol: iv,
      source: 'black_scholes_indicative',
    };
  }
}

// The feed's own greeks when it supplied them, our Black–Scholes solve when it didn't (H0).
//
// WHY THIS IS THE DEFAULT: measured 2026-09-03 against the free `indicative` feed, every near-the-money
// SPY contract came back with `greeks` + `impliedVolatility` — so the B52-era assumption that greeks
// require the paid OPRA feed was simply wrong. The feed's delta is closer to what the broker prices the
// contract at than our European-formula solve, so it wins; Black–Scholes stays as the labelled fallback
// for contracts (and simulated quotes) the feed reports nothing for. Neither is ever silently swapped —
// `source` travels with the number and `describeDeltaSource` renders it.
export class FeedGreeksSource implements OptionGreeksSource {
  readonly label = 'Feed-supplied greeks (Black–Scholes fallback)';

  constructor(private readonly fallback: OptionGreeksSource = new BlackScholesGreeksSource()) {}

  compute(query: OptionGreeksQuery): ComputedOptionGreeks | null {
    const feed = query.feedGreeks;
    if (feed && Number.isFinite(feed.delta) && Number.isFinite(feed.gamma)) {
      return {
        delta: feed.delta,
        gamma: feed.gamma,
        theta: feed.theta,
        vega: feed.vega,
        impliedVol: feed.impliedVol != null && Number.isFinite(feed.impliedVol) ? feed.impliedVol : null,
        source: 'feed_indicative',
      };
    }
    return this.fallback.compute(query);
  }
}

// The process-wide default greeks source. Swap this single binding — or inject an alternative
// `OptionGreeksSource` at a call site — to move onto OPRA broker-computed greeks later (the B52 upgrade
// path), with no other change.
export const defaultOptionGreeksSource: OptionGreeksSource = new FeedGreeksSource();

// Years from now until a YYYY-MM-DD expiration (annualized on a 365-day year), floored at a small epsilon
// so an expiring-today contract still yields finite greeks. Kept as a thin, separately-testable seam so
// the Black–Scholes core stays free of `Date.now()`.
export function yearsUntilExpiration(expiration: string, now: number = Date.now()): number {
  const expiresAt = Date.parse(`${expiration}T00:00:00.000Z`);
  if (!Number.isFinite(expiresAt)) {
    return 0;
  }
  const years = (expiresAt - now) / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);
  return Math.max(years, 1 / (DAYS_PER_YEAR * 24)); // floor at ~1 hour so T>0 always
}
