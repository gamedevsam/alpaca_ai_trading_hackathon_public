import { EntityService } from '~/entity/entity.service';
import { ForumInferenceService } from '~/api/forum/forum_inference.service';
import {
  AlpacaAccountInfo,
  AlpacaOptionChainQuery,
  AlpacaOptionQuote,
  AlpacaOptionRight,
  AlpacaPositionInfo,
  buildOccSymbol,
  optionQuoteMid,
} from '../alpaca.types';
import { AlpacaControlLimits } from '../alpaca_safeguards';
import { AlpacaLifecycleService } from '../alpaca_lifecycle.service';
import { AlpacaMandateService } from '../alpaca_mandate.service';
import { AlpacaDeskLedgerService } from '../alpaca_desk_ledger.service';
import { AlpacaSignalService, OpenSignalBrief } from '../alpaca_signal.service';

const USER = 'USR_test_owner_00000001';

const ENABLED_LIMITS: AlpacaControlLimits = {
  maxNotionalPerOrder: null,
  maxPositionPct: null,
  maxOrdersPerDay: null,
  maxDailyNotional: null,
  symbolAllowList: [],
  symbolDenyList: [],
  optionsEnabled: true,
  cooldownAfterFailureMs: null,
  maxContractsPerOrder: null,
  maxContractsPerUnderlying: null,
  maxShortCallCoveredPct: null,
  minDaysToExpiry: 7,
  maxDaysToExpiry: 45,
  requireOtm: true,
  minStrikeVsCostBasisPct: null,
  maxAbsDelta: 0.4,
  earningsBlackoutDays: null,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A YYYY-MM-DD date `days` out from now, so every fixture's DTE is relative to the running clock.
function isoInDays(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

// The next date at least `minDays` out that falls on a Friday (the expiries the chain really lists).
function nextFriday(minDays: number): string {
  for (let days = minDays; days < minDays + 7; days++) {
    const at = new Date(Date.now() + days * MS_PER_DAY);
    if (at.getUTCDay() === 5) {
      return at.toISOString().slice(0, 10);
    }
  }
  throw new Error('unreachable — a Friday falls within any 7-day span');
}

// One listed contract as the feed reports it: a two-sided quote, plus the feed's own greeks unless the
// test wants the Black–Scholes fallback exercised.
function listedContract(options: {
  underlying: string;
  expiration: string;
  right: AlpacaOptionRight;
  strike: number;
  bid: number;
  delta?: number | null;
}): AlpacaOptionQuote {
  const { underlying, expiration, right, strike, bid } = options;
  const ask = Math.round((bid + 0.04) * 100) / 100;
  return {
    occSymbol: buildOccSymbol(underlying, expiration, right, strike),
    underlying,
    expiration,
    strike,
    right,
    bid,
    ask,
    mid: optionQuoteMid(bid, ask),
    asOf: null,
    greeks:
      options.delta == null ? null : { delta: options.delta, gamma: 0.01, theta: -0.05, vega: 0.1, impliedVol: 0.28 },
  };
}

function makeMandate(overrides: Partial<$.AlpacaMandate['body']> = {}): Required<$.AlpacaMandate> {
  const now = new Date().toISOString();
  return {
    id: 'AMN_test_mandate_0000001',
    owner_id: USER,
    external_id: null,
    status: 'active',
    schema_version: 1,
    created_at: now,
    updated_at: now,
    type: 'alpaca_mandate',
    header: { owner_user_id: USER, environment: 'paper', status: 'draft', promotion_state: 'sandbox' },
    body: {
      environment: 'paper',
      name: 'Income Manager',
      mandate: 'Sell conservative covered calls and cash-secured puts on high-conviction holdings.',
      provider: 'local',
      model: null,
      status: 'draft',
      promotionState: 'sandbox',
      promotedFromMandateId: null,
      notes: null,
      optionStrategy: {
        targetUnderlyings: ['AAPL'],
        minDaysToExpiry: null,
        maxDaysToExpiry: null,
        requireOtm: true,
        maxAbsDelta: null,
      },
      ...overrides,
    },
  } as Required<$.AlpacaMandate>;
}

function makeFakeLifecycle(
  options: {
    account?: Partial<AlpacaAccountInfo>;
    positions?: AlpacaPositionInfo[];
    limits?: Partial<AlpacaControlLimits>;
    assetTradable?: boolean;
    // The listed chain the fake feed serves, and the underlying's last print.
    chain?: AlpacaOptionQuote[];
    lastPrice?: number | null;
    // Cash already reserved by open short puts across the whole account (H16).
    cashPledgedToOpenCsps?: number;
  } = {},
) {
  const account: AlpacaAccountInfo = {
    cash: 50_000,
    buyingPower: 100_000,
    equity: 150_000,
    portfolioValue: 150_000,
    currency: 'USD',
    optionsBuyingPower: 50_000,
    ...options.account,
  };
  const positions = options.positions ?? [];
  const limits: AlpacaControlLimits = { ...ENABLED_LIMITS, ...options.limits };
  const chain = options.chain ?? [];
  const cashPledgedToOpenCsps = options.cashPledgedToOpenCsps ?? 0;
  const client = {
    getAsset: jest.fn(async (symbol: string) =>
      options.assetTradable === false ? null : { symbol, tradable: true, fractionable: true },
    ),
    getLatestTrade: jest.fn(async (symbol: string) =>
      options.lastPrice === null ? null : { symbol, price: options.lastPrice ?? 150, asOf: null },
    ),
    // Serves the fixture chain through the same filters the real snapshot endpoint applies server-side,
    // so a candidate can only ever name a contract the fixture actually lists.
    getOptionChain: jest.fn(async (underlying: string, query: AlpacaOptionChainQuery = {}) =>
      chain.filter(
        (quote) =>
          quote.underlying === underlying.toUpperCase() &&
          (!query.right || quote.right === query.right) &&
          (query.strikeGte == null || quote.strike >= query.strikeGte) &&
          (query.strikeLte == null || quote.strike <= query.strikeLte) &&
          (query.expirationGte == null || quote.expiration >= query.expirationGte) &&
          (query.expirationLte == null || quote.expiration <= query.expirationLte),
      ),
    ),
    getOptionQuote: jest.fn(async (occSymbol: string) => chain.find((q) => q.occSymbol === occSymbol) ?? null),
  };
  const proposeAction = jest.fn(async (userId: string, input: any) => ({
    id: `TST_ACTION_${input.symbol}`,
    type: 'alpaca_action',
    owner_id: userId,
    status: 'active',
    created_at: new Date().toISOString(),
    header: {
      owner_user_id: userId,
      environment: 'paper',
      status: 'proposed',
      last_activity_at: new Date().toISOString(),
    },
    body: {
      ...input,
      status: 'proposed',
      clearedLimits: [],
      approval: null,
      clientOrderId: 'x',
      alpacaOrderId: '',
      fills: [],
      events: [],
      errorMessage: '',
    },
  }));

  const lifecycle = {
    readAccount: jest.fn(async () => ({
      kind: 'simulated',
      environment: 'paper',
      account,
      positions,
      clock: { isOpen: true, nextOpen: null, nextClose: null },
    })),
    getControl: jest.fn(async () => ({ killState: 'disarmed', mode: 'paper', limits })),
    createEnvironmentClient: jest.fn(async () => client),
    // H16 — collateral already reserved by open short puts, account-wide. Defaults to none pledged, which
    // is what every pre-H16 test assumes; `cashPledgedToOpenCsps` sets it.
    cashPledgedToOpenCsps: jest.fn(async () => cashPledgedToOpenCsps),
    proposeAction,
  } as unknown as AlpacaLifecycleService;

  return { lifecycle, proposeAction, client };
}

function makeFakeForumInference(complete: jest.Mock) {
  return { complete } as unknown as ForumInferenceService;
}

// The desk agent's view of the followed creators' open calls (H15). Defaults to "nobody has said
// anything", which is what every pre-H15 test assumes.
function makeFakeSignals(briefs: OpenSignalBrief[] = []) {
  const markSignalsActed = jest.fn(async () => briefs.length);
  const markSignalsDeclined = jest.fn(async (_owner: string, declines: unknown[]) => declines.length);
  const openSignalBriefs = jest.fn(async () => briefs);
  return {
    signals: { openSignalBriefs, markSignalsActed, markSignalsDeclined } as unknown as AlpacaSignalService,
    markSignalsActed,
    markSignalsDeclined,
  };
}

function makeBrief(overrides: Partial<OpenSignalBrief> = {}): OpenSignalBrief {
  return {
    signalId: 'ASG_signal_00000000001',
    creator: 'Joseph Carlson',
    creatorHitRate: { claimType: 'stock_selection', sampleSize: 0, count: 0, percentage: null },
    ticker: 'MSFT',
    direction: 'bullish',
    thesis: 'Azure re-accelerates and the multiple has not caught up.',
    quote: 'I think Microsoft is a buy down here, plain and simple.',
    saidAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * The ledger side of a proposal (H8). Defaults to a pass-through that stamps a fixed prediction id, so
 * every earlier assertion about the returned actions still holds and the wiring stays visible.
 */
function makeFakeDeskLedger() {
  const recordProposalClaim = jest.fn(async (_userId: string, _mandateName: string, action: any) =>
    action.body.status === 'proposed'
      ? { ...action, body: { ...action.body, predictionId: 'PRD_desk00000000000001' } }
      : action,
  );
  return { deskLedger: { recordProposalClaim } as unknown as AlpacaDeskLedgerService, recordProposalClaim };
}

function makeService(
  lifecycle: AlpacaLifecycleService,
  forumInference: ForumInferenceService,
  storedEntities: any[] = [],
  signalService: AlpacaSignalService = makeFakeSignals().signals,
  deskLedger: AlpacaDeskLedgerService = makeFakeDeskLedger().deskLedger,
) {
  const findById = jest.fn(async (id: string) => storedEntities.find((e) => e.id === id) ?? null);
  const update = jest.fn(async (entity: any, producer: (draft: any) => unknown) => {
    const draft = structuredClone(entity);
    producer(draft);
    return draft;
  });
  const upsert = jest.fn(async (entity: any) => ({ status: 'active', id: 'AMN_created0000000000001', ...entity }));
  const entityService = { findById, update, upsert } as unknown as EntityService;
  return {
    service: new AlpacaMandateService(entityService, lifecycle, forumInference, signalService, deskLedger),
    findById,
    update,
    upsert,
  };
}

const localFallback = () => jest.fn(async () => ({ usedAi: false, provider: 'local', model: null, text: '' }));

describe('AlpacaMandateService.create', () => {
  it('normalizes option-strategy defaults and dedupes/upper-cases target underlyings', async () => {
    const { lifecycle } = makeFakeLifecycle();
    const { service, upsert } = makeService(lifecycle, makeFakeForumInference(jest.fn()));

    await service.create(USER, {
      name: 'Wheel',
      mandate: 'Run the wheel on core holdings.',
      optionStrategy: { targetUnderlyings: ['aapl', 'AAPL', ' msft '] },
    });

    const created = upsert.mock.calls[0][0];
    expect(created.body.status).toBe('draft');
    expect(created.body.promotionState).toBe('sandbox');
    expect(created.body.optionStrategy.targetUnderlyings).toEqual(['AAPL', 'MSFT']);
    expect(created.body.optionStrategy.requireOtm).toBe(true);
  });

  it('rejects a blank name or mandate text', async () => {
    const { lifecycle } = makeFakeLifecycle();
    const { service } = makeService(lifecycle, makeFakeForumInference(jest.fn()));
    await expect(service.create(USER, { name: '  ', mandate: 'text' })).rejects.toThrow();
    await expect(service.create(USER, { name: 'ok', mandate: '  ' })).rejects.toThrow();
  });
});

describe('AlpacaMandateService.dryRun', () => {
  const friday = nextFriday(10);
  // A plausible AAPL put chain at one listed Friday expiry, spot $150.
  const putChain = [
    // The at-the-money strike every real chain lists — how the desk discovers that this expiry exists.
    // It is never itself a candidate here: not OTM, and its delta is far outside the band.
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 150, bid: 3.6, delta: -0.5 }),
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 145, bid: 1.8, delta: -0.24 }),
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 140, bid: 0.9, delta: -0.14 }),
    // Too far out to pay for itself — below the premium floor.
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 120, bid: 0.03, delta: -0.01 }),
    // Rich, but far too likely to be assigned.
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 149, bid: 4.1, delta: -0.47 }),
  ];
  const callChain = [
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'call', strike: 150, bid: 3.7, delta: 0.51 }),
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'call', strike: 157, bid: 1.55, delta: 0.26 }),
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'call', strike: 165, bid: 0.4, delta: 0.09 }),
  ];

  it('returns no candidates and never calls the broker when options are disabled', async () => {
    const { lifecycle } = makeFakeLifecycle({ limits: { optionsEnabled: false } });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(jest.fn()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(lifecycle.createEnvironmentClient).not.toHaveBeenCalled();
  });

  it('builds covered-call candidates from real listed contracts and proposes a day limit at the bid', async () => {
    const positions: AlpacaPositionInfo[] = [
      { symbol: 'AAPL', qty: 200, side: 'long', avgEntryPrice: 140, marketValue: 30_000, unrealizedPl: 0 },
    ];
    const { lifecycle, proposeAction, client } = makeFakeLifecycle({
      positions,
      chain: [...putChain, ...callChain],
      lastPrice: 150,
      account: { cash: 0 },
    });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    const coveredCall = result.candidates.find((c) => c.strategy === 'covered_call');
    expect(coveredCall).toBeDefined();
    // The price came from the tape, not from a hash of the ticker or a held position's market value.
    expect(client.getLatestTrade).toHaveBeenCalledWith('AAPL');
    expect(coveredCall!.underlyingPrice).toBe(150);
    // The contract is one the chain actually listed.
    expect([...putChain, ...callChain].some((q) => q.occSymbol === coveredCall!.occSymbol)).toBe(true);
    expect(coveredCall!.strike).toBe(157); // best yield of the two listed OTM calls inside the delta band
    expect(coveredCall!.contracts).toBe(2); // 200 held shares / 100
    expect(coveredCall!.limitPrice).toBe(1.55);
    expect(coveredCall!.premium).toBe(310); // 1.55 × 2 contracts × 100
    expect(coveredCall!.deltaSource).toBe('feed_indicative');

    const callProposal = proposeAction.mock.calls.find(([, input]) => input.optionLeg.right === 'call');
    expect(callProposal![1]).toMatchObject({
      mandateId: mandate.id,
      symbol: 'AAPL',
      qty: 2,
      orderType: 'limit',
      limitPrice: 1.55,
      timeInForce: 'day',
      optionLeg: { right: 'call', strike: 157, expiration: friday, positionIntent: 'sell_to_open' },
    });
  });

  it('builds cash-secured puts on an underlying it does not hold, sized to the cash on hand', async () => {
    const { lifecycle } = makeFakeLifecycle({ chain: putChain, lastPrice: 150, account: { cash: 50_000 } });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    const csp = result.candidates.find((c) => c.strategy === 'cash_secured_put');
    expect(csp).toBeDefined();
    expect(csp!.strike).toBeLessThan(150);
    expect(csp!.contracts).toBe(3); // $50k / ($145 × 100) = 3 contracts
    expect(csp!.collateral).toBe(43_500);
    expect(csp!.yieldPct).toBeCloseTo(1.24, 2);
    expect(result.candidates.some((c) => c.strategy === 'covered_call')).toBe(false); // no shares held
  });

  it('drops contracts that bid below the premium floor or sit outside the delta band', async () => {
    const { lifecycle } = makeFakeLifecycle({ chain: putChain, lastPrice: 150 });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    const strikes = result.candidates.map((c) => c.strike);
    expect(strikes).toContain(145);
    expect(strikes).not.toContain(120); // $0.03 bid — below the premium floor
    expect(strikes).not.toContain(149); // |delta| 0.47 — above the mandate/control ceiling
  });

  it('prefers a listed Friday expiry inside the bounds over a nearer weekday one', async () => {
    const wednesday = (() => {
      for (let days = 8; days < 20; days++) {
        const at = new Date(Date.now() + days * MS_PER_DAY);
        if (at.getUTCDay() === 3 && at.toISOString().slice(0, 10) < friday) {
          return at.toISOString().slice(0, 10);
        }
      }
      return isoInDays(9);
    })();
    const chain = [
      listedContract({ underlying: 'AAPL', expiration: wednesday, right: 'put', strike: 150, bid: 3.4, delta: -0.5 }),
      listedContract({ underlying: 'AAPL', expiration: wednesday, right: 'put', strike: 145, bid: 1.5, delta: -0.2 }),
      ...putChain,
    ];
    const { lifecycle } = makeFakeLifecycle({ chain, lastPrice: 150 });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.expiration === friday)).toBe(true);
  });

  it('falls back to a labelled Black–Scholes delta when the feed reports no greeks', async () => {
    const chain = [
      listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 150, bid: 3.6, delta: null }),
      listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 145, bid: 1.8, delta: null }),
    ];
    const { lifecycle } = makeFakeLifecycle({ chain, lastPrice: 150 });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].deltaSource).toBe('black_scholes_indicative');
    expect(result.candidates[0].delta).toBeLessThan(0);
  });

  it('produces nothing for an underlying with no last print', async () => {
    const { lifecycle, client } = makeFakeLifecycle({ chain: putChain, lastPrice: null });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates).toEqual([]);
    expect(client.getOptionChain).not.toHaveBeenCalled();
  });

  it('never proposes a target the owner has not allow-listed', async () => {
    const { lifecycle, client } = makeFakeLifecycle({
      chain: putChain,
      lastPrice: 150,
      limits: { symbolAllowList: ['MSFT'] },
    });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates).toEqual([]);
    expect(client.getAsset).not.toHaveBeenCalled();
  });

  it('does not pledge the same cash to two proposals in one cycle', async () => {
    // $20k of cash covers exactly one $145 contract ($14,500) — the second selection has nothing left.
    const { lifecycle, proposeAction } = makeFakeLifecycle({
      chain: putChain,
      lastPrice: 150,
      account: { cash: 20_000 },
    });
    const mandate = makeMandate();
    const complete = jest.fn(async () => ({
      usedAi: true,
      provider: 'openrouter',
      model: 'test-model',
      text: JSON.stringify({
        select: [buildOccSymbol('AAPL', friday, 'put', 145), buildOccSymbol('AAPL', friday, 'put', 140)],
      }),
    }));
    const { service } = makeService(lifecycle, makeFakeForumInference(complete), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.selected).toHaveLength(2);
    expect(proposeAction).toHaveBeenCalledTimes(1); // the second CSP's collateral is already committed
    expect(proposeAction.mock.calls[0][1]).toMatchObject({ qty: 1, optionLeg: { strike: 145 } });
  });

  // H16 — the account's `cash` still shows collateral an open short put is holding, so sizing off it
  // builds contracts the broker refuses outright ("insufficient options buying power ... available: 0").
  it("sizes candidates against cash a prior cycle's put already pledged, not the raw balance", async () => {
    // $100k cash, but $85k is holding an open put from an earlier cycle: only one $14,500 contract fits.
    const { lifecycle, proposeAction } = makeFakeLifecycle({
      chain: putChain,
      lastPrice: 150,
      account: { cash: 100_000 },
      cashPledgedToOpenCsps: 85_000,
    });
    const mandate = makeMandate();
    const complete = jest.fn(async () => ({
      usedAi: true,
      provider: 'openrouter',
      model: 'test-model',
      text: JSON.stringify({
        select: [buildOccSymbol('AAPL', friday, 'put', 145), buildOccSymbol('AAPL', friday, 'put', 140)],
      }),
    }));
    const { service } = makeService(lifecycle, makeFakeForumInference(complete), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(proposeAction).toHaveBeenCalledTimes(1);
    expect(proposeAction.mock.calls[0][1]).toMatchObject({ qty: 1, optionLeg: { strike: 145 } });
    // Every candidate is sized to what is really free — no contract is offered that the floor would reject.
    expect(result.candidates.every((candidate) => candidate.strike * candidate.contracts * 100 <= 15_000)).toBe(true);
    // And the agent reasons from the free number, never from the balance the broker is already holding.
    const payload = JSON.parse(complete.mock.calls[0][0].messages[0].content.split('Candidates:\n')[1]);
    expect(payload.cash).toBe(15_000);
  });

  it('drops a hallucinated candidate id and only proposes what the persona actually selected', async () => {
    const { lifecycle, proposeAction } = makeFakeLifecycle({ chain: putChain, lastPrice: 150 });
    const mandate = makeMandate();
    const chosen = buildOccSymbol('AAPL', friday, 'put', 145);
    const complete = jest.fn(async () => ({
      usedAi: true,
      provider: 'openrouter',
      model: 'test-model',
      text: JSON.stringify({
        select: [chosen, 'AAPL999999P00999000'],
        rationale: { [chosen]: 'Strong conviction, harvest premium.' },
      }),
    }));
    const { service } = makeService(lifecycle, makeFakeForumInference(complete), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.usedAi).toBe(true);
    expect(result.selected).toEqual([chosen]);
    expect(proposeAction).toHaveBeenCalledTimes(1);
    expect(proposeAction.mock.calls[0][1].rationale).toBe('Strong conviction, harvest premium.');
  });

  it('never loosens the account-wide control ceiling — the mandate can only narrow it', async () => {
    // The control forbids anything past 10 DTE, so the mandate's own 100-day window buys it nothing: the
    // only listed expiry it may trade is the near one.
    const near = nextFriday(7);
    const far = nextFriday(30);
    const chain = [
      listedContract({ underlying: 'AAPL', expiration: near, right: 'put', strike: 150, bid: 3.2, delta: -0.5 }),
      listedContract({ underlying: 'AAPL', expiration: near, right: 'put', strike: 145, bid: 1.2, delta: -0.18 }),
      listedContract({ underlying: 'AAPL', expiration: far, right: 'put', strike: 150, bid: 6.1, delta: -0.5 }),
      listedContract({ underlying: 'AAPL', expiration: far, right: 'put', strike: 145, bid: 3.4, delta: -0.3 }),
    ];
    const { lifecycle } = makeFakeLifecycle({ chain, lastPrice: 150, limits: { maxDaysToExpiry: 10 } });
    const mandate = makeMandate({
      optionStrategy: {
        targetUnderlyings: ['AAPL'],
        minDaysToExpiry: 7,
        maxDaysToExpiry: 100,
        requireOtm: true,
        maxAbsDelta: null,
      },
    });
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.expiration === near)).toBe(true);
    expect(result.candidates.every((c) => c.daysToExpiry <= 11)).toBe(true);
  });

  it('returns an empty result with a clear narrative when nothing is eligible', async () => {
    const { lifecycle } = makeFakeLifecycle({ positions: [], account: { cash: 0 }, chain: putChain, lastPrice: 150 });
    const mandate = makeMandate();
    const { service } = makeService(lifecycle, makeFakeForumInference(localFallback()), [mandate]);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.candidates).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.narrative).toMatch(/No eligible/i);
  });
});

// ── H15 · the desk agent reads the creators' calls ──────────────────────────────────────────────────
describe('AlpacaMandateService.dryRun — creator signals (H15)', () => {
  const friday = nextFriday(10);
  // MSFT is NOT in the mandate's targets — the only reason the desk looks at it is a creator's call.
  const msftChain = [
    listedContract({ underlying: 'MSFT', expiration: friday, right: 'put', strike: 400, bid: 6.0, delta: -0.5 }),
    listedContract({ underlying: 'MSFT', expiration: friday, right: 'put', strike: 380, bid: 2.4, delta: -0.22 }),
  ];
  const aaplChain = [
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 150, bid: 3.6, delta: -0.5 }),
    listedContract({ underlying: 'AAPL', expiration: friday, right: 'put', strike: 145, bid: 1.8, delta: -0.24 }),
  ];
  // One fake feed serving both chains, priced per underlying.
  const priceOf = (symbol: string) => (symbol === 'MSFT' ? 400 : 150);

  function makeMultiFeed(briefs: OpenSignalBrief[], complete: jest.Mock) {
    const { lifecycle, proposeAction, client } = makeFakeLifecycle({
      chain: [...msftChain, ...aaplChain],
      account: { cash: 120_000 },
    });
    (client.getLatestTrade as jest.Mock).mockImplementation(async (symbol: string) => ({
      symbol,
      price: priceOf(symbol),
      asOf: null,
    }));
    const mandate = makeMandate();
    const fakeSignals = makeFakeSignals(briefs);
    const { service } = makeService(lifecycle, makeFakeForumInference(complete), [mandate], fakeSignals.signals);
    return {
      service,
      mandate,
      proposeAction,
      markSignalsActed: fakeSignals.markSignalsActed,
      markSignalsDeclined: fakeSignals.markSignalsDeclined,
    };
  }

  it('widens the candidate universe to a bullish call on a ticker the mandate never named', async () => {
    const { service, mandate } = makeMultiFeed([makeBrief()], localFallback());

    const result = await service.dryRun(USER, mandate.id);

    // The desk looked at MSFT only because a creator called it, and the contract it found is a real one.
    const csp = result.candidates.find((c) => c.underlying === 'MSFT');
    expect(csp).toBeDefined();
    expect(msftChain.some((q) => q.occSymbol === csp!.occSymbol)).toBe(true);
    expect(csp!.strike).toBe(380);
    // The mandate's own target is still evaluated — a creator's call adds to the universe, never replaces it.
    expect(result.candidates.some((c) => c.underlying === 'AAPL')).toBe(true);
    expect(result.openSignals).toHaveLength(1);
  });

  it('shows a bearish call to the agent but never opens a candidate on it', async () => {
    const { service, mandate } = makeMultiFeed([makeBrief({ direction: 'bearish' })], localFallback());

    const result = await service.dryRun(USER, mandate.id);

    // The desk only sells cash-secured puts, so a bearish call is context, never a trade (plan H0).
    expect(result.candidates.some((c) => c.underlying === 'MSFT')).toBe(false);
    expect(result.openSignals.map((brief) => brief.ticker)).toEqual(['MSFT']);
  });

  it("hides a call on a ticker the owner's control list excludes", async () => {
    const { lifecycle } = makeFakeLifecycle({
      chain: [...msftChain, ...aaplChain],
      lastPrice: 150,
      account: { cash: 120_000 },
      limits: { symbolAllowList: ['AAPL'] },
    });
    const mandate = makeMandate();
    const { service } = makeService(
      lifecycle,
      makeFakeForumInference(localFallback()),
      [mandate],
      makeFakeSignals([makeBrief()]).signals,
    );

    const result = await service.dryRun(USER, mandate.id);

    // The allow-list is a ceiling on attention as well as on trading.
    expect(result.openSignals).toEqual([]);
    expect(result.candidates.every((c) => c.underlying === 'AAPL')).toBe(true);
  });

  it('records the calls the agent cited on the action and flips those signals to acted', async () => {
    const brief = makeBrief();
    const chosen = buildOccSymbol('MSFT', friday, 'put', 380);
    const complete = jest.fn(async () => ({
      usedAi: true,
      provider: 'openrouter',
      model: 'test-model',
      text: JSON.stringify({
        select: [chosen],
        rationale: { [chosen]: "Carlson's Azure argument holds and the strike sits below his own entry." },
        signals: { [chosen]: [brief.signalId] },
      }),
    }));
    const { service, mandate, proposeAction, markSignalsActed } = makeMultiFeed([brief], complete);

    const result = await service.dryRun(USER, mandate.id);

    expect(result.selected).toEqual([chosen]);
    const proposal = proposeAction.mock.calls.find(([, input]) => input.symbol === 'MSFT');
    expect(proposal![1].signalIds).toEqual([brief.signalId]);
    expect(markSignalsActed).toHaveBeenCalledWith(USER, [brief.signalId], 'TST_ACTION_MSFT');
  });

  it('drops a citation that names a call about a different underlying', async () => {
    // The creator's call is on MSFT; the agent cites it on an AAPL contract. That is not provenance.
    const brief = makeBrief();
    const aaplContract = buildOccSymbol('AAPL', friday, 'put', 145);
    const complete = jest.fn(async () => ({
      usedAi: true,
      provider: 'openrouter',
      model: 'test-model',
      text: JSON.stringify({
        select: [aaplContract],
        rationale: { [aaplContract]: 'Premium is worth it.' },
        signals: { [aaplContract]: [brief.signalId, 'ASG_hallucinated_00001'] },
      }),
    }));
    const { service, mandate, proposeAction, markSignalsActed } = makeMultiFeed([brief], complete);

    await service.dryRun(USER, mandate.id);

    const proposal = proposeAction.mock.calls.find(([, input]) => input.symbol === 'AAPL');
    expect(proposal![1].signalIds).toEqual([]);
    expect(markSignalsActed).not.toHaveBeenCalled();
  });

  it('reports the calls the agent passed on, in its own words', async () => {
    const brief = makeBrief();
    const complete = jest.fn(async () => ({
      usedAi: true,
      provider: 'openrouter',
      model: 'test-model',
      text: JSON.stringify({
        select: [],
        declined: { [brief.signalId]: 'No graded record yet and the thesis rests on one quarter.' },
      }),
    }));
    const { service, mandate, proposeAction, markSignalsDeclined } = makeMultiFeed([brief], complete);

    const result = await service.dryRun(USER, mandate.id);

    expect(proposeAction).not.toHaveBeenCalled();
    expect(result.declinedSignals).toEqual([
      {
        signalId: brief.signalId,
        ticker: 'MSFT',
        creator: 'Joseph Carlson',
        reason: 'No graded record yet and the thesis rests on one quarter.',
      },
    ]);
    // H7 — and the verdict is written down, so it survives the cycle that reached it.
    expect(markSignalsDeclined).toHaveBeenCalledWith(USER, [
      { signalId: brief.signalId, reason: 'No graded record yet and the thesis rests on one quarter.' },
    ]);
  });

  it('cites nothing when no live provider answered — the fallback read no creator at all', async () => {
    const { service, mandate, proposeAction, markSignalsActed } = makeMultiFeed([makeBrief()], localFallback());

    await service.dryRun(USER, mandate.id);

    expect(proposeAction.mock.calls.every(([, input]) => input.signalIds.length === 0)).toBe(true);
    expect(markSignalsActed).not.toHaveBeenCalled();
  });
});
