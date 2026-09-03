import type { PredictionLedgerService } from '~/api/user/prediction_ledger/prediction_ledger.service';
import type { SourcePortfolioService } from '~/api/user/target_engine/source_portfolio.service';
import type { EntityService } from '~/entity/entity.service';
import type { EntityVersionService } from '~/entity_version/entity_version.service';
import type { AlpacaChannelService } from '../alpaca_channel.service';
import type { AlpacaLifecycleService } from '../alpaca_lifecycle.service';
import type { AlpacaMandateService } from '../alpaca_mandate.service';
import { AlpacaPublicDeskService, DESK_CACHE_MS } from '../alpaca_public_desk.service';
import type { AlpacaSignalService } from '../alpaca_signal.service';

/**
 * H7 — what the judge page is allowed to say, and what it must never leak.
 *
 * The interesting assertions here are negative: this is the one Alpaca read with no session behind it, so
 * the tests pin the *shape* of the projection (broker handles absent, no write path, no per-position rows)
 * as hard as they pin its content.
 */

const OWNER = 'USR_owner000000000000000';
const MANDATE_ID = 'AMN_mandate0000000000001';
const CHANNEL_ID = 'UCabcdefghijklmnopqrstu';

const CSP_INSTRUMENT = {
  assetClass: 'option' as const,
  underlying: 'QQQ',
  occSymbol: 'QQQ260911P00560000',
  expiration: '2026-09-11',
  strike: 560,
  right: 'put' as const,
  multiplier: 100,
  positionIntent: 'sell_to_open' as const,
};

function makeAction(overrides: { body?: Record<string, any>; id?: string } = {}) {
  return {
    id: overrides.id ?? 'AAC_action00000000000001',
    type: 'alpaca_action',
    owner_id: OWNER,
    status: 'active',
    header: {
      owner_user_id: OWNER,
      environment: 'paper',
      status: 'reconciled',
      last_activity_at: '2026-09-03T13:20:00.000Z',
    },
    body: {
      environment: 'paper',
      status: 'reconciled',
      mandateId: MANDATE_ID,
      symbol: 'QQQ',
      side: 'sell',
      orderType: 'limit',
      qty: 1,
      notional: null,
      limitPrice: 3.4,
      timeInForce: 'day',
      rationale: 'The 560 put is 4% out of the money on a 8-day contract.',
      signalIds: ['ASG_signal00000000000001'],
      predictionId: 'PRD_claim000000000000001',
      clearedLimits: [{ limit: 'defined_risk_floor', passed: true, detail: '$56,000.00 reserved' }],
      approval: { decision: 'approved', decidedAt: '2026-09-03T13:19:00.000Z', decidedBy: OWNER },
      instrument: CSP_INSTRUMENT,
      clientOrderId: 'AAC_action00000000000001',
      alpacaOrderId: 'e1f0c2a8-0000-4000-8000-000000000000',
      fills: [{ qty: 1, price: 3.4, filledAt: '2026-09-03T13:20:00.000Z' }],
      events: [{ at: '2026-09-03T13:18:00.000Z', status: 'proposed', message: 'Cleared 21 ceilings.' }],
      execution: {
        via: 'cli',
        cliVersion: 'alpaca 0.4.1',
        submit: {
          at: '2026-09-03T13:19:30.000Z',
          command: 'alpaca order submit --symbol QQQ260911P00560000',
          response: {},
        },
      },
      errorMessage: null,
      optionOutcome: null,
      ...overrides.body,
    },
  } as any;
}

function makeSignal(overrides: { id?: string; body?: Record<string, any> } = {}) {
  return {
    id: overrides.id ?? 'ASG_signal00000000000001',
    type: 'alpaca_signal',
    owner_id: OWNER,
    status: 'active',
    header: {
      owner_user_id: OWNER,
      environment: 'paper',
      channel_id: CHANNEL_ID,
      video_id: 'vid1',
      ticker: 'NVDA',
      signal_status: 'open',
    },
    body: {
      environment: 'paper',
      channelEntityId: 'ACH_channel0000000000001',
      channelId: CHANNEL_ID,
      channelTitle: 'Joseph Carlson',
      videoId: 'vid1',
      videoTitle: 'Why I am buying NVDA',
      publishedAt: '2026-09-01T12:00:00.000Z',
      ticker: 'NVDA',
      direction: 'bullish',
      thesis: 'Data-centre demand is not slowing.',
      horizonDays: 30,
      confidence: 0.7,
      quote: 'I am adding to NVDA here and I think it works over the next month.',
      timestampSec: 412,
      sourceRef: 'https://www.youtube.com/watch?v=vid1&t=412s',
      referencePrice: 180.2,
      falsifiableCondition: 'NVDA is higher 30 days from now.',
      resolveBy: '2026-10-01T12:00:00.000Z',
      predictionId: 'PRD_claim000000000000002',
      status: 'open',
      actedActionId: null,
      extractedAt: '2026-09-03T06:00:00.000Z',
      provider: 'openrouter',
      model: 'z-ai/glm-5.3-flash',
      ...overrides.body,
    },
  } as any;
}

const MANDATE = {
  id: MANDATE_ID,
  type: 'alpaca_mandate',
  owner_id: OWNER,
  status: 'active',
  updated_at: '2026-09-03T10:00:00.000Z',
  header: { owner_user_id: OWNER, environment: 'paper', status: 'active', promotion_state: 'sandbox' },
  body: {
    environment: 'paper',
    name: 'Friday Income Desk',
    mandate: 'Sell weekly cash-secured puts on SPY, QQQ and IWM, never inside earnings.',
    provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash',
    status: 'active',
    promotionState: 'sandbox',
    promotedFromMandateId: null,
    optionStrategy: {
      targetUnderlyings: ['SPY', 'QQQ', 'IWM'],
      minDaysToExpiry: 5,
      maxDaysToExpiry: 14,
      requireOtm: true,
      maxAbsDelta: 0.25,
    },
  },
} as any;

const CHANNEL = {
  id: 'ACH_channel0000000000001',
  type: 'alpaca_channel',
  owner_id: OWNER,
  status: 'active',
  created_at: '2026-09-03T05:00:00.000Z',
  header: { owner_user_id: OWNER, environment: 'paper', status: 'active', channel_id: CHANNEL_ID },
  body: {
    environment: 'paper',
    url: 'https://www.youtube.com/@josephcarlson',
    channelId: CHANNEL_ID,
    title: 'Joseph Carlson',
    videos: [],
    lastRefreshedAt: '2026-09-03T05:00:00.000Z',
  },
} as any;

function build(
  options: {
    actions?: any[];
    signals?: any[];
    mandates?: any[];
    channels?: any[];
    sources?: Array<{ id: string; body: { name: string } }>;
    predictions?: any[];
  } = {},
) {
  const readAccount = jest.fn(async () => ({
    kind: 'paper' as const,
    environment: 'paper' as const,
    account: {
      cash: 100_000,
      buyingPower: 100_000,
      equity: 103_420.5,
      portfolioValue: 103_420.5,
      currency: 'USD',
      optionsBuyingPower: 100_000,
    },
    positions: [
      {
        symbol: 'QQQ260911P00560000',
        qty: -1,
        side: 'short',
        avgEntryPrice: 3.4,
        marketValue: -210,
        unrealizedPl: 130,
      },
      {
        symbol: 'IWM260908P00290000',
        qty: -1,
        side: 'short',
        avgEntryPrice: 2.1,
        marketValue: -180,
        unrealizedPl: 30.005,
      },
    ],
    clock: { isOpen: true, nextOpen: null, nextClose: '2026-09-03T20:00:00.000Z' },
  }));
  const lifecycle = {
    readAccount,
    getControl: jest.fn(async () => ({
      killState: 'armed' as const,
      mode: 'paper' as const,
      liveArmed: false,
      executionGate: 'fully_autonomous' as const,
      limits: { symbolAllowList: ['SPY'] } as any,
    })),
    listActions: jest.fn(async () => options.actions ?? [makeAction()]),
  } as unknown as AlpacaLifecycleService;

  const entityService = {
    findMany: jest.fn(async () => [{ id: OWNER }]),
  } as unknown as EntityService;

  const entityVersions = {
    getVersions: jest.fn(async () => [{ version: 1 }, { version: 2 }, { version: 3 }]),
  } as unknown as EntityVersionService;

  const mandates = { list: jest.fn(async () => options.mandates ?? [MANDATE]) } as unknown as AlpacaMandateService;
  const signals = {
    listSignals: jest.fn(async () => options.signals ?? [makeSignal()]),
  } as unknown as AlpacaSignalService;
  const channels = {
    listChannels: jest.fn(async () => options.channels ?? [CHANNEL]),
  } as unknown as AlpacaChannelService;

  const sourceRows =
    options.sources ??
    ([
      { id: 'SPT_desk0000000000000001', body: { name: 'MANDATE desk · Friday Income Desk' } },
      { id: 'SPT_creator00000000000001', body: { name: 'Joseph Carlson (YouTube)' } },
    ] as Array<{ id: string; body: { name: string } }>);
  const sourcePortfolios = {
    listSourcePortfolios: jest.fn(async () => sourceRows),
  } as unknown as SourcePortfolioService;

  const predictions = {
    getManagerScorecard: jest.fn(async (_owner: string, sourcePortfolioId: string) => ({
      sourcePortfolioId,
      noResolvedPredictions: false,
      claimTypes: [
        {
          claimType: 'market_timing',
          openCount: 2,
          resolvedCount: 9,
          outcomeCounts: { superseded: 1 } as any,
          hitRate: { sampleSize: 9, count: 6, percentage: 67 },
          unfalsifiableRate: { sampleSize: 9, count: 0, percentage: 0 },
          timingBias: { rightButLateCount: 0, rightOnTimeCount: 6 },
        },
        {
          claimType: 'stock_selection',
          openCount: 0,
          resolvedCount: 0,
          outcomeCounts: {} as any,
          hitRate: { sampleSize: 0, count: 0, percentage: null },
          unfalsifiableRate: { sampleSize: 0, count: 0, percentage: null },
          timingBias: { rightButLateCount: 0, rightOnTimeCount: 0 },
        },
      ],
      narrationDigest: { total: 0, returned: 0, truncated: false, entries: [] },
    })),
    listPredictions: jest.fn(
      async () => options.predictions ?? [{ status: 'due' }, { status: 'open' }, { status: 'resolved' }],
    ),
  } as unknown as PredictionLedgerService;

  const service = new AlpacaPublicDeskService(
    entityService,
    entityVersions,
    lifecycle,
    mandates,
    signals,
    channels,
    sourcePortfolios,
    predictions,
  );
  return { service, lifecycle, readAccount, entityVersions, predictions, sourcePortfolios };
}

describe('AlpacaPublicDeskService — the judge projection (H7)', () => {
  it('describes the mandate, the gate and the live paper figures', async () => {
    const { service } = await build();

    const desk = await service.getDesk();

    expect(desk.environment).toBe('paper');
    expect(desk.mandate).toEqual({
      name: 'Friday Income Desk',
      text: 'Sell weekly cash-secured puts on SPY, QQQ and IWM, never inside earnings.',
      status: 'active',
      provider: 'openrouter',
      model: 'z-ai/glm-5.3-flash',
      versionCount: 3,
      bounds: MANDATE.body.optionStrategy,
    });
    expect(desk.control).toEqual({ executionGate: 'fully_autonomous', killState: 'armed', mode: 'paper' });
    expect(desk.account.equity).toBe(103_420.5);
    // Summed across open positions and rounded — a P&L reading `160.005` is noise, not precision.
    expect(desk.account.unrealizedPl).toBe(160.01);
    expect(desk.account.openPositions).toBe(2);
    expect(Date.parse(desk.generatedAt)).not.toBeNaN();
  });

  it('reports no mandate rather than passing a draft off as one that governs', async () => {
    const { service } = await build({
      mandates: [{ ...MANDATE, body: { ...MANDATE.body, status: 'draft' } }],
    });

    const desk = await service.getDesk();

    expect(desk.mandate).toBeNull();
    // …and with no desk name there is no desk ledger source, so only the creators are scored.
    expect(desk.scorecards.map((card) => card.kind)).toEqual(['creator']);
  });

  it('carries a proposal with its ceilings, timeline and CLI provenance — and no broker handles', async () => {
    const { service } = await build();

    const [action] = (await service.getDesk()).actions;

    expect(action.clearedLimits).toHaveLength(1);
    expect(action.events).toHaveLength(1);
    expect(action.rationale).toContain('out of the money');
    expect(action.instrument?.occSymbol).toBe('QQQ260911P00560000');
    expect(action.execution).toEqual({
      via: 'cli',
      cliVersion: 'alpaca 0.4.1',
      submitCommand: 'alpaca order submit --symbol QQQ260911P00560000',
      dryRunCommand: null,
    });
    expect(action.predictionId).toBe('PRD_claim000000000000001');
    expect(action.citedSignalCount).toBe(1);
    // The clamp: broker handles, fills and the approving user never reach a public page.
    const serialized = JSON.stringify(action);
    expect(serialized).not.toContain('alpacaOrderId');
    expect(serialized).not.toContain('clientOrderId');
    expect(serialized).not.toContain('e1f0c2a8');
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain('fills');
  });

  it('never reports a refused order as sent — a dry-run receipt is kept as its own field', async () => {
    const { service } = await build({
      actions: [
        makeAction({
          body: {
            status: 'failed',
            errorMessage: 'Alpaca CLI error (HTTP 403): insufficient options buying power',
            execution: {
              via: 'cli',
              cliVersion: 'alpaca 0.4.1',
              dryRun: { at: '2026-09-03T13:19:00.000Z', command: 'alpaca order submit … --dry-run', requestBody: {} },
            },
          },
        }),
      ],
    });

    const [action] = (await service.getDesk()).actions;

    expect(action.execution).toEqual({
      via: 'cli',
      cliVersion: 'alpaca 0.4.1',
      submitCommand: null,
      dryRunCommand: 'alpaca order submit … --dry-run',
    });
  });

  it("groups the creators' calls by channel and states the agent's verdict on each", async () => {
    const { service } = await build({
      signals: [
        makeSignal({
          id: 'ASG_acted000000000000001',
          body: { status: 'acted', actedActionId: 'AAC_a0000000000000000001' },
        }),
        makeSignal({
          id: 'ASG_declined00000000001',
          body: {
            ticker: 'MSFT',
            lastDeclineReason: 'Neutral MSFT call is a wait signal, not a bullish call.',
            lastDeclinedAt: '2026-09-03T13:18:00.000Z',
          },
        }),
        makeSignal({ id: 'ASG_open00000000000001', body: { ticker: 'META' } }),
      ],
    });

    const [channel] = (await service.getDesk()).channels;

    expect(channel.creator).toBe('Joseph Carlson');
    expect(channel.url).toBe('https://www.youtube.com/@josephcarlson');
    expect(channel.signals.map((signal) => signal.verdict)).toEqual([
      { kind: 'acted', actionId: 'AAC_a0000000000000000001' },
      {
        kind: 'declined',
        reason: 'Neutral MSFT call is a wait signal, not a bullish call.',
        at: '2026-09-03T13:18:00.000Z',
      },
      { kind: 'open' },
    ]);
    expect(channel.signals[0].quote).toContain('adding to NVDA');
    expect(channel.signals[0].onLedger).toBe(true);
  });

  it('scores the desk first, and reports an unclaimed name as an empty card, never a zero', async () => {
    const { service } = await build({
      sources: [{ id: 'SPT_desk0000000000000001', body: { name: 'MANDATE desk · Friday Income Desk' } }],
    });

    const [desk, creator] = (await service.getDesk()).scorecards;

    expect(desk).toEqual({
      kind: 'desk',
      label: 'MANDATE desk',
      // Only claim types this claimant touched; the honesty line (`percentage: null`) is the ledger's.
      claimTypes: [
        {
          claimType: 'market_timing',
          openCount: 2,
          resolvedCount: 9,
          retractedCount: 1,
          hitRate: { sampleSize: 9, count: 6, percentage: 67 },
        },
      ],
      dueCount: 1,
      totalCount: 3,
    });
    // The creator has no ledger source yet — nothing claimed in his name is not a score of zero.
    expect(creator).toEqual({ kind: 'creator', label: 'Joseph Carlson', claimTypes: [], dueCount: 0, totalCount: 0 });
  });

  it('keeps a claim type whose every claim was withdrawn, rather than reporting it as nothing', async () => {
    const { service, predictions } = await build();
    (predictions.getManagerScorecard as jest.Mock).mockImplementation(
      async (_owner: string, sourcePortfolioId: string) => ({
        sourcePortfolioId,
        noResolvedPredictions: true,
        claimTypes: [
          {
            claimType: 'market_timing',
            openCount: 0,
            resolvedCount: 0,
            outcomeCounts: { superseded: 3 } as any,
            hitRate: { sampleSize: 0, count: 0, percentage: null },
            unfalsifiableRate: { sampleSize: 0, count: 0, percentage: null },
            timingBias: { rightButLateCount: 0, rightOnTimeCount: 0 },
          },
        ],
        narrationDigest: { total: 0, returned: 0, truncated: false, entries: [] },
      }),
    );

    const [desk] = (await service.getDesk()).scorecards;

    // The desk retracts a claim whose order never reached the market (H16). Filtering the row out would
    // print "nothing on the record" next to a total that says three.
    expect(desk.claimTypes).toEqual([
      {
        claimType: 'market_timing',
        openCount: 0,
        resolvedCount: 0,
        retractedCount: 3,
        hitRate: { sampleSize: 0, count: 0, percentage: null },
      },
    ]);
  });

  it('serves a memoized projection so a polling page never hammers the broker', async () => {
    const { service, readAccount } = await build();

    const [first, second] = await Promise.all([service.getDesk(), service.getDesk()]);
    await service.getDesk();

    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('reads the broker again once the memo has expired', async () => {
    const { service, readAccount } = await build();
    await service.getDesk();

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + DESK_CACHE_MS + 1);
    await service.getDesk();

    expect(readAccount).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('still renders when the mandate has no readable version history', async () => {
    const { service, entityVersions } = await build();
    (entityVersions.getVersions as jest.Mock).mockRejectedValueOnce(new Error('version store unavailable'));

    const desk = await service.getDesk();

    expect(desk.mandate?.versionCount).toBe(0);
    expect(desk.mandate?.name).toBe('Friday Income Desk');
  });
});
