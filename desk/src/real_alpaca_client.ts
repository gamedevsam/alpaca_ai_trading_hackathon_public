// Real Alpaca PAPER REST client (B26 slice 1b, wired live B51) — talks to the real Alpaca paper account.
//
// IMPORTANT SAFETY POSTURE:
//   - This client only ever targets the configured PAPER (fake-money) endpoint. There is no live path in
//     this client; the factory refuses to build a real client for the `live` environment, and live
//     trading is its own separately-gated future slice (design §10 step 6 / APPROVALS, B54).
//   - The factory (`alpaca_client.factory.ts`) is the only place this is constructed, sourcing
//     credentials + endpoint from `server_config.ts`, and only when the owner's `alpaca_control` mode
//     for the environment is `paper` (default `dry_run` stays on the simulated client).
//
// It mirrors the `stocks.service` axios style (typed HTTP, mapped wire→DTO). No SDK dependency for a
// single-user tool. The proposal/lifecycle code calls the same `AlpacaClient` interface regardless of
// which implementation the factory returns.

import axios, { AxiosInstance } from 'axios';
import {
  AlpacaAccountInfo,
  AlpacaAssetInfo,
  AlpacaClient,
  AlpacaClockInfo,
  AlpacaDuplicateOrderError,
  AlpacaEnvironment,
  AlpacaFeedGreeks,
  AlpacaLatestTrade,
  AlpacaOptionChainQuery,
  AlpacaOptionExpirationOutcome,
  AlpacaOptionQuote,
  AlpacaOrderRequest,
  AlpacaOrderResult,
  AlpacaOrderStatus,
  AlpacaPositionInfo,
  optionQuoteMid,
  parseOccSymbol,
} from './alpaca.types';
import { validateOrderRequest } from './simulated_alpaca_client';

// The market-data host (distinct from the trading host). Options chains/quotes come from here on the
// FREE `feed=indicative` — real listed contracts, real bid/ask, and (measured 2026-09-03) the feed's own
// greeks + IV on liquid contracts; `option_greeks.ts` solves the rest.
const ALPACA_DATA_BASE_URL = 'https://data.alpaca.markets';
const ALPACA_OPTIONS_FEED = 'indicative';
// Equity quotes: SIP is 403 on this account (measured 2026-09-03), `iex` is free and real.
const ALPACA_STOCKS_FEED = 'iex';
// A single snapshot page holds this many contracts; callers narrow via strike/expiry so few pages are
// needed. `ALPACA_OPTION_CHAIN_MAX_PAGES` bounds a too-broad query instead of hanging on a long walk.
const ALPACA_OPTION_CHAIN_PAGE_LIMIT = 100;
const ALPACA_OPTION_CHAIN_MAX_PAGES = 4;
const ALPACA_REQUEST_TIMEOUT_MS = 15_000;

// Alpaca non-trade activity types that represent an option contract settling (B53). `OPEXP` = expired
// worthless; `OPASN` = a short leg assigned against us; `OPEXC` = a long leg we exercised. We request only
// these from `/v2/account/activities` and cap to the most recent page — a single-user paper account never
// settles anywhere near this many contracts between cycles, and the caller dedupes anyway.
const OPTION_SETTLEMENT_ACTIVITY_TYPES = ['OPEXP', 'OPASN', 'OPEXC'] as const;
const ALPACA_ACTIVITIES_PAGE_LIMIT = 100;

export interface RealAlpacaPaperClientOptions {
  keyId: string;
  secret: string;
  // The configured trading endpoint (`ALPACA_PAPER_ENDPOINT` or `ALPACA_LIVE_ENDPOINT`), normalized by
  // `normalizeAlpacaBaseUrl`.
  baseUrl: string;
  // Which account this real client is pointed at (B54). Defaults to `paper`; a `live` value only changes
  // what this instance *reports* — the endpoint/creds already select the real account. The owner-armed
  // gate that permits building a live client at all lives upstream (the factory's `allowLive` +
  // `AlpacaLifecycleService`'s `liveArmed` check), never here.
  environment?: AlpacaEnvironment;
}

// The owner's configured endpoint may or may not already include the `/v2` path (Alpaca's own docs are
// inconsistent about this, and the value is hand-typed into Dokku config) — normalize both forms to a
// base that always ends in `/v2`, so every call site below can append a bare path (`/account`, not
// `/v2/account`) regardless of how the endpoint was written.
export function normalizeAlpacaBaseUrl(rawEndpoint: string): string {
  const trimmed = rawEndpoint.replace(/\/+$/, '');
  return /\/v2$/i.test(trimmed) ? trimmed : `${trimmed}/v2`;
}

// Minimal shapes of the Alpaca REST JSON we consume (snake_case wire format).
interface AlpacaAccountWire {
  cash?: string;
  buying_power?: string;
  equity?: string;
  portfolio_value?: string;
  currency?: string;
  options_buying_power?: string;
}
interface AlpacaPositionWire {
  symbol?: string;
  qty?: string;
  side?: string;
  avg_entry_price?: string;
  market_value?: string;
  unrealized_pl?: string;
}
interface AlpacaClockWire {
  is_open?: boolean;
  next_open?: string | null;
  next_close?: string | null;
}
interface AlpacaAssetWire {
  symbol?: string;
  tradable?: boolean;
  fractionable?: boolean;
}
export interface AlpacaOrderWire {
  id?: string;
  client_order_id?: string;
  symbol?: string;
  side?: string;
  type?: string;
  time_in_force?: string;
  qty?: string | null;
  notional?: string | null;
  limit_price?: string | null;
  status?: string;
  filled_qty?: string | null;
  filled_avg_price?: string | null;
  submitted_at?: string;
}
// Options market-data wire shapes (indicative feed). `latestQuote` carries `bp`/`ap` (bid/ask price),
// `bs`/`as` (sizes), `t` (RFC-3339 timestamp). `greeks`/`impliedVolatility` sit beside it on the snapshot.
interface AlpacaOptionQuoteWire {
  bp?: number;
  ap?: number;
  bs?: number;
  as?: number;
  t?: string;
}
interface AlpacaOptionGreeksWire {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}
interface AlpacaOptionSnapshotWire {
  latestQuote?: AlpacaOptionQuoteWire;
  // Present on liquid contracts of the free indicative feed (measured 2026-09-03); absent on thin ones.
  greeks?: AlpacaOptionGreeksWire;
  impliedVolatility?: number;
}
// `/v2/stocks/{symbol}/trades/latest` — `p` = price, `t` = RFC-3339 timestamp.
interface AlpacaLatestTradeWire {
  symbol?: string;
  trade?: { p?: number; t?: string };
}
interface AlpacaOptionSnapshotsResponse {
  snapshots?: Record<string, AlpacaOptionSnapshotWire>;
  next_page_token?: string | null;
}
// A non-trade account activity (B53). For an option settlement, `symbol` is the OCC contract symbol and
// `qty` the number of contracts settled. Other fields (net_amount, price, …) exist but aren't needed —
// the activity *type* alone tells us assigned vs. expired-worthless, and the OCC symbol carries
// underlying/strike/expiry/right. Shape sourced from Alpaca's account-activities docs; parsing is
// defensive (`qty` may arrive as a string or under `cum_qty`).
interface AlpacaAccountActivityWire {
  id?: string;
  activity_type?: string;
  date?: string;
  symbol?: string;
  qty?: string | number | null;
  cum_qty?: string | number | null;
}

export class RealAlpacaPaperClient implements AlpacaClient {
  // Real REST client against Alpaca. `kind: 'paper'` distinguishes it from the `simulated` client (the
  // implementation axis); `environment` (paper|live) carries which *account* it talks to — a live
  // instance is byte-identical code pointed at the live endpoint/creds (B54). Building one at all is
  // gated upstream by the owner's `liveArmed` toggle; this class never decides that.
  readonly environment: AlpacaEnvironment;
  readonly kind = 'paper' as const;

  private readonly http: AxiosInstance;
  // Separate instance for the market-data host (options chains/quotes) — same auth, different base URL.
  private readonly dataHttp: AxiosInstance;

  constructor(options: RealAlpacaPaperClientOptions) {
    if (!options.keyId || !options.secret) {
      throw new Error('RealAlpacaPaperClient requires keyId and secret');
    }
    this.environment = options.environment ?? 'paper';
    const headers = {
      'APCA-API-KEY-ID': options.keyId,
      'APCA-API-SECRET-KEY': options.secret,
    };
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: ALPACA_REQUEST_TIMEOUT_MS,
      headers,
    });
    this.dataHttp = axios.create({
      baseURL: ALPACA_DATA_BASE_URL,
      timeout: ALPACA_REQUEST_TIMEOUT_MS,
      headers,
    });
  }

  async getAccount(): Promise<AlpacaAccountInfo> {
    const { data } = await this.http.get<AlpacaAccountWire>('/account');
    return {
      cash: num(data.cash),
      buyingPower: num(data.buying_power),
      equity: num(data.equity),
      portfolioValue: num(data.portfolio_value),
      currency: data.currency ?? 'USD',
      optionsBuyingPower: num(data.options_buying_power),
    };
  }

  async getPositions(): Promise<AlpacaPositionInfo[]> {
    const { data } = await this.http.get<AlpacaPositionWire[]>('/positions');
    return (data ?? []).map((p) => ({
      symbol: (p.symbol ?? '').toUpperCase(),
      qty: num(p.qty),
      side: p.side === 'short' ? 'short' : 'long',
      avgEntryPrice: num(p.avg_entry_price),
      marketValue: num(p.market_value),
      unrealizedPl: num(p.unrealized_pl),
    }));
  }

  async getClock(): Promise<AlpacaClockInfo> {
    const { data } = await this.http.get<AlpacaClockWire>('/clock');
    return {
      isOpen: Boolean(data.is_open),
      nextOpen: data.next_open ?? null,
      nextClose: data.next_close ?? null,
    };
  }

  async getAsset(symbol: string): Promise<AlpacaAssetInfo | null> {
    try {
      const { data } = await this.http.get<AlpacaAssetWire>(`/assets/${encodeURIComponent(symbol.toUpperCase())}`);
      return {
        symbol: (data.symbol ?? symbol).toUpperCase(),
        tradable: Boolean(data.tradable),
        fractionable: Boolean(data.fractionable),
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null; // Unknown symbol — caller rejects the proposal.
      }
      throw error;
    }
  }

  async submitOrder(order: AlpacaOrderRequest): Promise<AlpacaOrderResult> {
    validateOrderRequest(order);
    try {
      const { data } = await this.http.post<AlpacaOrderWire>('/orders', {
        client_order_id: order.clientOrderId,
        symbol: order.symbol.toUpperCase(),
        side: order.side,
        type: order.type,
        time_in_force: order.timeInForce,
        qty: order.qty ?? undefined,
        notional: order.notional ?? undefined,
        limit_price: order.limitPrice ?? undefined,
      });
      return mapOrderWire(data);
    } catch (error) {
      // Alpaca 422s a duplicate client_order_id — surface it as the idempotency guarantee firing.
      if (axios.isAxiosError(error) && error.response?.status === 422) {
        if (isDuplicateClientOrderIdBody(error.response?.data)) {
          throw new AlpacaDuplicateOrderError(order.clientOrderId);
        }
      }
      throw error;
    }
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrderResult | null> {
    try {
      const { data } = await this.http.get<AlpacaOrderWire>('/orders:by_client_order_id', {
        params: { client_order_id: clientOrderId },
      });
      return mapOrderWire(data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async listOrders(): Promise<AlpacaOrderResult[]> {
    const { data } = await this.http.get<AlpacaOrderWire[]>('/orders', { params: { status: 'all' } });
    return (data ?? []).map(mapOrderWire);
  }

  // The real broker settles assignment/expiry itself — but that settlement only mutates the *position*
  // ledger; our `alpaca_action` audit trail never learns of it unless we read it back (B53). Alpaca
  // records each settlement as a non-trade account activity: `OPEXP` (expired worthless), `OPASN` (short
  // leg assigned against us), `OPEXC` (a long leg we exercised). We read the recent option-settlement
  // activities and map them to outcomes so the trade-cycle service can reconcile the originating action.
  //
  // Unlike the simulated client (which settles-and-forgets its own ledger, so it never re-reports), the
  // activities feed is append-only history — the same settlement is returned every cycle. Idempotency is
  // enforced by the caller (the trade cycle skips an action already carrying an `optionOutcome`), so we
  // deliberately return the full recent set here rather than tracking "seen" state in the client.
  async processExpirations(): Promise<AlpacaOptionExpirationOutcome[]> {
    const { data } = await this.http.get<AlpacaAccountActivityWire[]>('/account/activities', {
      params: { activity_types: OPTION_SETTLEMENT_ACTIVITY_TYPES.join(','), page_size: ALPACA_ACTIVITIES_PAGE_LIMIT },
    });
    return mapOptionSettlementActivities(data ?? []);
  }

  async getOptionChain(underlying: string, query: AlpacaOptionChainQuery = {}): Promise<AlpacaOptionQuote[]> {
    const params: Record<string, string | number> = {
      feed: ALPACA_OPTIONS_FEED,
      limit: query.limit ?? ALPACA_OPTION_CHAIN_PAGE_LIMIT,
    };
    if (query.right) {
      params.type = query.right; // Alpaca expects `call`/`put`.
    }
    if (query.expiration) {
      params.expiration_date = query.expiration;
    } else {
      if (query.expirationGte) {
        params.expiration_date_gte = query.expirationGte;
      }
      if (query.expirationLte) {
        params.expiration_date_lte = query.expirationLte;
      }
    }
    if (query.strikeGte != null) {
      params.strike_price_gte = query.strikeGte;
    }
    if (query.strikeLte != null) {
      params.strike_price_lte = query.strikeLte;
    }

    // The snapshot endpoint pages by contract, and an expiration WINDOW legitimately spans more contracts
    // than one page holds — so walk up to `ALPACA_OPTION_CHAIN_MAX_PAGES` rather than silently returning a
    // truncated chain that would hide real strikes from candidate selection (H0).
    const quotes: AlpacaOptionQuote[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < ALPACA_OPTION_CHAIN_MAX_PAGES; page++) {
      const { data }: { data: AlpacaOptionSnapshotsResponse } = await this.dataHttp.get<AlpacaOptionSnapshotsResponse>(
        `/v1beta1/options/snapshots/${encodeURIComponent(underlying.toUpperCase())}`,
        { params: pageToken ? { ...params, page_token: pageToken } : params },
      );
      for (const [occSymbol, snapshot] of Object.entries(data.snapshots ?? {})) {
        const quote = mapOptionQuote(occSymbol, snapshot);
        if (quote) {
          quotes.push(quote);
        }
      }
      pageToken = data.next_page_token ?? null;
      if (!pageToken) {
        return quotes;
      }
    }
    // Still paginating after the page budget: the caller asked too broadly. Surface it rather than
    // truncating without a trace.
    // eslint-disable-next-line no-console
    console.warn(
      `RealAlpacaPaperClient.getOptionChain(${underlying}): chain exceeded ${ALPACA_OPTION_CHAIN_MAX_PAGES} pages — narrow the strike/expiry filters (returning what was read).`,
    );
    return quotes;
  }

  // The underlying's last print, from the free `iex` feed. Used for EVERY candidate's underlying price,
  // held or not — before H0 an unheld underlying fell back to a hash-derived simulated price.
  async getLatestTrade(symbol: string): Promise<AlpacaLatestTrade | null> {
    const upper = symbol.toUpperCase();
    try {
      const { data } = await this.dataHttp.get<AlpacaLatestTradeWire>(
        `/v2/stocks/${encodeURIComponent(upper)}/trades/latest`,
        { params: { feed: ALPACA_STOCKS_FEED } },
      );
      const price = data.trade?.p;
      if (price == null || !Number.isFinite(price) || price <= 0) {
        return null; // No usable print — the caller must not invent one.
      }
      return { symbol: (data.symbol ?? upper).toUpperCase(), price, asOf: data.trade?.t ?? null };
    } catch (error) {
      if (axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 422)) {
        return null; // Unknown/unquoted symbol.
      }
      throw error;
    }
  }

  async getOptionQuote(occSymbol: string): Promise<AlpacaOptionQuote | null> {
    const symbol = occSymbol.toUpperCase();
    if (!parseOccSymbol(symbol)) {
      return null; // Not a valid OCC contract — don't round-trip the feed for it.
    }
    // The SNAPSHOT endpoint (not `quotes/latest`) is what carries greeks + IV alongside the quote, so one
    // call gives the safeguards a feed-supplied delta instead of a solved estimate.
    const { data } = await this.dataHttp.get<AlpacaOptionSnapshotsResponse>('/v1beta1/options/snapshots', {
      params: { symbols: symbol, feed: ALPACA_OPTIONS_FEED },
    });
    return mapOptionQuote(symbol, data.snapshots?.[symbol]);
  }
}

// Map a raw indicative-feed quote (keyed by OCC symbol) to our DTO, deriving the mid. Returns null when
// the symbol can't be parsed (so identity fields would be missing) — the quote itself may still have a
// null mid (one-sided/absent bid-ask), which the greeks solver treats as "no greek available".
function mapOptionQuote(occSymbol: string, snapshot: AlpacaOptionSnapshotWire | undefined): AlpacaOptionQuote | null {
  const parsed = parseOccSymbol(occSymbol);
  if (!parsed) {
    return null;
  }
  const wire = snapshot?.latestQuote;
  const bid = wire?.bp != null ? wire.bp : null;
  const ask = wire?.ap != null ? wire.ap : null;
  return {
    occSymbol: occSymbol.toUpperCase(),
    underlying: parsed.underlying,
    expiration: parsed.expiration,
    strike: parsed.strike,
    right: parsed.right,
    bid,
    ask,
    mid: optionQuoteMid(bid, ask),
    asOf: wire?.t ?? null,
    greeks: mapFeedGreeks(snapshot),
  };
}

// The feed's own greeks, kept only when it reported a complete, finite set — a partial greeks object is
// treated as no greeks at all so the caller falls back to the labelled Black–Scholes solve rather than
// mixing a real delta with a fabricated gamma.
function mapFeedGreeks(snapshot: AlpacaOptionSnapshotWire | undefined): AlpacaFeedGreeks | null {
  const g = snapshot?.greeks;
  if (!g || ![g.delta, g.gamma, g.theta, g.vega].every((v) => v != null && Number.isFinite(v))) {
    return null;
  }
  const iv = snapshot?.impliedVolatility;
  return {
    delta: g.delta!,
    gamma: g.gamma!,
    theta: g.theta!,
    vega: g.vega!,
    impliedVol: iv != null && Number.isFinite(iv) ? iv : null,
  };
}

// Map Alpaca option-settlement account activities to expiration outcomes (B53). Pure so it can be
// unit-tested without the network. Skips any activity that isn't an option settlement or whose symbol
// isn't a parseable OCC contract (a related equity leg of an assignment, a corporate action, etc.) —
// we only attribute settlements we can tie to a specific contract.
export function mapOptionSettlementActivities(
  activities: AlpacaAccountActivityWire[],
): AlpacaOptionExpirationOutcome[] {
  const outcomes: AlpacaOptionExpirationOutcome[] = [];
  for (const activity of activities ?? []) {
    const type = activity.activity_type;
    if (type !== 'OPEXP' && type !== 'OPASN' && type !== 'OPEXC') {
      continue;
    }
    const parsed = activity.symbol ? parseOccSymbol(activity.symbol) : null;
    if (!parsed) {
      continue;
    }
    outcomes.push({
      instrument: {
        assetClass: 'option',
        underlying: parsed.underlying,
        occSymbol: activity.symbol!.toUpperCase(),
        expiration: parsed.expiration,
        strike: parsed.strike,
        right: parsed.right,
        multiplier: 100,
        // The activities feed carries no position-intent; this strategy is short-only (covered calls /
        // CSPs) so a settlement closes a short leg. Downstream (`describeExpirationOutcome` + the OCC-symbol
        // match) reads only underlying/right/strike/occSymbol, so this label is cosmetic, not fabricated data.
        positionIntent: 'buy_to_close',
      },
      // `OPEXP` is the only "nothing moved" case; assignment (`OPASN`) and exercise (`OPEXC`) both move shares/cash.
      outcome: type === 'OPEXP' ? 'expired_worthless' : 'assigned',
      contracts: Math.round(Math.abs(num(activity.qty ?? activity.cum_qty))),
    });
  }
  return outcomes;
}

/**
 * Does this Alpaca error body mean "you already used that client_order_id"?
 *
 * This predicate IS the idempotency guarantee. `executeAction` retries a submission by re-sending the
 * same `clientOrderId`; the broker refusing the second copy is the ONLY thing standing between a retried
 * cycle and a duplicated order, and it is recoverable (look the existing order up) rather than a failure
 * — but only if we recognise the refusal. Miss it, and a legitimate retry is recorded as `failed` while
 * the first order is live at the broker: the audit trail and reality disagree, which for an autonomous
 * desk is the worst failure mode there is.
 *
 * So both transports run this one function over the raw error body and can never drift.
 *
 * Verified against the paper broker on 2026-09-03: submitting a duplicate `client_order_id` answers HTTP
 * 422 with `{"code":42210000,"message":"client_order_id must be unique"}`. Note there is no "exists" in
 * that wording — an earlier `/exist/` test matched nothing and would have silently disarmed the recovery.
 * `exist`/`duplicate` are kept alongside it precisely so a broker-side copy change cannot do that again.
 */
export function isDuplicateClientOrderIdBody(body: unknown): boolean {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /client_order_id/i.test(text) && /(must be unique|exist|duplicate)/i.test(text);
}

// Wire order → DTO. Exported because the CLI transport (H1) parses the very same Alpaca order JSON off
// `alpaca order submit` stdout, and the two paths must produce an identical `AlpacaOrderResult`.
export function mapOrderWire(wire: AlpacaOrderWire): AlpacaOrderResult {
  return {
    id: wire.id ?? '',
    clientOrderId: wire.client_order_id ?? '',
    symbol: (wire.symbol ?? '').toUpperCase(),
    side: wire.side === 'sell' ? 'sell' : 'buy',
    type: wire.type === 'limit' ? 'limit' : 'market',
    timeInForce: wire.time_in_force === 'gtc' ? 'gtc' : 'day',
    qty: wire.qty != null ? num(wire.qty) : null,
    notional: wire.notional != null ? num(wire.notional) : null,
    limitPrice: wire.limit_price != null ? num(wire.limit_price) : null,
    status: normalizeStatus(wire.status),
    filledQty: num(wire.filled_qty),
    filledAvgPrice: wire.filled_avg_price != null ? num(wire.filled_avg_price) : null,
    submittedAt: wire.submitted_at ?? '',
  };
}

function normalizeStatus(status: string | undefined): AlpacaOrderStatus {
  switch (status) {
    case 'new':
    case 'accepted':
    case 'partially_filled':
    case 'filled':
    case 'canceled':
    case 'rejected':
    case 'pending_new':
      return status;
    default:
      // Map any other Alpaca lifecycle status (done_for_day, expired, replaced, …) to a safe default.
      return 'accepted';
  }
}

function num(value: string | number | null | undefined): number {
  if (value == null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
