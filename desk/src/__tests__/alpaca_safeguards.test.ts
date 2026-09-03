import { AlpacaAssetInfo, AlpacaOptionInstrument, AlpacaPositionInfo } from '../alpaca.types';
import {
  AlpacaControlLimits,
  AlpacaKillState,
  computeOptionDelta,
  deltaSourceOf,
  describeDeltaSource,
  estimateOrderNotional,
  NormalizedProposal,
  OptionProposalContext,
  ProposalCheckContext,
  runProposalPreChecks,
  stubbedOptionDelta,
} from '../alpaca_safeguards';

const DEFAULT_LIMITS: AlpacaControlLimits = {
  maxNotionalPerOrder: 10_000,
  maxPositionPct: 25,
  maxOrdersPerDay: 10,
  maxDailyNotional: 50_000,
  symbolAllowList: [],
  symbolDenyList: [],
  optionsEnabled: false,
  cooldownAfterFailureMs: 60_000,
  maxContractsPerOrder: null,
  maxContractsPerUnderlying: null,
  maxShortCallCoveredPct: null,
  minDaysToExpiry: null,
  maxDaysToExpiry: null,
  requireOtm: false,
  minStrikeVsCostBasisPct: null,
  maxAbsDelta: null,
  earningsBlackoutDays: null,
};

const HELD: AlpacaPositionInfo[] = [
  { symbol: 'AAPL', qty: 50, side: 'long', avgEntryPrice: 168, marketValue: 10_000, unrealizedPl: 1_600 },
];

const TRADABLE: AlpacaAssetInfo = { symbol: 'AAPL', tradable: true, fractionable: true };

// A standard 100-share option contract, for the notional-attribution tests below.
function optionInstrument(overrides: Partial<AlpacaOptionInstrument> = {}): AlpacaOptionInstrument {
  return {
    assetClass: 'option',
    underlying: 'AAPL',
    occSymbol: 'AAPL260918P00145000',
    expiration: '2026-09-18',
    strike: 145,
    right: 'put',
    multiplier: 100,
    positionIntent: 'sell_to_open',
    ...overrides,
  };
}

function proposal(overrides: Partial<NormalizedProposal> = {}): NormalizedProposal {
  return {
    symbol: 'AAPL',
    side: 'buy',
    orderType: 'market',
    qty: null,
    notional: 1_000,
    limitPrice: null,
    timeInForce: 'day',
    ...overrides,
  };
}

function context(overrides: Partial<ProposalCheckContext> = {}): ProposalCheckContext {
  return {
    killState: 'disarmed' as AlpacaKillState,
    limits: DEFAULT_LIMITS,
    buyingPower: 200_000,
    equity: 110_000,
    positions: HELD,
    asset: TRADABLE,
    todayOrderCount: 0,
    todayNotional: 0,
    orderRequestValid: true,
    orderRequestError: null,
    ...overrides,
  };
}

function failed(result: ReturnType<typeof runProposalPreChecks>): string[] {
  return result.checks.filter((c) => !c.passed).map((c) => c.limit);
}

describe('estimateOrderNotional', () => {
  it('uses the notional amount directly when provided', () => {
    expect(estimateOrderNotional(proposal({ notional: 2_500 }), HELD)).toBe(2_500);
  });

  it('prices a limit order off qty * limitPrice', () => {
    expect(
      estimateOrderNotional(proposal({ notional: null, qty: 10, orderType: 'limit', limitPrice: 150 }), HELD),
    ).toBe(1_500);
  });

  it('prices a market order on a held symbol off the position current price', () => {
    // AAPL held: 50 shares worth $10,000 → $200/share. 10 shares ⇒ $2,000.
    expect(estimateOrderNotional(proposal({ notional: null, qty: 10, orderType: 'market' }), HELD)).toBe(2_000);
  });

  it('returns null for a market order on an unheld symbol (no quote yet)', () => {
    expect(
      estimateOrderNotional(proposal({ symbol: 'TSLA', notional: null, qty: 10, orderType: 'market' }), HELD),
    ).toBeNull();
  });

  it('applies the contract multiplier to an option limit order (H0)', () => {
    // 2 contracts at a $1.85 premium is $370 of premium changing hands, not $3.70.
    expect(
      estimateOrderNotional(
        proposal({
          notional: null,
          qty: 2,
          orderType: 'limit',
          limitPrice: 1.85,
          instrument: optionInstrument({ right: 'put', strike: 145 }),
        }),
        HELD,
      ),
    ).toBe(370);
  });

  it('refuses to price an option MARKET order off the underlying (H0)', () => {
    expect(
      estimateOrderNotional(
        proposal({ notional: null, qty: 2, orderType: 'market', instrument: optionInstrument({}) }),
        HELD,
      ),
    ).toBeNull();
  });
});

describe('runProposalPreChecks', () => {
  it('passes a clean, in-bounds buy', () => {
    const result = runProposalPreChecks(proposal(), context());
    expect(result.passed).toBe(true);
    expect(result.failedSummary).toBe('');
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('discards when the kill switch is killed', () => {
    const result = runProposalPreChecks(proposal(), context({ killState: 'killed' }));
    expect(result.passed).toBe(false);
    expect(failed(result)).toContain('kill_switch');
  });

  it('discards an untradable / unknown symbol', () => {
    const result = runProposalPreChecks(proposal({ symbol: 'NOPE' }), context({ asset: null }));
    expect(failed(result)).toContain('symbol_tradable');
  });

  it('discards a deny-listed symbol', () => {
    const result = runProposalPreChecks(
      proposal(),
      context({ limits: { ...DEFAULT_LIMITS, symbolDenyList: ['AAPL'] } }),
    );
    expect(failed(result)).toContain('symbol_not_denied');
  });

  it('discards a symbol not on a non-empty allow-list', () => {
    const result = runProposalPreChecks(
      proposal(),
      context({ limits: { ...DEFAULT_LIMITS, symbolAllowList: ['MSFT'] } }),
    );
    expect(failed(result)).toContain('symbol_allowed');
  });

  it('allows a symbol that is on the allow-list', () => {
    const result = runProposalPreChecks(
      proposal(),
      context({ limits: { ...DEFAULT_LIMITS, symbolAllowList: ['AAPL'] } }),
    );
    expect(result.passed).toBe(true);
  });

  it('discards selling more than held', () => {
    const result = runProposalPreChecks(proposal({ side: 'sell', notional: null, qty: 80 }), context());
    expect(failed(result)).toContain('sufficient_holdings');
  });

  it('permits selling within held quantity', () => {
    const result = runProposalPreChecks(proposal({ side: 'sell', notional: null, qty: 50 }), context());
    expect(result.passed).toBe(true);
  });

  it('discards a buy that exceeds buying power', () => {
    const result = runProposalPreChecks(
      proposal({ notional: 5_000 }),
      context({ buyingPower: 1_000, limits: { ...DEFAULT_LIMITS, maxNotionalPerOrder: null } }),
    );
    expect(failed(result)).toContain('buying_power');
  });

  it('discards a buy that exceeds the per-order notional cap', () => {
    const result = runProposalPreChecks(proposal({ notional: 25_000 }), context());
    expect(failed(result)).toContain('max_notional_per_order');
  });

  it('discards a buy that would push a position past the weight cap', () => {
    // equity 110k, cap 25% ⇒ max position value $27,500. Held AAPL already $10k; a $20k buy ⇒ $30k > cap.
    const result = runProposalPreChecks(
      proposal({ notional: 20_000 }),
      context({ limits: { ...DEFAULT_LIMITS, maxNotionalPerOrder: null } }),
    );
    expect(failed(result)).toContain('max_position_pct');
  });

  it('discards when the per-day order count is already at the cap', () => {
    const result = runProposalPreChecks(proposal(), context({ todayOrderCount: 10 }));
    expect(failed(result)).toContain('max_orders_per_day');
  });

  it('discards when the order would exceed the daily notional cap', () => {
    const result = runProposalPreChecks(proposal({ notional: 5_000 }), context({ todayNotional: 48_000 }));
    expect(failed(result)).toContain('max_daily_notional');
  });

  it('records every check on the action for audit, even on a pass', () => {
    const result = runProposalPreChecks(proposal(), context());
    const names = result.checks.map((c) => c.limit);
    expect(names).toEqual(
      expect.arrayContaining([
        'kill_switch',
        'order_request',
        'symbol_tradable',
        'symbol_not_denied',
        'symbol_allowed',
        'sufficient_holdings',
        'buying_power',
        'max_notional_per_order',
        'max_position_pct',
        'max_orders_per_day',
        'max_daily_notional',
      ]),
    );
  });

  it('surfaces an invalid order request as a failed check', () => {
    const result = runProposalPreChecks(
      proposal(),
      context({ orderRequestValid: false, orderRequestError: 'exactly one of qty or notional must be set' }),
    );
    expect(failed(result)).toContain('order_request');
    expect(result.failedSummary).toContain('exactly one of qty or notional');
  });

  it('does not evaluate dollar ceilings when no quote is available (fails open at propose time only)', () => {
    // Unheld market buy by qty ⇒ no estimable notional. Dollar caps are recorded passed/unevaluated.
    const result = runProposalPreChecks(
      proposal({ symbol: 'TSLA', notional: null, qty: 10, orderType: 'market' }),
      context({ asset: { symbol: 'TSLA', tradable: true, fractionable: true } }),
    );
    expect(result.estimatedNotional).toBeNull();
    expect(result.passed).toBe(true);
    const notionalCheck = result.checks.find((c) => c.limit === 'max_notional_per_order');
    expect(notionalCheck?.passed).toBe(true);
    expect(notionalCheck?.detail).toMatch(/no quote/i);
  });
});

// B47 — options defined-risk safeguards (Layer C core).
describe('runProposalPreChecks — options (B47)', () => {
  const OPTIONS_LIMITS: AlpacaControlLimits = {
    ...DEFAULT_LIMITS,
    optionsEnabled: true,
    maxContractsPerOrder: 5,
    maxContractsPerUnderlying: 10,
    maxShortCallCoveredPct: 75,
    minDaysToExpiry: 7,
    maxDaysToExpiry: 45,
    requireOtm: true,
    minStrikeVsCostBasisPct: 100,
    maxAbsDelta: 0.35,
    earningsBlackoutDays: 3,
  };

  function instrument(overrides: Partial<AlpacaOptionInstrument> = {}): AlpacaOptionInstrument {
    return {
      assetClass: 'option',
      underlying: 'AAPL',
      occSymbol: 'AAPL250620C00200000',
      expiration: '2026-08-01',
      strike: 220,
      right: 'call',
      multiplier: 100,
      positionIntent: 'sell_to_open',
      ...overrides,
    };
  }

  function optionCtx(overrides: Partial<OptionProposalContext> = {}): OptionProposalContext {
    return {
      // 200 shares held vs. a 1-contract (100-share) covered call keeps coverage at 50%, comfortably
      // under the 75% short-call-coverage cap used by OPTIONS_LIMITS below.
      underlyingSharesHeld: 200,
      underlyingCostBasis: 168,
      underlyingPrice: 210,
      sharesPledgedToOtherShortCalls: 0,
      cashPledgedToOtherCsps: 0,
      existingContractsOnUnderlying: 0,
      cash: 50_000,
      optionsBuyingPower: 50_000,
      daysToExpiry: 20,
      delta: 0.2,
      daysToEarnings: 30,
      ...overrides,
    };
  }

  function optionProposal(
    instrumentOverrides: Partial<AlpacaOptionInstrument> = {},
    proposalOverrides: Partial<NormalizedProposal> = {},
  ): NormalizedProposal {
    return proposal({
      side: 'sell',
      notional: null,
      qty: 1,
      instrument: instrument(instrumentOverrides),
      ...proposalOverrides,
    });
  }

  it('leaves an equity proposal (no instrument) completely unaffected — no option checks recorded', () => {
    const result = runProposalPreChecks(proposal(), context({ limits: OPTIONS_LIMITS }));
    expect(result.checks.map((c) => c.limit)).not.toEqual(
      expect.arrayContaining(['options_enabled', 'defined_risk_floor']),
    );
  });

  it('passes a well-formed covered call within every bound', () => {
    const result = runProposalPreChecks(optionProposal(), context({ limits: OPTIONS_LIMITS, option: optionCtx() }));
    expect(result.passed).toBe(true);
    expect(failed(result)).toEqual([]);
  });

  // The regression the H5 cycle found against the real chain: every proposal the desk made came back
  // `sufficient_holdings: Selling 1 of 0 held`. The suite missed it because its fixtures open contracts
  // on AAPL, which HELD happens to own 50 shares of — so the equity check passed by coincidence. A desk
  // selling cash-secured puts on IWM owns none of the underlying by design, which is the entire point of
  // a CSP: the collateral is cash, and `defined_risk_floor` is what checks it.
  it('does not measure an opening option order against the underlying share count', () => {
    const result = runProposalPreChecks(
      optionProposal({ right: 'put', strike: 190, underlying: 'IWM' }, { symbol: 'IWM' }),
      context({
        limits: { ...OPTIONS_LIMITS, symbolAllowList: ['IWM'] },
        positions: [],
        option: optionCtx({ underlyingSharesHeld: 0, underlyingCostBasis: null, underlyingPrice: 210 }),
      }),
    );
    expect(failed(result)).not.toContain('sufficient_holdings');
    expect(result.checks.find((c) => c.limit === 'sufficient_holdings')?.detail).toMatch(/Option order/);
    // The cash-secured floor is what actually clears it: $19,000 needed against $50,000 cash.
    expect(failed(result)).not.toContain('defined_risk_floor');
  });

  it('still measures an equity sell against the underlying share count', () => {
    const result = runProposalPreChecks(proposal({ side: 'sell', notional: null, qty: 80 }), context());
    expect(failed(result)).toContain('sufficient_holdings');
  });

  it('rejects any option proposal when options are disabled', () => {
    const result = runProposalPreChecks(optionProposal(), context({ limits: DEFAULT_LIMITS, option: optionCtx() }));
    expect(failed(result)).toContain('options_enabled');
  });

  it('rejects a naked short call lacking sufficient covering shares', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingSharesHeld: 50 }) }),
    );
    expect(failed(result)).toContain('defined_risk_floor');
    const check = result.checks.find((c) => c.limit === 'defined_risk_floor');
    expect(check?.detail).toMatch(/NAKED CALL REJECTED/);
  });

  it('rejects a short call already pledged to another short leg even if nominally held', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({
        limits: OPTIONS_LIMITS,
        option: optionCtx({ underlyingSharesHeld: 100, sharesPledgedToOtherShortCalls: 50 }),
      }),
    );
    // 100 shares needed but only 50 free (100 held - 50 already pledged).
    expect(failed(result)).toContain('defined_risk_floor');
  });

  it('passes a well-formed cash-secured put within every bound', () => {
    const result = runProposalPreChecks(
      optionProposal({ right: 'put', strike: 190 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingPrice: 210 }) }),
    );
    expect(result.passed).toBe(true);
  });

  it('rejects a naked short put lacking sufficient reserved cash', () => {
    const result = runProposalPreChecks(
      optionProposal({ right: 'put', strike: 190 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingPrice: 210, cash: 1_000 }) }),
    );
    expect(failed(result)).toContain('defined_risk_floor');
    const check = result.checks.find((c) => c.limit === 'defined_risk_floor');
    expect(check?.detail).toMatch(/NAKED PUT REJECTED/);
  });

  it('rejects a cash-secured put whose cash is already pledged to another CSP', () => {
    const result = runProposalPreChecks(
      optionProposal({ right: 'put', strike: 190 }),
      context({
        limits: OPTIONS_LIMITS,
        option: optionCtx({ underlyingPrice: 210, cash: 20_000, cashPledgedToOtherCsps: 19_500 }),
      }),
    );
    expect(failed(result)).toContain('defined_risk_floor');
  });

  // H18: evidenced live on prod — the derived (cash - our own pledges) figure read $29,900 free while
  // the broker's own options buying power read $0, and the broker refused the order the ceiling had
  // waved through green. The broker's figure must bind even when our own book looks fine.
  it('rejects a cash-secured put when the broker reports less options buying power than our own book', () => {
    const result = runProposalPreChecks(
      optionProposal({ right: 'put', strike: 190 }),
      context({
        limits: OPTIONS_LIMITS,
        option: optionCtx({
          underlyingPrice: 210,
          cash: 50_000,
          cashPledgedToOtherCsps: 0,
          optionsBuyingPower: 10_000,
        }),
      }),
    );
    expect(failed(result)).toContain('defined_risk_floor');
    const check = result.checks.find((c) => c.limit === 'defined_risk_floor');
    expect(check?.detail).toMatch(/NAKED PUT REJECTED/);
    expect(check?.detail).toMatch(/broker options buying power \$10,000\.00/);
  });

  it('treats a closing order as defined-risk by construction, regardless of coverage', () => {
    const result = runProposalPreChecks(
      optionProposal({ positionIntent: 'buy_to_close' }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingSharesHeld: 0 }) }),
    );
    expect(failed(result)).not.toContain('defined_risk_floor');
  });

  it('treats opening a long option (buy_to_open) as defined-risk by construction', () => {
    const result = runProposalPreChecks(
      optionProposal({ positionIntent: 'buy_to_open' }, { side: 'buy' }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingSharesHeld: 0 }) }),
    );
    expect(failed(result)).not.toContain('defined_risk_floor');
  });

  it('enforces the max-contracts-per-order cap', () => {
    const result = runProposalPreChecks(
      optionProposal({}, { qty: 6 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingSharesHeld: 1_000 }) }),
    );
    expect(failed(result)).toContain('max_contracts_per_order');
  });

  it('enforces the max-contracts-per-underlying cap on an opening order', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ existingContractsOnUnderlying: 10 }) }),
    );
    expect(failed(result)).toContain('max_contracts_per_underlying');
  });

  it('does not apply the per-underlying contract cap to a closing order', () => {
    const result = runProposalPreChecks(
      optionProposal({ positionIntent: 'buy_to_close' }, { side: 'buy' }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ existingContractsOnUnderlying: 10 }) }),
    );
    expect(failed(result)).not.toContain('max_contracts_per_underlying');
  });

  it('enforces the max short-call coverage percentage', () => {
    // Cap 75%: writing against all 100 held shares = 100% > cap.
    const result = runProposalPreChecks(
      optionProposal({}, { qty: 1 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingSharesHeld: 100 }) }),
    );
    expect(failed(result)).toContain('short_call_coverage_pct');
  });

  it('rejects an expiry that is too soon (below minDaysToExpiry)', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ daysToExpiry: 2 }) }),
    );
    expect(failed(result)).toContain('dte_bounds');
  });

  it('rejects an expiry that is too far out (above maxDaysToExpiry)', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ daysToExpiry: 90 }) }),
    );
    expect(failed(result)).toContain('dte_bounds');
  });

  it('rejects an in-the-money call strike when OTM is required', () => {
    const result = runProposalPreChecks(
      optionProposal({ strike: 200 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingPrice: 210 }) }),
    );
    expect(failed(result)).toContain('strike_otm');
  });

  it('rejects an in-the-money put strike when OTM is required', () => {
    const result = runProposalPreChecks(
      optionProposal({ right: 'put', strike: 220 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingPrice: 210 }) }),
    );
    expect(failed(result)).toContain('strike_otm');
  });

  it('rejects a covered-call strike below the cost-basis floor', () => {
    const result = runProposalPreChecks(
      optionProposal({ strike: 220 }),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ underlyingCostBasis: 230, underlyingPrice: 210 }) }),
    );
    expect(failed(result)).toContain('strike_vs_cost_basis');
  });

  it('rejects a delta above the ceiling', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ delta: 0.5 }) }),
    );
    expect(failed(result)).toContain('delta_ceiling');
  });

  it('labels the delta_ceiling detail with its provenance (B52 slice 2c honest estimates)', () => {
    const computed = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ delta: 0.2, deltaSource: 'black_scholes_indicative' }) }),
    );
    expect(computed.checks.find((c) => c.limit === 'delta_ceiling')?.detail).toBe(
      '|delta| 0.2 (computed estimate) vs cap 0.35.',
    );

    const stubbed = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ delta: 0.2, deltaSource: 'stub' }) }),
    );
    expect(stubbed.checks.find((c) => c.limit === 'delta_ceiling')?.detail).toBe(
      '|delta| 0.2 (rough estimate, no live quote) vs cap 0.35.',
    );
  });

  it('omits the provenance tag when no delta source is attributed (backward-compatible)', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ delta: 0.2 }) }),
    );
    expect(result.checks.find((c) => c.limit === 'delta_ceiling')?.detail).toBe('|delta| 0.2 vs cap 0.35.');
  });

  it('rejects an option inside the earnings blackout window', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ daysToEarnings: 1 }) }),
    );
    expect(failed(result)).toContain('earnings_proximity');
  });

  it('does not block on an unknown earnings date (lenient, not a hard risk floor)', () => {
    const result = runProposalPreChecks(
      optionProposal(),
      context({ limits: OPTIONS_LIMITS, option: optionCtx({ daysToEarnings: null }) }),
    );
    expect(failed(result)).not.toContain('earnings_proximity');
  });

  it('fails closed across every configured bound when the option context is entirely missing', () => {
    const result = runProposalPreChecks(optionProposal(), context({ limits: OPTIONS_LIMITS, option: null }));
    expect(result.passed).toBe(false);
    expect(failed(result)).toEqual(
      expect.arrayContaining([
        'defined_risk_floor',
        'max_contracts_per_underlying',
        'short_call_coverage_pct',
        'dte_bounds',
        'strike_otm',
        'strike_vs_cost_basis',
        'delta_ceiling',
        'earnings_proximity',
      ]),
    );
  });

  it('passes every configurable option bound when nothing is capped, even with no option context', () => {
    const result = runProposalPreChecks(
      optionProposal({ positionIntent: 'buy_to_close' }, { side: 'buy' }),
      context({ limits: { ...DEFAULT_LIMITS, optionsEnabled: true }, option: null }),
    );
    expect(result.passed).toBe(true);
  });
});

// B52 slice 2b — the delta the option safeguards actually consume: computed from a real market mid via
// Black–Scholes, with the labeled moneyness stub as the no-quote fallback.
describe('computeOptionDelta', () => {
  const NOW = Date.parse('2026-01-01T00:00:00.000Z');
  const EXPIRATION = '2026-02-01'; // ~31 days out

  it('computes a Black–Scholes delta from a usable mid and tags it as a model estimate', () => {
    // OTM call (S=100, K=110) with a plausible premium — IV solves, delta ∈ (0, 0.5).
    const result = computeOptionDelta({
      right: 'call',
      underlyingPrice: 100,
      strike: 110,
      expiration: EXPIRATION,
      optionMidPrice: 1.0,
      now: NOW,
    });
    expect(result.greeks).not.toBeNull();
    expect(result.greeks!.source).toBe('black_scholes_indicative');
    expect(result.greeks!.impliedVol).toBeGreaterThan(0);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.delta).toBeLessThan(0.5); // OTM ⇒ below ATM's ~0.5
    // A short OTM put's computed delta is negative.
    const put = computeOptionDelta({
      right: 'put',
      underlyingPrice: 100,
      strike: 90,
      expiration: EXPIRATION,
      optionMidPrice: 1.0,
      now: NOW,
    });
    expect(put.greeks).not.toBeNull();
    expect(put.delta).toBeLessThan(0);
    expect(put.delta).toBeGreaterThan(-0.5);
  });

  it('falls back to the labeled moneyness stub when no mid is available', () => {
    const result = computeOptionDelta({
      right: 'call',
      underlyingPrice: 100,
      strike: 110,
      expiration: EXPIRATION,
      optionMidPrice: null,
      now: NOW,
    });
    expect(result.greeks).toBeNull(); // greeks null ⇒ this is the stub, not a model estimate
    expect(result.delta).toBe(stubbedOptionDelta('call', 110, 100));
  });

  it('falls back to the stub when IV cannot solve from a below-intrinsic mid', () => {
    // Deep-ITM call priced below intrinsic (S=100, K=50 ⇒ intrinsic ≈ 50) can't come from any σ.
    const result = computeOptionDelta({
      right: 'call',
      underlyingPrice: 100,
      strike: 50,
      expiration: EXPIRATION,
      optionMidPrice: 5,
      now: NOW,
    });
    expect(result.greeks).toBeNull();
    expect(result.delta).toBe(stubbedOptionDelta('call', 50, 100));
  });

  it('returns a null delta (and no greeks) when the underlying price is unknown', () => {
    const result = computeOptionDelta({
      right: 'call',
      underlyingPrice: null,
      strike: 110,
      expiration: EXPIRATION,
      optionMidPrice: 1.0,
      now: NOW,
    });
    expect(result.delta).toBeNull();
    expect(result.greeks).toBeNull();
  });
});

describe('deltaSourceOf / describeDeltaSource (B52 slice 2c)', () => {
  it('attributes a computed result to its greek source, a bare delta to the stub, and nothing to a null delta', () => {
    expect(
      deltaSourceOf({
        delta: 0.3,
        greeks: { delta: 0.3, gamma: 0, theta: 0, vega: 0, impliedVol: 0.4, source: 'black_scholes_indicative' },
      }),
    ).toBe('black_scholes_indicative');
    expect(deltaSourceOf({ delta: 0.3, greeks: null })).toBe('stub');
    expect(deltaSourceOf({ delta: null, greeks: null })).toBeNull();
  });

  it('renders an honest human label for each source (empty when nothing to attribute)', () => {
    expect(describeDeltaSource('black_scholes_indicative')).toBe('computed estimate');
    expect(describeDeltaSource('broker')).toBe('broker-supplied');
    expect(describeDeltaSource('stub')).toBe('rough estimate, no live quote');
    expect(describeDeltaSource(null)).toBe('');
    expect(describeDeltaSource(undefined)).toBe('');
  });
});
