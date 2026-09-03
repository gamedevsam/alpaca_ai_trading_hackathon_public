// Deterministic, seeded, no-network Alpaca client (B26 slice 1b).
//
// Stands in for the real broker so the whole Alpaca pipeline — read account/positions, propose an
// action, stage an order — is fully exercisable today, before the owner's paper key lands. Every
// value is derived deterministically from the seed so the UI, the lifecycle service, and unit tests
// all see stable, reproducible data (no Date.now / Math.random leakage). Tomorrow's real paper key
// swaps this out at the factory with zero other code changes.

import {
  AlpacaAccountInfo,
  AlpacaAssetInfo,
  AlpacaClient,
  AlpacaClockInfo,
  AlpacaDuplicateOrderError,
  AlpacaEnvironment,
  AlpacaLatestTrade,
  AlpacaOptionChainQuery,
  AlpacaOptionExpirationOutcome,
  AlpacaOptionInstrument,
  AlpacaOptionQuote,
  AlpacaOptionRight,
  AlpacaOrderRequest,
  AlpacaOrderResult,
  AlpacaOrderValidationError,
  AlpacaPositionInfo,
  buildOccSymbol,
  optionQuoteMid,
  parseOccSymbol,
} from './alpaca.types';
import { computeOptionDelta } from './alpaca_safeguards';

// A deterministic option-chain shape for the simulator: strikes stepped $5 apart across roughly ±25% of
// the underlying. Expirations are weekly Fridays, so a caller that asks for an expiration WINDOW (H0's
// candidate generation, discovering which expiries are listed) gets a plausible set back instead of one
// arbitrary date. Real chain geometry doesn't matter here — this is just enough of a plausible chain for
// the greeks/candidate wiring and its tests to exercise end-to-end.
const SIM_STRIKE_STEP = 5;
const SIM_CHAIN_BAND = 0.25;
const SIM_DEFAULT_DTE = 30;
const SIM_MAX_CHAIN_EXPIRATIONS = 6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A fixed, well-known set of seed positions for the simulated account. Deterministic — never random.
const SEED_POSITIONS: Array<{ symbol: string; qty: number; avgEntryPrice: number }> = [
  { symbol: 'AAPL', qty: 50, avgEntryPrice: 168.0 },
  { symbol: 'MSFT', qty: 20, avgEntryPrice: 392.5 },
  { symbol: 'NVDA', qty: 30, avgEntryPrice: 110.25 },
];

const SEED_CASH = 100_000;
// A small allow-list of "tradable" symbols for the simulator (seed holdings + a few common names).
const SEED_TRADABLE_SYMBOLS = new Set(['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'SPY', 'VTI']);

// Deterministic anchor timestamp for the simulated environment so snapshots/orders are reproducible.
const SIM_NOW_ISO = '2026-06-26T15:30:00.000Z';

export interface SimulatedAlpacaClientOptions {
  environment?: AlpacaEnvironment;
  // Override the simulated market clock (default: open). Kept explicit so tests stay deterministic.
  marketOpen?: boolean;
  nowIso?: string;
  // Resume from a previously reconciled state (the persisted `alpaca_account_snapshot`) instead of the
  // fixed seed, so a fresh instance carries forward the effect of prior fills (B45). Cost basis only —
  // marketValue/unrealizedPl are always recomputed from the deterministic price.
  initialPositions?: Array<{ symbol: string; qty: number; avgEntryPrice: number }>;
  initialCash?: number;
  // Same idea as `initialPositions`, for open option legs (B50) — resumed from the snapshot's
  // option-flavored position rows (the ones carrying `instrument`) so a filled option order and a later
  // expiration/assignment pass both see the same open contracts across a fresh instance.
  initialOptionPositions?: Array<{ instrument: AlpacaOptionInstrument; qty: number; avgEntryPrice: number }>;
}

// Stable per-symbol "current price": a deterministic function of the symbol (no randomness) so the
// same symbol always prices the same across instances and runs.
export function simulatedPriceFor(symbol: string): number {
  let hash = 0;
  for (const char of symbol.toUpperCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  // Map into a plausible $20–$520 band, rounded to cents — purely deterministic.
  const price = 20 + (hash % 50_000) / 100;
  return Math.round(price * 100) / 100;
}

// Stable per-contract "current mark" (premium per share): same deterministic-hash approach as
// `simulatedPriceFor`, but mapped into a plausible options-premium band ($0.10–$15.00) rather than an
// equity-price band (B50). Real chain/greeks data lands in Phase B (B52); until then this is just enough
// of a plausible mark to exercise fills, uPnL, and reconciliation end-to-end.
export function simulatedOptionMarkFor(occSymbol: string): number {
  let hash = 0;
  for (const char of occSymbol.toUpperCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const mark = 0.1 + (hash % 1_490) / 100;
  return Math.round(mark * 100) / 100;
}

export class SimulatedAlpacaClient implements AlpacaClient {
  readonly environment: AlpacaEnvironment;
  readonly kind = 'simulated' as const;

  private readonly marketOpen: boolean;
  private readonly nowIso: string;
  // In-memory staged orders, keyed by clientOrderId (the idempotency key).
  private readonly orders = new Map<string, AlpacaOrderResult>();
  // Mutable ledger (cost basis only) — starts from the seed or a resumed snapshot; `submitOrder`
  // applies fills here so `getAccount`/`getPositions` reflect a trade within this instance's lifetime.
  private readonly positions: Map<string, { qty: number; avgEntryPrice: number }>;
  // Open option legs, keyed by OCC contract symbol (B50) — `qty` is signed contracts (negative = short).
  private readonly optionPositions: Map<
    string,
    { instrument: AlpacaOptionInstrument; qty: number; avgEntryPrice: number }
  >;
  private cash: number;

  constructor(options: SimulatedAlpacaClientOptions = {}) {
    this.environment = options.environment ?? 'paper';
    this.marketOpen = options.marketOpen ?? true;
    this.nowIso = options.nowIso ?? SIM_NOW_ISO;
    this.positions = new Map(
      (options.initialPositions ?? SEED_POSITIONS).map((p) => [
        p.symbol,
        { qty: p.qty, avgEntryPrice: p.avgEntryPrice },
      ]),
    );
    this.optionPositions = new Map(
      (options.initialOptionPositions ?? []).map((p) => [
        p.instrument.occSymbol,
        { instrument: p.instrument, qty: p.qty, avgEntryPrice: p.avgEntryPrice },
      ]),
    );
    this.cash = options.initialCash ?? SEED_CASH;
  }

  async getAccount(): Promise<AlpacaAccountInfo> {
    const equityValue = [...this.positions.entries()].reduce(
      (sum, [symbol, p]) => sum + p.qty * simulatedPriceFor(symbol),
      0,
    );
    const optionValue = [...this.optionPositions.values()].reduce(
      (sum, p) => sum + p.qty * p.instrument.multiplier * simulatedOptionMarkFor(p.instrument.occSymbol),
      0,
    );
    const equity = this.cash + equityValue + optionValue;
    return {
      cash: round2(this.cash),
      // Paper accounts margin at ~2x; simulate a simple 2x buying power off cash.
      buyingPower: round2(this.cash * 2),
      equity: round2(equity),
      portfolioValue: round2(equity),
      currency: 'USD',
      // A cash-secured put draws on cash, not margin (H18) — the simulated client has no separate
      // options pool, so cash on hand is the honest stand-in.
      optionsBuyingPower: round2(this.cash),
    };
  }

  async getPositions(): Promise<AlpacaPositionInfo[]> {
    const equityPositions: AlpacaPositionInfo[] = [...this.positions.entries()]
      .filter(([, p]) => p.qty !== 0)
      .map(([symbol, p]) => {
        const price = simulatedPriceFor(symbol);
        const marketValue = round2(p.qty * price);
        return {
          symbol,
          qty: p.qty,
          side: 'long' as const,
          avgEntryPrice: round2(p.avgEntryPrice),
          marketValue,
          unrealizedPl: round2(marketValue - p.qty * p.avgEntryPrice),
        };
      });

    const optionPositions: AlpacaPositionInfo[] = [...this.optionPositions.values()]
      .filter((p) => p.qty !== 0)
      .map((p) => {
        const mark = simulatedOptionMarkFor(p.instrument.occSymbol);
        const marketValue = round2(p.qty * p.instrument.multiplier * mark);
        const underlyingPrice = simulatedPriceFor(p.instrument.underlying);
        // Delta from the same simulated mark the fills/positions use (mid ≈ mark) via the swappable
        // greeks source — real chains do this off the indicative feed (B52 slice 2b). Deterministic:
        // solve against the sim clock, not wall-clock. Falls back to the labeled stub if IV won't solve.
        const { delta } = computeOptionDelta({
          right: p.instrument.right,
          underlyingPrice,
          strike: p.instrument.strike,
          expiration: p.instrument.expiration,
          optionMidPrice: mark,
          now: Date.parse(this.nowIso),
        });
        return {
          symbol: p.instrument.occSymbol,
          qty: p.qty,
          side: p.qty < 0 ? ('short' as const) : ('long' as const),
          avgEntryPrice: round2(p.avgEntryPrice),
          marketValue,
          unrealizedPl: round2(p.qty * p.instrument.multiplier * (mark - p.avgEntryPrice)),
          instrument: p.instrument,
          daysToExpiry: daysUntilExpirationFrom(p.instrument.expiration, this.nowIso),
          delta,
        };
      });

    return [...equityPositions, ...optionPositions];
  }

  async getClock(): Promise<AlpacaClockInfo> {
    return {
      isOpen: this.marketOpen,
      nextOpen: this.marketOpen ? null : '2026-06-29T13:30:00.000Z',
      nextClose: this.marketOpen ? '2026-06-26T20:00:00.000Z' : null,
    };
  }

  async getAsset(symbol: string): Promise<AlpacaAssetInfo | null> {
    const upper = symbol.toUpperCase();
    if (!SEED_TRADABLE_SYMBOLS.has(upper)) {
      return null;
    }
    return { symbol: upper, tradable: true, fractionable: true };
  }

  async getOptionChain(underlying: string, query: AlpacaOptionChainQuery = {}): Promise<AlpacaOptionQuote[]> {
    const symbol = underlying.toUpperCase();
    const base = simulatedPriceFor(symbol);
    const rights: AlpacaOptionRight[] = query.right ? [query.right] : ['call', 'put'];

    const lo = Math.max(SIM_STRIKE_STEP, Math.floor((base * (1 - SIM_CHAIN_BAND)) / SIM_STRIKE_STEP) * SIM_STRIKE_STEP);
    const hi = Math.ceil((base * (1 + SIM_CHAIN_BAND)) / SIM_STRIKE_STEP) * SIM_STRIKE_STEP;

    const quotes: AlpacaOptionQuote[] = [];
    for (const expiration of this.chainExpirations(query)) {
      for (let strike = lo; strike <= hi; strike += SIM_STRIKE_STEP) {
        if (query.strikeGte != null && strike < query.strikeGte) {
          continue;
        }
        if (query.strikeLte != null && strike > query.strikeLte) {
          continue;
        }
        for (const right of rights) {
          quotes.push(this.simulatedQuoteFor(buildOccSymbol(symbol, expiration, right, strike)));
        }
      }
    }
    return query.limit != null ? quotes.slice(0, query.limit) : quotes;
  }

  // The simulator has no market data feed, so the "last print" is the same deterministic per-symbol price
  // every other simulated value is derived from — real enough to exercise the candidate pipeline, and
  // never mistaken for a real quote (the client's `kind` is `simulated` everywhere it surfaces).
  async getLatestTrade(symbol: string): Promise<AlpacaLatestTrade | null> {
    const upper = symbol.toUpperCase();
    if (!SEED_TRADABLE_SYMBOLS.has(upper)) {
      return null; // Unknown to the simulator — same "no price" answer the real feed gives.
    }
    return { symbol: upper, price: simulatedPriceFor(upper), asOf: this.nowIso };
  }

  async getOptionQuote(occSymbol: string): Promise<AlpacaOptionQuote | null> {
    if (!parseOccSymbol(occSymbol)) {
      return null;
    }
    return this.simulatedQuoteFor(occSymbol);
  }

  // Build a deterministic quote for one OCC contract from the same `simulatedOptionMarkFor` mark used by
  // fills/positions, wrapped in a tight synthetic bid/ask so the mid matches the mark exactly. Caller
  // guarantees `occSymbol` parses.
  private simulatedQuoteFor(occSymbol: string): AlpacaOptionQuote {
    const parsed = parseOccSymbol(occSymbol);
    if (!parsed) {
      throw new Error(`simulatedQuoteFor called with unparseable OCC symbol '${occSymbol}'`);
    }
    const mark = simulatedOptionMarkFor(occSymbol);
    const bid = round2(mark * 0.98);
    const ask = round2(mark * 1.02);
    return {
      occSymbol: occSymbol.toUpperCase(),
      underlying: parsed.underlying,
      expiration: parsed.expiration,
      strike: parsed.strike,
      right: parsed.right,
      bid,
      ask,
      mid: optionQuoteMid(bid, ask),
      asOf: this.nowIso,
    };
  }

  // Which expirations the simulated chain lists for a query: an exact date if pinned, else the weekly
  // Fridays inside the requested window (defaulting to "up to ~30 days out"). Always returns at least one
  // date, so a window that happens to contain no Friday still yields a usable chain.
  private chainExpirations(query: AlpacaOptionChainQuery): string[] {
    if (query.expiration) {
      return [query.expiration];
    }
    const now = Date.parse(this.nowIso);
    const from = query.expirationGte ? Date.parse(`${query.expirationGte}T00:00:00.000Z`) : now;
    const to = query.expirationLte
      ? Date.parse(`${query.expirationLte}T00:00:00.000Z`)
      : now + SIM_DEFAULT_DTE * MS_PER_DAY;
    const fridays: string[] = [];
    for (let at = from; at <= to && fridays.length < SIM_MAX_CHAIN_EXPIRATIONS; at += MS_PER_DAY) {
      if (new Date(at).getUTCDay() === 5) {
        fridays.push(new Date(at).toISOString().slice(0, 10));
      }
    }
    return fridays.length > 0 ? fridays : [new Date(Math.max(from, to)).toISOString().slice(0, 10)];
  }

  async submitOrder(order: AlpacaOrderRequest): Promise<AlpacaOrderResult> {
    validateOrderRequest(order);
    if (this.orders.has(order.clientOrderId)) {
      // Idempotency guarantee fires — mirrors Alpaca rejecting a duplicate client_order_id.
      throw new AlpacaDuplicateOrderError(order.clientOrderId);
    }

    const result = order.instrument ? this.fillOptionOrder(order, order.instrument) : this.fillEquityOrder(order);
    this.orders.set(order.clientOrderId, result);
    return result;
  }

  private fillEquityOrder(order: AlpacaOrderRequest): AlpacaOrderResult {
    const symbol = order.symbol.toUpperCase();
    const price = simulatedPriceFor(symbol);
    // Derive a share qty for a notional order so fills are concrete and deterministic.
    const qty = order.qty ?? (order.notional != null ? round4(order.notional / price) : null);

    // Market orders fill immediately at the deterministic price; limit orders rest as 'accepted'
    // (and only "fill" if marketable), so the simulated lifecycle can exercise both paths.
    const marketable =
      order.type === 'market' ||
      (order.limitPrice != null &&
        ((order.side === 'buy' && order.limitPrice >= price) || (order.side === 'sell' && order.limitPrice <= price)));

    if (marketable && qty != null) {
      this.applyFill(symbol, order.side, qty, price);
    }

    return {
      id: `sim-${order.clientOrderId}`,
      clientOrderId: order.clientOrderId,
      symbol,
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      qty,
      notional: order.notional ?? null,
      limitPrice: order.limitPrice ?? null,
      status: marketable ? 'filled' : 'accepted',
      filledQty: marketable ? (qty ?? 0) : 0,
      filledAvgPrice: marketable ? price : null,
      submittedAt: this.nowIso,
    };
  }

  // An option order's ledger key is the OCC contract symbol, not the underlying — `qty` counts contracts
  // (multiplier applied separately), and the deterministic mark stands in for a real premium (B52 wires
  // the real chain). Otherwise mirrors the equity path (market fills immediately, limit rests unless
  // marketable).
  private fillOptionOrder(order: AlpacaOrderRequest, instrument: AlpacaOptionInstrument): AlpacaOrderResult {
    const mark = simulatedOptionMarkFor(instrument.occSymbol);
    const qty = order.qty ?? 0;
    const marketable =
      order.type === 'market' ||
      (order.limitPrice != null &&
        ((order.side === 'buy' && order.limitPrice >= mark) || (order.side === 'sell' && order.limitPrice <= mark)));

    if (marketable && qty > 0) {
      this.applyOptionFill(instrument, qty, mark);
    }

    return {
      id: `sim-${order.clientOrderId}`,
      clientOrderId: order.clientOrderId,
      symbol: instrument.occSymbol,
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      qty,
      notional: null,
      limitPrice: order.limitPrice ?? null,
      status: marketable ? 'filled' : 'accepted',
      filledQty: marketable ? qty : 0,
      filledAvgPrice: marketable ? mark : null,
      submittedAt: this.nowIso,
      instrument,
    };
  }

  // Apply a fill to the mutable ledger: weighted-average cost basis on a buy, cash moves the other way.
  // A sell's cost basis is left unchanged (realized P&L isn't tracked — this is a simulation, not a ledger).
  private applyFill(symbol: string, side: 'buy' | 'sell', qty: number, price: number): void {
    const existing = this.positions.get(symbol) ?? { qty: 0, avgEntryPrice: price };
    const signedQty = side === 'buy' ? qty : -qty;
    const newQty = round4(existing.qty + signedQty);
    const newAvgEntryPrice =
      side === 'buy' && newQty !== 0
        ? round2((existing.qty * existing.avgEntryPrice + qty * price) / newQty)
        : existing.avgEntryPrice;
    this.positions.set(symbol, { qty: newQty, avgEntryPrice: newAvgEntryPrice });
    this.cash = round2(this.cash + (side === 'buy' ? -qty * price : qty * price));
  }

  // Same weighted-average-cost-basis shape as `applyFill`, signed by positionIntent (opening a short
  // moves qty negative) and scaled by the contract multiplier for the cash leg.
  private applyOptionFill(instrument: AlpacaOptionInstrument, contracts: number, premium: number): void {
    const key = instrument.occSymbol;
    const existing = this.optionPositions.get(key) ?? { instrument, qty: 0, avgEntryPrice: premium };
    const opening = instrument.positionIntent === 'buy_to_open' || instrument.positionIntent === 'sell_to_open';
    const buys = instrument.positionIntent === 'buy_to_open' || instrument.positionIntent === 'buy_to_close';
    const signedQty = buys ? contracts : -contracts;
    const newQty = round4(existing.qty + signedQty);
    const newAvgEntryPrice =
      opening && newQty !== 0
        ? round2((Math.abs(existing.qty) * existing.avgEntryPrice + contracts * premium) / Math.abs(newQty))
        : existing.avgEntryPrice;

    if (newQty === 0) {
      this.optionPositions.delete(key);
    } else {
      this.optionPositions.set(key, { instrument, qty: newQty, avgEntryPrice: newAvgEntryPrice });
    }
    // Selling (to open or to close) is a credit; buying is a debit — same buy/sell cash convention as
    // the equity ledger, scaled by the contract multiplier.
    const cashDelta = buys ? -contracts * instrument.multiplier * premium : contracts * instrument.multiplier * premium;
    this.cash = round2(this.cash + cashDelta);
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrderResult | null> {
    return this.orders.get(clientOrderId) ?? null;
  }

  async listOrders(): Promise<AlpacaOrderResult[]> {
    // Stable order: submission order is preserved by Map iteration.
    return [...this.orders.values()];
  }

  /**
   * Settle every open option position whose contract has reached expiration (B50, Layer D). Derives an
   * assigned/expired-worthless outcome per position, mutating the mutable ledger (shares called away or
   * put to us, cash moving at the strike) exactly as a real broker's own end-of-day settlement would, and
   * returns the derived outcomes so the caller (the trade-cycle service) can reflect each one onto its
   * originating `alpaca_action`. Uses this client's own deterministic `nowIso`, never wall-clock time.
   */
  async processExpirations(): Promise<AlpacaOptionExpirationOutcome[]> {
    const outcomes: AlpacaOptionExpirationOutcome[] = [];
    for (const [occSymbol, position] of [...this.optionPositions.entries()]) {
      const { instrument } = position;
      if (daysUntilExpirationFrom(instrument.expiration, this.nowIso) > 0) {
        continue; // Not yet expired.
      }

      const contracts = Math.abs(position.qty);
      const isShort = position.qty < 0;
      const underlyingPrice = simulatedPriceFor(instrument.underlying);
      const inTheMoney =
        instrument.right === 'call' ? underlyingPrice > instrument.strike : underlyingPrice < instrument.strike;

      if (isShort && inTheMoney) {
        const shares = contracts * instrument.multiplier;
        if (instrument.right === 'call') {
          // Assigned: shares called away at the strike.
          this.adjustEquityPosition(instrument.underlying, -shares, instrument.strike);
          this.cash = round2(this.cash + shares * instrument.strike);
        } else {
          // Assigned: shares put to us at the strike.
          this.adjustEquityPosition(instrument.underlying, shares, instrument.strike);
          this.cash = round2(this.cash - shares * instrument.strike);
        }
        outcomes.push({ instrument, outcome: 'assigned', contracts });
      } else {
        // Out-of-the-money at expiry (or a long leg we choose not to auto-exercise) — the contract lapses
        // worthless with no shares/cash movement; the open credit/debit was already booked at fill time.
        outcomes.push({ instrument, outcome: 'expired_worthless', contracts });
      }
      this.optionPositions.delete(occSymbol);
    }
    return outcomes;
  }

  // Mutate the equity ledger for an assignment's share leg. Only an INCREASE (a put assignment buying
  // shares) re-bases cost — a call assignment's share reduction leaves the remaining shares' basis alone,
  // mirroring `applyFill`'s "a sell's cost basis is left unchanged" convention.
  private adjustEquityPosition(symbol: string, sharesDelta: number, priceForNewBasis: number): void {
    const existing = this.positions.get(symbol) ?? { qty: 0, avgEntryPrice: priceForNewBasis };
    const newQty = round4(existing.qty + sharesDelta);
    const newAvgEntryPrice =
      sharesDelta > 0 && newQty !== 0
        ? round2((existing.qty * existing.avgEntryPrice + sharesDelta * priceForNewBasis) / newQty)
        : existing.avgEntryPrice;
    if (newQty === 0) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, { qty: newQty, avgEntryPrice: newAvgEntryPrice });
    }
  }
}

// Deterministic order-request validation, shared shape with what the real client must also reject.
// Exported so the lifecycle service (and tests) can reuse the exact same pre-broker checks.
export function validateOrderRequest(order: AlpacaOrderRequest): void {
  if (!order.clientOrderId || !order.clientOrderId.trim()) {
    throw new AlpacaOrderValidationError('clientOrderId is required');
  }
  if (!order.symbol || !order.symbol.trim()) {
    throw new AlpacaOrderValidationError('symbol is required');
  }
  const hasQty = order.qty != null;
  const hasNotional = order.notional != null;
  if (hasQty === hasNotional) {
    throw new AlpacaOrderValidationError('exactly one of qty or notional must be set');
  }
  if (hasQty && (order.qty as number) <= 0) {
    throw new AlpacaOrderValidationError('qty must be positive');
  }
  if (hasNotional && (order.notional as number) <= 0) {
    throw new AlpacaOrderValidationError('notional must be positive');
  }
  if (order.type === 'limit' && (order.limitPrice == null || order.limitPrice <= 0)) {
    throw new AlpacaOrderValidationError('limit orders require a positive limitPrice');
  }
  if (order.type === 'market' && order.limitPrice != null) {
    throw new AlpacaOrderValidationError('market orders must not carry a limitPrice');
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// Whole days from `nowIso` to an expiration date (YYYY-MM-DD) — deliberately anchored to the client's own
// deterministic clock, never wall-clock `Date.now()`, so expiration/assignment processing stays
// reproducible across runs (mirrors `alpaca_safeguards.daysUntilExpiration`, which anchors to real time
// because a live proposal genuinely happens "now").
function daysUntilExpirationFrom(expirationDate: string, nowIso: string): number {
  const expiresAt = Date.parse(`${expirationDate}T00:00:00.000Z`);
  return Math.round((expiresAt - Date.parse(nowIso)) / (24 * 60 * 60 * 1000));
}
