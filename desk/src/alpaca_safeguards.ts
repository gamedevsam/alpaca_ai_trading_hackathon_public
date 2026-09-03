// Deterministic proposal-time safeguards (B26 slice 1c).
//
// THE PRINCIPLE (design §5): the LLM proposes; deterministic code disposes. Nothing here trusts the
// model — every ceiling is enforced in plain code, independent of what was proposed. A proposal that
// clears these checks becomes a `proposed` action awaiting human approval; one that fails any check is
// `discarded` with an alert, never silently clamped (design §4.4).
//
// This file is PURE (no I/O, no Date.now, no DB) so it is exhaustively unit-testable — the lifecycle
// service does the I/O (load account/positions/control, persist the action) and calls `runProposalPreChecks`.
//
// These same checks are re-run at EXECUTION time in a later slice (design §3 "re-check at execution"):
// approval is necessary but not sufficient, and conditions can change between propose and submit. Slice
// 1c stops at `proposed`, so this is the proposal-time half.

import { AlpacaAssetInfo, AlpacaOptionInstrument, AlpacaPositionInfo } from './alpaca.types';
import {
  ComputedOptionGreeks,
  FeedSuppliedGreeks,
  OptionGreeksSource,
  OptionRight,
  defaultOptionGreeksSource,
  yearsUntilExpiration,
} from './option_greeks';

// A single named ceiling and whether the proposal cleared it — persisted onto the action for audit
// ("why was this discarded / what did it clear"). Shape matches `alpaca_action.body.clearedLimits`.
export interface ClearedLimit {
  limit: string;
  passed: boolean;
  detail: string | null;
}

// The deterministic limits, sourced from the `alpaca_control` entity (owner-owned, not the LLM).
export interface AlpacaControlLimits {
  maxNotionalPerOrder: number | null;
  maxPositionPct: number | null;
  maxOrdersPerDay: number | null;
  maxDailyNotional: number | null;
  symbolAllowList: string[];
  symbolDenyList: string[];
  optionsEnabled: boolean;
  cooldownAfterFailureMs: number | null;
  // Options-specific ceilings (B47, design §13.5 — strategy-agnostic, sourced from the owner's control,
  // never the mandate). All null/false = no cap (matches the equity limits' "0/null = uncapped" convention).
  maxContractsPerOrder: number | null;
  maxContractsPerUnderlying: number | null;
  // Cap on the % of the underlying position committed to short calls, so upside isn't fully signed away.
  maxShortCallCoveredPct: number | null;
  minDaysToExpiry: number | null;
  maxDaysToExpiry: number | null;
  // Require the strike to be out-of-the-money (call: strike > underlying price; put: strike < price).
  requireOtm: boolean;
  // A covered call's strike must be >= cost basis * this pct/100 (protects against an assignment loss).
  minStrikeVsCostBasisPct: number | null;
  maxAbsDelta: number | null;
  earningsBlackoutDays: number | null;
}

// Facts about the option leg + its underlying that the deterministic checks need but the proposal
// itself doesn't carry. The real feed (chain/greeks/earnings calendar) is Phase B (B52) — until then
// callers pass a deterministic stub. Computed by the caller (not this pure file) same as
// `todayOrderCount`/`todayNotional` above.
export interface OptionProposalContext {
  underlyingSharesHeld: number;
  underlyingCostBasis: number | null;
  underlyingPrice: number | null;
  // Collateral already committed to OTHER open short legs — prevents the same collateral from covering
  // two proposals at once. Shares are per-underlying (only AAPL shares cover a short AAPL call); pledged
  // cash is ACCOUNT-WIDE, because the broker secures every cash-secured put out of one shared pool of
  // options buying power (H16 — counting it per-name cleared $180k of puts on a $100k account).
  sharesPledgedToOtherShortCalls: number;
  cashPledgedToOtherCsps: number;
  // Contracts already open on this underlying (any right/intent), for the per-underlying cap.
  existingContractsOnUnderlying: number;
  // Cash on hand (distinct from margin buying power) — what a cash-secured put actually reserves.
  cash: number;
  // The broker's own answer to how much is free for a cash-secured put right now (H18,
  // `AlpacaAccountInfo.optionsBuyingPower`) — the authority for `defined_risk_floor` on a short put.
  // `cash - cashPledgedToOtherCsps` stays in play as a within-cycle guard only: the broker snapshot is
  // fetched once per cycle, so it cannot see a sibling proposal this same cycle already pledged before
  // either reached the broker. The floor is whichever of the two is tighter.
  optionsBuyingPower: number;
  daysToExpiry: number;
  delta: number | null;
  // Provenance of `delta` (B52 slice 2c) so the owner-facing safeguard breakdown can label it honestly —
  // a Black–Scholes estimate off the free indicative quote must never read as a broker-authoritative
  // greek. Omitted/null when there is no delta to attribute. See `describeDeltaSource`.
  deltaSource?: OptionDeltaSource | null;
  daysToEarnings: number | null;
}

export type AlpacaKillState = 'armed' | 'disarmed' | 'killed';

// H4 — the global autonomy gate on `alpaca_control`. `per_action` (the default, and the only state a
// control written before H4 can be read as) means every proposal waits for a human decision inside its
// 30-minute TTL. `fully_autonomous` lets the trade cycle approve its own PAPER proposals; it never
// bypasses a safeguard — an auto-approval runs the identical guarded execute a human approval does.
export type AlpacaExecutionGate = 'per_action' | 'fully_autonomous';

// A normalized proposal (symbol upper-cased, exactly one of qty/notional per order validation).
export interface NormalizedProposal {
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  timeInForce: 'day' | 'gtc';
  // Present only for an option order (B47); null/omitted = equity, unchanged behavior. For an option,
  // `qty` counts contracts, not shares.
  instrument?: AlpacaOptionInstrument | null;
}

export interface ProposalCheckContext {
  killState: AlpacaKillState;
  limits: AlpacaControlLimits;
  buyingPower: number;
  equity: number;
  positions: AlpacaPositionInfo[];
  // Tradability lookup result for the proposed symbol (null = unknown/untradable per the broker).
  asset: AlpacaAssetInfo | null;
  // Already-counted same-day activity for the per-day rate ceilings (computed by the service from the DB).
  todayOrderCount: number;
  todayNotional: number;
  // Whether the order request passed the shared pre-broker `validateOrderRequest` (exactly one of
  // qty/notional, positive amounts, limit needs a price). The service runs that and passes the outcome
  // so this file stays free of the throwing validator and remains purely declarative.
  orderRequestValid: boolean;
  orderRequestError: string | null;
  // Required when `proposal.instrument` is set (B47); ignored for an equity proposal.
  option?: OptionProposalContext | null;
}

export interface ProposalPreCheckResult {
  checks: ClearedLimit[];
  passed: boolean;
  // Human-readable summary of the failed limits (empty when all passed) — stored as the action's errorMessage.
  failedSummary: string;
  // The dollar notional we could attribute to this order, or null when no quote is available yet
  // (an unheld market order — real market-data pricing lands in a later slice).
  estimatedNotional: number | null;
}

// When a quote isn't available we cannot evaluate a dollar ceiling. At PROPOSAL time we record this as
// passed-but-unevaluated rather than blocking (no money moves — slice 1c stops at `proposed`), and the
// execution-time re-check (with live pricing) is where these become hard, fail-closed gates.
const NO_QUOTE_DETAIL =
  'not evaluated — no quote for an unheld market order (real-price market-data lands in a later slice)';

export function estimateOrderNotional(proposal: NormalizedProposal, positions: AlpacaPositionInfo[]): number | null {
  if (proposal.notional != null) {
    return round2(proposal.notional);
  }
  if (proposal.qty == null) {
    return null;
  }
  // An option's price is quoted per share but traded per contract, so the dollars actually changing hands
  // are premium × contracts × multiplier (H0). Without this the per-order and daily notional ceilings
  // measured a $2.50 premium as $2.50 instead of $250 — 100× too lenient.
  const multiplier = proposal.instrument?.multiplier ?? 1;
  if (proposal.orderType === 'limit' && proposal.limitPrice != null) {
    return round2(proposal.qty * proposal.limitPrice * multiplier);
  }
  if (proposal.instrument) {
    // A market option order: the underlying's price says nothing about the contract's premium, so there
    // is no honest number to attribute here.
    return null;
  }
  const held = positions.find((p) => p.symbol === proposal.symbol);
  if (held && held.qty > 0) {
    // Price a market order off the current price implied by the held position's market value.
    return round2(proposal.qty * (held.marketValue / held.qty));
  }
  return null;
}

export function runProposalPreChecks(
  proposal: NormalizedProposal,
  context: ProposalCheckContext,
): ProposalPreCheckResult {
  const checks: ClearedLimit[] = [];
  const add = (limit: string, passed: boolean, detail: string | null) => checks.push({ limit, passed, detail });

  const estimatedNotional = estimateOrderNotional(proposal, context.positions);
  const held = context.positions.find((p) => p.symbol === proposal.symbol);

  // 1. Kill switch — a killed manager proposes nothing (design §4.1). armed/disarmed both allow a
  //    proposal (proposing never reaches the broker in this slice).
  add(
    'kill_switch',
    context.killState !== 'killed',
    context.killState === 'killed'
      ? 'Kill switch engaged (killed) — no actions may be proposed.'
      : `Kill switch is ${context.killState}.`,
  );

  // 2. Order request shape (exactly one of qty/notional, positive amounts, limit needs a price).
  add(
    'order_request',
    context.orderRequestValid,
    context.orderRequestValid ? 'Well-formed order request.' : (context.orderRequestError ?? 'Invalid order request.'),
  );

  // 3. Symbol tradability — reject unknown/untradable symbols (design §5).
  const tradable = context.asset != null && context.asset.tradable;
  add(
    'symbol_tradable',
    tradable,
    tradable ? `${proposal.symbol} is tradable.` : `${proposal.symbol} is not a known tradable asset.`,
  );

  // 4 & 5. Owner allow/deny lists (deterministic, independent of the model).
  const denied = context.limits.symbolDenyList.includes(proposal.symbol);
  add('symbol_not_denied', !denied, denied ? `${proposal.symbol} is on the deny-list.` : 'Not deny-listed.');

  const allowOk =
    context.limits.symbolAllowList.length === 0 || context.limits.symbolAllowList.includes(proposal.symbol);
  add(
    'symbol_allowed',
    allowOk,
    context.limits.symbolAllowList.length === 0
      ? 'No allow-list configured.'
      : allowOk
        ? `${proposal.symbol} is on the allow-list.`
        : `${proposal.symbol} is not on the allow-list.`,
  );

  // 6. Can't sell more than held (design §5 sanity-vs-reality). Only a qty sell is precisely checkable here.
  //
  // Equity only. An option proposal carries the UNDERLYING in `proposal.symbol` and the contract in
  // `proposal.instrument`, so this check was reading "sell 1 contract" as "sell 1 share of IWM" and
  // failing every opening short — a cash-secured put or covered call opens a position you by definition
  // do not hold yet, on a symbol whose share count is irrelevant to it. That rejected every proposal the
  // desk has ever made (`sufficient_holdings: Selling 1 of 0 held`, found running the H5 cycle against
  // the real chain). What actually bounds an option order is the option block below: `defined_risk_floor`
  // (no naked short — shares for a call, cash for a put), the contract-count caps, and DTE/OTM bounds.
  if (proposal.instrument) {
    add(
      'sufficient_holdings',
      true,
      'Option order — bounded by defined_risk_floor and the contract caps, not share count.',
    );
  } else if (proposal.side === 'sell' && proposal.qty != null) {
    const heldQty = held?.qty ?? 0;
    add('sufficient_holdings', proposal.qty <= heldQty, `Selling ${proposal.qty} of ${heldQty} held.`);
  } else {
    add('sufficient_holdings', true, 'Not a quantity sell — not applicable.');
  }

  // 7. Buying power for a buy.
  if (proposal.side === 'buy') {
    if (estimatedNotional != null) {
      add(
        'buying_power',
        estimatedNotional <= context.buyingPower,
        `Est. cost ${money(estimatedNotional)} vs buying power ${money(context.buyingPower)}.`,
      );
    } else {
      add('buying_power', true, NO_QUOTE_DETAIL);
    }
  } else {
    add('buying_power', true, 'Sell order — not applicable.');
  }

  // 8. Max notional per order.
  addCeiling(add, 'max_notional_per_order', context.limits.maxNotionalPerOrder, estimatedNotional, (value, limit) => ({
    passed: value <= limit,
    detail: `Order ${money(value)} vs cap ${money(limit)}.`,
  }));

  // 9. Max % of portfolio per position (buys grow a position; a sell only shrinks it).
  if (proposal.side === 'buy') {
    const limit = context.limits.maxPositionPct;
    if (limit != null && limit > 0 && estimatedNotional != null && context.equity > 0) {
      const postValue = (held?.marketValue ?? 0) + estimatedNotional;
      const pct = round2((postValue / context.equity) * 100);
      add('max_position_pct', pct <= limit, `Post-trade weight ${pct}% vs cap ${limit}%.`);
    } else if (limit == null || limit <= 0) {
      add('max_position_pct', true, 'No position-weight cap set.');
    } else {
      add('max_position_pct', true, NO_QUOTE_DETAIL);
    }
  } else {
    add('max_position_pct', true, 'Sell order — not applicable.');
  }

  // 10. Max orders per day (rate limiter / runaway breaker, design §5). todayOrderCount excludes this one.
  if (context.limits.maxOrdersPerDay != null && context.limits.maxOrdersPerDay > 0) {
    add(
      'max_orders_per_day',
      context.todayOrderCount < context.limits.maxOrdersPerDay,
      `${context.todayOrderCount} of ${context.limits.maxOrdersPerDay} orders used today.`,
    );
  } else {
    add('max_orders_per_day', true, 'No per-day order cap set.');
  }

  // 11. Max total daily traded notional.
  if (context.limits.maxDailyNotional != null && context.limits.maxDailyNotional > 0) {
    if (estimatedNotional != null) {
      const projected = round2(context.todayNotional + estimatedNotional);
      add(
        'max_daily_notional',
        projected <= context.limits.maxDailyNotional,
        `Projected ${money(projected)} vs daily cap ${money(context.limits.maxDailyNotional)}.`,
      );
    } else {
      add('max_daily_notional', true, NO_QUOTE_DETAIL);
    }
  } else {
    add('max_daily_notional', true, 'No daily-notional cap set.');
  }

  // 12+. Options-specific defined-risk safeguards (B47, design §13.5) — only evaluated for an option
  // proposal; an equity proposal (`instrument` null) is entirely unaffected by this block.
  if (proposal.instrument) {
    addOptionChecks(add, proposal.instrument, proposal.qty, context);
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    checks,
    passed: failed.length === 0,
    failedSummary: failed.map((c) => `${c.limit}: ${c.detail}`).join('; '),
    estimatedNotional,
  };
}

const MISSING_OPTION_CONTEXT_DETAIL =
  'Missing option evaluation context — failing closed (this check cannot be silently skipped).';

// Uniform rule across every bound below (except the defined-risk floor, which is unconditional): no
// cap/requirement configured => pass; a cap IS configured but we can't verify it => fail closed. Never
// silently pass a configured safety check just because the supporting data (Phase B greeks/chain, or the
// per-underlying book state) hasn't been wired yet (design §13.1 Layer B — "options cannot limp").
function addOptionChecks(
  add: (limit: string, passed: boolean, detail: string | null) => void,
  instrument: AlpacaOptionInstrument,
  contracts: number | null,
  context: ProposalCheckContext,
): void {
  const opt = context.option ?? null;
  const { right, positionIntent, strike, multiplier, underlying } = instrument;
  const isShortOpen = positionIntent === 'sell_to_open';

  // Options-enabled kill switch — independent of every other check.
  add(
    'options_enabled',
    context.limits.optionsEnabled,
    context.limits.optionsEnabled
      ? 'Options trading enabled.'
      : 'Options trading is disabled in Alpaca control limits.',
  );

  // The defined-risk floor (design §13.5, headline property): NO naked short calls/puts, ever, enforced
  // unconditionally (not gated by a configurable limit) — only an opening short leg carries this risk;
  // closing a position or opening long always reduces or defines risk by construction.
  if (isShortOpen && right === 'call') {
    if (!opt || contracts == null) {
      add('defined_risk_floor', false, MISSING_OPTION_CONTEXT_DETAIL);
    } else {
      const sharesNeeded = contracts * multiplier;
      const sharesAvailable = opt.underlyingSharesHeld - opt.sharesPledgedToOtherShortCalls;
      const covered = sharesAvailable >= sharesNeeded;
      add(
        'defined_risk_floor',
        covered,
        covered
          ? `Covered call: ${sharesNeeded} shares needed, ${sharesAvailable} available (of ${opt.underlyingSharesHeld} held, ${opt.sharesPledgedToOtherShortCalls} already pledged elsewhere).`
          : `NAKED CALL REJECTED: ${sharesNeeded} shares needed to cover, only ${sharesAvailable} available (of ${opt.underlyingSharesHeld} held, ${opt.sharesPledgedToOtherShortCalls} already pledged elsewhere).`,
      );
    }
  } else if (isShortOpen && right === 'put') {
    if (!opt || contracts == null) {
      add('defined_risk_floor', false, MISSING_OPTION_CONTEXT_DETAIL);
    } else {
      const cashNeeded = round2(strike * contracts * multiplier);
      // The broker's own figure is authoritative; the derived (cash - already-pledged) figure stays in
      // play only to catch a sibling proposal pledged THIS cycle, before either reached the broker (H18)
      // — whichever is tighter actually binds.
      const cashAvailableAtBroker = round2(opt.optionsBuyingPower);
      const cashAvailableThisCycle = round2(opt.cash - opt.cashPledgedToOtherCsps);
      const cashAvailable = Math.min(cashAvailableAtBroker, cashAvailableThisCycle);
      const secured = cashAvailable >= cashNeeded;
      add(
        'defined_risk_floor',
        secured,
        secured
          ? `Cash-secured put: ${money(cashNeeded)} reserved, ${money(cashAvailable)} available (broker options buying power ${money(cashAvailableAtBroker)}, ${money(cashAvailableThisCycle)} after this cycle's own pledges of ${money(opt.cashPledgedToOtherCsps)}).`
          : `NAKED PUT REJECTED: ${money(cashNeeded)} needed to secure, only ${money(cashAvailable)} available (broker options buying power ${money(cashAvailableAtBroker)}, ${money(cashAvailableThisCycle)} after this cycle's own pledges of ${money(opt.cashPledgedToOtherCsps)}).`,
      );
    }
  } else {
    add('defined_risk_floor', true, `${positionIntent} — not an opening short position; defined-risk by construction.`);
  }

  // Contract-count caps.
  addOptionCeiling(add, 'max_contracts_per_order', context.limits.maxContractsPerOrder, contracts, (value, limit) => ({
    passed: value <= limit,
    detail: `${value} contracts vs cap ${limit}.`,
  }));

  const isOpening = positionIntent === 'sell_to_open' || positionIntent === 'buy_to_open';
  if (isOpening) {
    const projected = opt && contracts != null ? opt.existingContractsOnUnderlying + contracts : null;
    addOptionCeiling(
      add,
      'max_contracts_per_underlying',
      context.limits.maxContractsPerUnderlying,
      projected,
      (value, limit) => ({
        passed: value <= limit,
        detail: `${value} contracts open on ${underlying} (incl. this order) vs cap ${limit}.`,
      }),
    );
  } else {
    add('max_contracts_per_underlying', true, 'Closing order — reduces exposure, not applicable.');
  }

  // Max % of the underlying holding committed to short calls, so upside isn't fully signed away.
  if (isShortOpen && right === 'call') {
    const limit = context.limits.maxShortCallCoveredPct;
    if (limit == null || limit <= 0) {
      add('short_call_coverage_pct', true, 'No short-call coverage cap set.');
    } else if (!opt || contracts == null) {
      add('short_call_coverage_pct', false, MISSING_OPTION_CONTEXT_DETAIL);
    } else if (opt.underlyingSharesHeld <= 0) {
      add('short_call_coverage_pct', false, 'No underlying shares held — cannot compute coverage percentage.');
    } else {
      const committedShares = opt.sharesPledgedToOtherShortCalls + contracts * multiplier;
      const pct = round2((committedShares / opt.underlyingSharesHeld) * 100);
      add(
        'short_call_coverage_pct',
        pct <= limit,
        `${pct}% of the ${opt.underlyingSharesHeld}-share holding committed to short calls (incl. this order) vs cap ${limit}%.`,
      );
    }
  } else {
    add('short_call_coverage_pct', true, 'Not a covered-call open — not applicable.');
  }

  // Days-to-expiry bounds.
  if (context.limits.minDaysToExpiry == null && context.limits.maxDaysToExpiry == null) {
    add('dte_bounds', true, 'No DTE bounds set.');
  } else if (!opt) {
    add('dte_bounds', false, MISSING_OPTION_CONTEXT_DETAIL);
  } else {
    const dte = opt.daysToExpiry;
    const tooSoon = context.limits.minDaysToExpiry != null && dte < context.limits.minDaysToExpiry;
    const tooFar = context.limits.maxDaysToExpiry != null && dte > context.limits.maxDaysToExpiry;
    add(
      'dte_bounds',
      !tooSoon && !tooFar,
      `${dte} days to expiry (bounds: ${context.limits.minDaysToExpiry ?? '—'}–${context.limits.maxDaysToExpiry ?? '—'}).`,
    );
  }

  // Strike must be OTM.
  if (!context.limits.requireOtm) {
    add('strike_otm', true, 'OTM requirement not enabled.');
  } else if (!opt || opt.underlyingPrice == null) {
    add('strike_otm', false, MISSING_OPTION_CONTEXT_DETAIL);
  } else {
    const otm = right === 'call' ? strike > opt.underlyingPrice : strike < opt.underlyingPrice;
    add('strike_otm', otm, `Strike ${strike} ${otm ? 'is' : 'is NOT'} OTM vs underlying price ${opt.underlyingPrice}.`);
  }

  // A covered call's strike must sit at/above a floor relative to cost basis (protects against an
  // assignment realizing a loss).
  if (isShortOpen && right === 'call') {
    const limit = context.limits.minStrikeVsCostBasisPct;
    if (limit == null || limit <= 0) {
      add('strike_vs_cost_basis', true, 'No strike-vs-cost-basis floor set.');
    } else if (!opt || opt.underlyingCostBasis == null) {
      add('strike_vs_cost_basis', false, MISSING_OPTION_CONTEXT_DETAIL);
    } else {
      const floor = round2(opt.underlyingCostBasis * (limit / 100));
      const ok = strike >= floor;
      add(
        'strike_vs_cost_basis',
        ok,
        ok
          ? `Strike ${strike} >= floor ${floor} (${limit}% of cost basis ${opt.underlyingCostBasis}).`
          : `Strike ${strike} below floor ${floor} (${limit}% of cost basis ${opt.underlyingCostBasis}) — assignment could realize a loss.`,
      );
    }
  } else {
    add('strike_vs_cost_basis', true, 'Not a covered-call open — not applicable.');
  }

  // Delta ceiling (Phase B / B52 supplies the real greek; stubbed until then).
  {
    const limit = context.limits.maxAbsDelta;
    if (limit == null || limit <= 0) {
      add('delta_ceiling', true, 'No delta ceiling set.');
    } else if (!opt || opt.delta == null) {
      add('delta_ceiling', false, MISSING_OPTION_CONTEXT_DETAIL);
    } else {
      const abs = Math.abs(opt.delta);
      const label = describeDeltaSource(opt.deltaSource);
      const suffix = label ? ` (${label})` : '';
      add('delta_ceiling', abs <= limit, `|delta| ${abs}${suffix} vs cap ${limit}.`);
    }
  }

  // Earnings-proximity blackout (Phase B / B52 supplies the real earnings calendar; stubbed until then).
  {
    const blackout = context.limits.earningsBlackoutDays;
    if (blackout == null || blackout <= 0) {
      add('earnings_proximity', true, 'No earnings blackout window set.');
    } else if (!opt) {
      add('earnings_proximity', false, MISSING_OPTION_CONTEXT_DETAIL);
    } else if (opt.daysToEarnings == null) {
      add('earnings_proximity', true, 'No earnings date known — not evaluated.');
    } else {
      const clear = opt.daysToEarnings > blackout;
      add(
        'earnings_proximity',
        clear,
        clear
          ? `${opt.daysToEarnings} days to earnings, clear of the ${blackout}-day blackout.`
          : `${opt.daysToEarnings} days to earnings — inside the ${blackout}-day blackout window.`,
      );
    }
  }
}

function addCeiling(
  add: (limit: string, passed: boolean, detail: string | null) => void,
  name: string,
  limit: number | null,
  value: number | null,
  evaluate: (value: number, limit: number) => { passed: boolean; detail: string },
): void {
  if (limit == null || limit <= 0) {
    add(name, true, 'No cap set.');
    return;
  }
  if (value == null) {
    add(name, true, NO_QUOTE_DETAIL);
    return;
  }
  const { passed, detail } = evaluate(value, limit);
  add(name, passed, detail);
}

// Same shape as `addCeiling` but fails closed when a cap is configured and unverifiable (missing option
// context), rather than passing-unevaluated — options don't get the equity NO_QUOTE_DETAIL leniency
// (design §13.1: "options cannot limp without live pricing/context").
function addOptionCeiling(
  add: (limit: string, passed: boolean, detail: string | null) => void,
  name: string,
  limit: number | null,
  value: number | null,
  evaluate: (value: number, limit: number) => { passed: boolean; detail: string },
): void {
  if (limit == null || limit <= 0) {
    add(name, true, 'No cap set.');
    return;
  }
  if (value == null) {
    add(name, false, MISSING_OPTION_CONTEXT_DETAIL);
    return;
  }
  const { passed, detail } = evaluate(value, limit);
  add(name, passed, detail);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number): string {
  return `$${round2(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Whole days from now to an expiration date (YYYY-MM-DD) — shared by the lifecycle service (proposal
// context) and the mandate dry-run (candidate generation), so both use one definition of "days to expiry".
export function daysUntilExpiration(expirationDate: string): number {
  const expiresAt = Date.parse(`${expirationDate}T00:00:00.000Z`);
  return Math.round((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
}

// A deterministic, rough moneyness-based stand-in for a real delta — the LABELED LAST-RESORT fallback for
// `computeOptionDelta` when no usable market quote is available to solve implied vol from. Not a pricing
// model; ATM ≈ ±0.5, clamped away from ±1/0. B52 slice 2b made the computed Black–Scholes delta the
// primary path (see `computeOptionDelta`); this remains only as the no-quote fallback.
export function stubbedOptionDelta(right: OptionRight, strike: number, underlyingPrice: number | null): number | null {
  if (underlyingPrice == null || underlyingPrice <= 0) {
    return null;
  }
  const moneyness = (underlyingPrice - strike) / underlyingPrice; // positive = ITM for a call
  if (right === 'call') {
    return round2(Math.min(0.98, Math.max(0.02, 0.5 + moneyness * 2)));
  }
  return round2(Math.min(-0.02, Math.max(-0.98, -0.5 + moneyness * 2)));
}

// The delta the option safeguards actually consume (B52 slice 2b). Primary path: solve implied vol from
// the contract's market MID via the swappable `OptionGreeksSource` (free-feed Black–Scholes today, OPRA
// broker greeks later) and return that delta. Fallback: when no usable quote/IV is available, the labeled
// moneyness `stubbedOptionDelta`. `greeks` is non-null only when the value came from the model — so
// callers (and slice 2c's honest-estimates labeling) can distinguish a computed estimate from the stub.
// Kept pure (no `Date.now`): the caller supplies `now` (real time in services, the sim clock in tests).
export interface OptionDeltaResult {
  delta: number | null;
  greeks: ComputedOptionGreeks | null;
}

// Where a consumed delta came from — the model/broker greek sources plus the labeled `stubbedOptionDelta`
// no-quote fallback. `deltaSourceOf` derives it from a `computeOptionDelta` result: greeks present → their
// source; a non-null delta with no greeks → the stub; no delta → null (nothing to attribute).
export type OptionDeltaSource = ComputedOptionGreeks['source'] | 'stub';

export function deltaSourceOf({ delta, greeks }: OptionDeltaResult): OptionDeltaSource | null {
  if (greeks) {
    return greeks.source;
  }
  return delta == null ? null : 'stub';
}

// Short honest label for a delta's provenance, shown inline in the owner-facing safeguard breakdown
// (B52 slice 2c). Empty string when there's nothing to attribute (keeps the detail clean).
export function describeDeltaSource(source: OptionDeltaSource | null | undefined): string {
  switch (source) {
    case 'feed_indicative':
      return 'feed-supplied';
    case 'black_scholes_indicative':
      return 'computed estimate';
    case 'broker':
      return 'broker-supplied';
    case 'stub':
      return 'rough estimate, no live quote';
    default:
      return '';
  }
}

export function computeOptionDelta(
  params: {
    right: OptionRight;
    underlyingPrice: number | null;
    strike: number;
    expiration: string; // YYYY-MM-DD
    optionMidPrice: number | null;
    // Greeks the data feed already reported for this contract, when it reported any (H0). Preferred over
    // solving them ourselves; each source labels itself, so nothing is silently swapped.
    feedGreeks?: FeedSuppliedGreeks | null;
    now: number;
  },
  source: OptionGreeksSource = defaultOptionGreeksSource,
): OptionDeltaResult {
  const { right, underlyingPrice, strike, expiration, optionMidPrice, feedGreeks, now } = params;
  // Each source decides for itself whether its inputs are usable (the Black–Scholes one returns null for a
  // missing price/mid, the feed one only needs the feed's own numbers), so no guard here.
  const greeks = source.compute({
    right,
    underlyingPrice: underlyingPrice ?? 0,
    strike,
    yearsToExpiry: yearsUntilExpiration(expiration, now),
    optionMidPrice: optionMidPrice ?? 0,
    feedGreeks,
  });
  if (greeks) {
    return { delta: greeks.delta, greeks };
  }
  return { delta: stubbedOptionDelta(right, strike, underlyingPrice), greeks: null };
}
