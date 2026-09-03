// Thin typed Alpaca broker client — the interface + wire DTOs (B26 slice 1b).
//
// This is the single boundary between our code and the Alpaca broker. It is intentionally decoupled
// from the `alpaca_*` EAV entity types (`$.AlpacaAccountSnapshot` etc.): the entities are how we
// PERSIST broker state; these DTOs are the live, in-memory shape returned by a broker call. The
// lifecycle service (slice 1c) maps these DTOs into the entities. Keeping them separate means the
// persisted schema can evolve without coupling to Alpaca's wire format.
//
// There are two implementations behind this one interface (see `alpaca_client.factory.ts`):
//   - SimulatedAlpacaClient — deterministic, seeded, no network. Exercises the UI + lifecycle today.
//   - RealAlpacaPaperClient — real Alpaca paper REST, inert until the owner's paper key lands.
// Selecting between them is a single config swap (the factory), per the B26 mock-first directive.

export type AlpacaEnvironment = 'paper' | 'live';

// Which implementation is in use, for diagnostics/UI ("you are looking at simulated data").
export type AlpacaClientKind = 'simulated' | 'paper';

export interface AlpacaAccountInfo {
  cash: number;
  buyingPower: number;
  equity: number;
  portfolioValue: number;
  currency: string;
  // The broker's own answer to "how much cash-secured-put collateral is actually free right now"
  // (H18) — margin buying power and options buying power are different pools, and a proposal that
  // clears a derived-from-our-own-book cash figure can still be refused at the broker. This is the
  // authority for `defined_risk_floor` on a short put; our own book stays as the within-cycle guard
  // against two sibling proposals pledging the same dollar before either reaches the broker.
  optionsBuyingPower: number;
}

export interface AlpacaPositionInfo {
  symbol: string;
  qty: number;
  side: 'long' | 'short';
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
  // Present only for an option position (B50) — the contract identity + Greeks/DTE computed at read
  // time. Null/omitted = an equity position, unchanged from every prior slice.
  instrument?: AlpacaOptionInstrument | null;
  daysToExpiry?: number | null;
  delta?: number | null;
}

export interface AlpacaClockInfo {
  isOpen: boolean;
  nextOpen: string | null;
  nextClose: string | null;
}

// Tradability check — code must reject proposals for untradable/unknown symbols (design §5).
export interface AlpacaAssetInfo {
  symbol: string;
  tradable: boolean;
  fractionable: boolean;
}

export type AlpacaOptionRight = 'call' | 'put';

// Buy/sell isn't enough to describe an options order — open vs. close changes whether the position
// grows or shrinks. Richer than equity `side` (design §13.1, Layer A); `side` is still derived from
// this (buy_to_open/buy_to_close → buy, sell_to_open/sell_to_close → sell) so order routing is unchanged.
export type AlpacaPositionIntent = 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';

// A single option leg's contract identity (B46, Layer A — single-leg only). Strategy stays out of this
// shape entirely; it describes *what contract*, not *why*. A future multi-leg order (roll/spread)
// generalizes this into `legs: AlpacaOptionInstrument[]`, extending the shape rather than rewriting it.
export interface AlpacaOptionInstrument {
  assetClass: 'option';
  underlying: string;
  // OCC contract symbol, e.g. `AAPL250620C00200000`.
  occSymbol: string;
  expiration: string; // YYYY-MM-DD
  strike: number;
  right: AlpacaOptionRight;
  // Contract multiplier — 100 for standard equity options.
  multiplier: number;
  positionIntent: AlpacaPositionIntent;
}

export interface AlpacaOrderRequest {
  // Deterministic idempotency key derived from the action entity id (design §4.5). Alpaca rejects a
  // duplicate client_order_id, so a retry or double-worker can never place the same order twice.
  clientOrderId: string;
  // For an option order this is the OCC contract symbol (mirrors `instrument.occSymbol`).
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  timeInForce: 'day' | 'gtc';
  // Exactly one of qty / notional is set (share count vs. dollar amount). Validated by the client.
  qty?: number | null;
  notional?: number | null;
  limitPrice?: number | null;
  // Present only for an option order (null/omitted = equity). qty then counts contracts, not shares.
  instrument?: AlpacaOptionInstrument | null;
}

export type AlpacaOrderStatus =
  'pending_new' | 'new' | 'accepted' | 'partially_filled' | 'filled' | 'canceled' | 'rejected';

export interface AlpacaOrderResult {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  timeInForce: 'day' | 'gtc';
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  status: AlpacaOrderStatus;
  filledQty: number;
  filledAvgPrice: number | null;
  submittedAt: string;
  instrument?: AlpacaOptionInstrument | null;
}

// A duplicate client_order_id was submitted — surfaced as a typed error so the lifecycle can treat it
// as the idempotency guarantee firing (the order already exists), not a hard failure.
export class AlpacaDuplicateOrderError extends Error {
  constructor(public readonly clientOrderId: string) {
    super(`An order with client_order_id='${clientOrderId}' already exists`);
    this.name = 'AlpacaDuplicateOrderError';
  }
}

// An order request that fails deterministic validation before it would ever reach the broker.
export class AlpacaOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlpacaOrderValidationError';
  }
}

// Greeks as the data feed itself reports them. Measured 2026-09-03: the FREE `feed=indicative` snapshot
// carries `greeks` + `impliedVolatility` on every near-the-money contract, which the B52-era comment here
// ("greeks require OPRA") predates. They are the feed's own model output, not an exchange fact, so they
// stay labelled as feed-supplied all the way to the owner (`describeDeltaSource`).
export interface AlpacaFeedGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  impliedVol: number | null;
}

// A single option contract's latest market quote from the data feed (B52). `greeks`/`impliedVol` are
// present when the feed supplied them; when it doesn't, delta and friends are computed downstream from
// `mid` (BlackScholesGreeksSource) and labelled as estimates.
export interface AlpacaOptionQuote {
  occSymbol: string;
  underlying: string;
  expiration: string; // YYYY-MM-DD
  strike: number;
  right: AlpacaOptionRight;
  bid: number | null;
  ask: number | null;
  // (bid+ask)/2 when both sides are positively quoted, else null — the price the greeks solver consumes.
  mid: number | null;
  asOf: string | null; // ISO timestamp of the latest quote, when available.
  // Feed-supplied greeks/IV when the snapshot carried them, else null (compute downstream from `mid`).
  greeks?: AlpacaFeedGreeks | null;
}

// The underlying's last printed trade — the price every candidate is measured against. Sourced from the
// free `iex` feed (SIP is 403 on this account, measured 2026-09-03), so it is a real print, never a
// simulation, on any symbol whether or not we hold it.
export interface AlpacaLatestTrade {
  symbol: string;
  price: number;
  asOf: string | null;
}

// Narrowing filters for an option-chain query. All optional; the real client passes the ones the
// indicative snapshot endpoint supports server-side so a targeted strike/expiry lookup stays cheap.
export interface AlpacaOptionChainQuery {
  expiration?: string; // YYYY-MM-DD exact
  // Expiration WINDOW (inclusive), for discovering which expiries are actually listed. Ignored when
  // `expiration` pins an exact date.
  expirationGte?: string; // YYYY-MM-DD
  expirationLte?: string; // YYYY-MM-DD
  right?: AlpacaOptionRight;
  strikeGte?: number;
  strikeLte?: number;
  limit?: number;
}

// Mid = (bid+ask)/2 when both sides are positively quoted and not crossed, else null. A one-sided,
// absent, or crossed/stale quote yields no usable mid — callers surface "no greek" rather than solve IV
// off a bad price.
export function optionQuoteMid(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || !(bid > 0) || !(ask > 0) || ask < bid) {
    return null;
  }
  return Math.round(((bid + ask) / 2) * 100) / 100;
}

// Build a standard OCC contract symbol (`{ROOT}{YYMMDD}{C|P}{STRIKE×1000, 8 digits}`, e.g.
// `AAPL250620C00200000`). The inverse of `parseOccSymbol`; the two round-trip.
export function buildOccSymbol(
  underlying: string,
  expiration: string,
  right: AlpacaOptionRight,
  strike: number,
): string {
  const [year, month, day] = expiration.split('-');
  const yy = year.slice(2);
  const strikeCode = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${underlying.toUpperCase()}${yy}${month}${day}${right === 'call' ? 'C' : 'P'}${strikeCode}`;
}

// Parse a standard OCC contract symbol (`{ROOT}{YYMMDD}{C|P}{STRIKE×1000, 8 digits}`, e.g.
// `AAPL260713C00210000`) back into its parts. The root is variable-length, so the fixed-width tail is
// parsed from the right. Returns null for anything that doesn't match the exact OCC grammar — the
// inverse of `buildOccSymbol`.
export function parseOccSymbol(occSymbol: string): {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  right: AlpacaOptionRight;
  strike: number;
} | null {
  const match = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occSymbol.toUpperCase());
  if (!match) {
    return null;
  }
  const [, underlying, yy, mm, dd, rightCode, strikeCode] = match;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return {
    underlying,
    expiration: `20${yy}-${mm}-${dd}`,
    right: rightCode === 'C' ? 'call' : 'put',
    strike: Number(strikeCode) / 1000,
  };
}

// What happened to an open option position when its contract reached expiration (B50, Layer D). The
// simulated client derives this from its own ledger; the real paper broker settles assignment/expiry
// server-side and records each settlement as an account activity, which the real client reads back and
// maps to this shape (B53). Either way it's reported to the caller so the outcome can be reflected onto
// the originating `alpaca_action` (the trade-cycle service's job, not the client's).
export interface AlpacaOptionExpirationOutcome {
  instrument: AlpacaOptionInstrument;
  // 'assigned' = an in-the-money short leg was exercised against us; 'expired_worthless' = the contract
  // lapsed out-of-the-money with no shares/cash movement (the open credit/debit was already booked).
  outcome: 'assigned' | 'expired_worthless';
  contracts: number;
}

// The broker boundary. Both implementations honor exactly this contract.
export interface AlpacaClient {
  readonly environment: AlpacaEnvironment;
  readonly kind: AlpacaClientKind;

  getAccount(): Promise<AlpacaAccountInfo>;
  getPositions(): Promise<AlpacaPositionInfo[]>;
  getClock(): Promise<AlpacaClockInfo>;
  // Returns null for an unknown symbol (so callers can reject untradable proposals).
  getAsset(symbol: string): Promise<AlpacaAssetInfo | null>;

  // Submit (stage, in the simulated case) an order. Throws AlpacaDuplicateOrderError on a repeated
  // clientOrderId and AlpacaOrderValidationError on a malformed request.
  submitOrder(order: AlpacaOrderRequest): Promise<AlpacaOrderResult>;
  // Idempotency lookup — returns the existing order for a clientOrderId, or null.
  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrderResult | null>;
  listOrders(): Promise<AlpacaOrderResult[]>;

  // Report option-contract settlements (assigned / expired-worthless) so the caller can reconcile the
  // originating `alpaca_action` (B50/B53). The simulated client settles its own in-memory ledger and
  // returns each outcome once; the real paper client reads back the broker's own account-activities feed,
  // which is append-only, so it re-reports each settlement every cycle and the caller dedupes. A no-op
  // ([]) when there are no settlements to report.
  processExpirations(): Promise<AlpacaOptionExpirationOutcome[]>;

  // ---- Option market data (B52, free `feed=indicative`) ------------------------------------------------
  // Snapshot the option chain for an underlying: real listed contracts + latest bid/ask, NO greeks
  // (computed downstream from `mid`). Returns [] for an underlying with no listed options. Narrow with
  // the query filters — callers should pass a strike/expiration band so the result stays small and no
  // pagination is needed.
  getOptionChain(underlying: string, query?: AlpacaOptionChainQuery): Promise<AlpacaOptionQuote[]>;
  // Latest quote for one OCC contract symbol; null when the contract isn't quoted or the symbol is
  // unparseable.
  getOptionQuote(occSymbol: string): Promise<AlpacaOptionQuote | null>;
  // Latest printed trade for an EQUITY symbol — the underlying price candidate generation is measured
  // against. Null when the symbol has no print (unknown/untraded); callers must not invent a price.
  getLatestTrade(symbol: string): Promise<AlpacaLatestTrade | null>;
}
