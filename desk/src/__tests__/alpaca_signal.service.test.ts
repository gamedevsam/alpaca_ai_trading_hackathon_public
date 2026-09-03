import { entity_alpaca_channel, entity_alpaca_signal } from '#schema_registry';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { dirname, join } from 'node:path';
import { CUSTOM_SCHEMA_KEYWORDS } from '~/api/admin/schema/lib/ajv';
import { EntityService } from '~/entity/entity.service';
import type { ForumInferenceService } from '~/api/forum/forum_inference.service';
import type { PredictionLedgerService } from '~/api/user/prediction_ledger/prediction_ledger.service';
import type { SourcePortfolioService } from '~/api/user/target_engine/source_portfolio.service';
import { AlpacaChannelService } from '../alpaca_channel.service';
import { AlpacaSignalService, channelSourceName, SignalProviderUnavailableError } from '../alpaca_signal.service';
import type { AlpacaLifecycleService } from '../alpaca_lifecycle.service';
import { LocalTranscriptSource, TranscriptSource } from '../transcript_source';

const CARLSON_CORPUS = join(dirname(__dirname), '../../../../shared/data/joseph_carlson');
const OWNER = 'USR_owner000000000000000';
const CHANNEL_ID = 'JosephCarlsonShow';

function compileValidator(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv, ['date-time']);
  for (const keyword of CUSTOM_SCHEMA_KEYWORDS) {
    ajv.addKeyword(keyword);
  }
  return ajv.compile(schema);
}
const validateSignal = compileValidator(entity_alpaca_signal as object);

/** In-memory EntityService covering exactly what the signal + channel services call. */
function makeEntityService(seed: Array<Record<string, any>> = []) {
  const store = new Map<string, any>(seed.map((entity) => [entity.id, structuredClone(entity)]));
  let counter = 0;
  const matches = (entity: any, where: Record<string, any>) =>
    Object.entries(where ?? {}).every(([key, value]) => {
      // The header-path form the services use for indexed filters.
      if (key === 'header' && value && typeof value === 'object' && 'path' in value) {
        return entity.header?.[(value as any).path[0]] === (value as any).equals;
      }
      return entity[key] === value;
    });

  return {
    findMany: jest.fn(async ({ where }: any) => [...store.values()].filter((entity) => matches(entity, where))),
    findFirst: jest.fn(async ({ where }: any) => [...store.values()].find((entity) => matches(entity, where)) ?? null),
    findById: jest.fn(async (id: string) => store.get(id) ?? null),
    upsert: jest.fn(async (entity: any) => {
      const saved = {
        ...structuredClone(entity),
        // Ids are 24 characters, like the real ones — the schema check below is worthless otherwise.
        id: entity.id ?? `${entity.type === 'alpaca_signal' ? 'ASG' : 'ACH'}_${String(counter++).padStart(20, '0')}`,
        // The real EntityService stamps the lifecycle status on insert; reads filter on it.
        status: entity.status ?? 'active',
        created_at: new Date(Date.now() + counter).toISOString(),
      };
      store.set(saved.id, saved);
      return structuredClone(saved);
    }),
    update: jest.fn(async (entity: any, producer: (draft: any) => void) => {
      const draft = structuredClone(store.get(entity.id) ?? entity);
      producer(draft);
      store.set(draft.id, draft);
      return structuredClone(draft);
    }),
    __store: store,
  } as unknown as EntityService & { __store: Map<string, any> };
}

/**
 * An honest model: it quotes the transcript it was actually given, character for character, plus one
 * fabricated call so every run also exercises the drop path.
 */
function honestInference(overrides: { usedAi?: boolean; extraSignals?: unknown[] } = {}) {
  return {
    complete: jest.fn(async ({ messages }: any) => {
      const prompt: string = messages[0].content;
      const transcript = prompt.slice(prompt.indexOf('Transcript:\n') + 'Transcript:\n'.length);
      const quote = transcript.slice(200, 320);
      return {
        usedAi: overrides.usedAi ?? true,
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        text: JSON.stringify({
          signals: [
            {
              ticker: 'AAPL',
              direction: 'bullish',
              thesis: 'Services revenue keeps compounding',
              horizonDays: 180,
              confidence: 0.8,
              quote,
            },
            {
              ticker: 'NVDA',
              direction: 'bullish',
              thesis: 'Fabricated — this quote is nowhere in the transcript',
              horizonDays: 90,
              confidence: 0.9,
              quote: 'NVDA is a guaranteed triple from here and I would bet the whole account on it today',
            },
            ...(overrides.extraSignals ?? []),
          ],
        }),
      };
    }),
  } as unknown as ForumInferenceService;
}

function makeLedger(hitRate: { sampleSize: number; count: number; percentage: number | null } | null = null) {
  let counter = 0;
  return {
    logPrediction: jest.fn(async (_owner: string, input: any) => ({
      prediction: { id: `PRE_generated00000000000${counter++}`, body: { ...input } },
      deduped: false,
    })),
    getManagerScorecard: jest.fn(async (_owner: string, sourcePortfolioId: string) => ({
      sourcePortfolioId,
      noResolvedPredictions: !hitRate,
      claimTypes: [
        {
          claimType: 'stock_selection',
          openCount: 0,
          resolvedCount: hitRate?.sampleSize ?? 0,
          outcomeCounts: {},
          hitRate: hitRate ?? { sampleSize: 0, count: 0, percentage: null },
          unfalsifiableRate: { sampleSize: 0, count: 0, percentage: null },
          timingBias: { rightButLateCount: 0, rightOnTimeCount: 0 },
        },
      ],
      narrationDigest: { total: 0, returned: 0, truncated: false, entries: [] },
    })),
  } as unknown as PredictionLedgerService & { logPrediction: jest.Mock; getManagerScorecard: jest.Mock };
}

function makeSourcePortfolios() {
  const created: any[] = [];
  return {
    listSourcePortfolios: jest.fn(async () => created),
    upsertSourcePortfolio: jest.fn(async (_owner: string, params: any) => {
      const saved = { id: `SPT_generated0000000000${created.length}`, body: { ...params } };
      created.push(saved);
      return saved;
    }),
  } as unknown as SourcePortfolioService & { upsertSourcePortfolio: jest.Mock; listSourcePortfolios: jest.Mock };
}

function makeLifecycle(price: number | null = 231.5) {
  return {
    createEnvironmentClient: jest.fn(async () => ({
      getLatestTrade: jest.fn(async () => (price === null ? null : { price, timestamp: '2026-09-03T12:00:00Z' })),
    })),
  } as unknown as AlpacaLifecycleService;
}

/** The service with the cached corpus swapped in for Supadata — the H13 pattern, one layer up. */
class TestSignalService extends AlpacaSignalService {
  constructor(
    entityService: EntityService,
    channels: AlpacaChannelService,
    inference: ForumInferenceService,
    predictions: PredictionLedgerService,
    sources: SourcePortfolioService,
    lifecycle: AlpacaLifecycleService,
    private readonly source: TranscriptSource = new LocalTranscriptSource(CARLSON_CORPUS),
  ) {
    super(entityService, channels, inference, predictions, sources, lifecycle);
  }
  protected transcriptSource(): TranscriptSource {
    return this.source;
  }
}

/** A followed channel seeded with three REAL videos from the committed corpus. */
async function seedChannel(videoCount = 3) {
  const source = new LocalTranscriptSource(CARLSON_CORPUS);
  const videoIds = await source.listVideos(CHANNEL_ID, videoCount);
  const videos = await Promise.all(
    videoIds.map(async (videoId) => {
      const video = await source.getVideo(videoId);
      return {
        videoId,
        title: video!.title,
        publishedAt: video!.publishedAt,
        durationSec: video!.durationSec,
        extractedAt: null,
      };
    }),
  );
  return entity_alpaca_channel.new({
    id: 'ACH_seeded00000000000000',
    owner_id: OWNER,
    header: { owner_user_id: OWNER, environment: 'paper', status: 'active', channel_id: CHANNEL_ID },
    body: {
      environment: 'paper',
      url: `https://www.youtube.com/@${CHANNEL_ID}`,
      channelId: CHANNEL_ID,
      title: 'Joseph Carlson',
      videos,
      lastRefreshedAt: '2026-09-03T05:00:00.000Z',
    },
  }) as Record<string, any>;
}

/** An action the broker refused — the H16 case: a proposal that cleared every ceiling and still died. */
const FAILED_ACTION = {
  id: 'AAC_failed00000000000001',
  type: 'alpaca_action',
  owner_id: OWNER,
  status: 'active',
  body: { environment: 'paper', status: 'failed', symbol: 'META' },
};

/** Drop `alpaca_action` rows straight into the shared store — the signal service only ever reads them. */
function seedActions(entityService: EntityService & { __store: Map<string, any> }, actions: any[]) {
  for (const action of actions) {
    entityService.__store.set(action.id, structuredClone(action));
  }
}

function build(
  options: {
    usedAi?: boolean;
    price?: number | null;
    videoCount?: number;
    hitRate?: { sampleSize: number; count: number; percentage: number | null } | null;
  } = {},
) {
  return (async () => {
    const channelEntity = await seedChannel(options.videoCount ?? 3);
    const entityService = makeEntityService([{ ...channelEntity, status: 'active' }]);
    const channels = new AlpacaChannelService(entityService);
    const inference = honestInference({ usedAi: options.usedAi });
    const ledger = makeLedger(options.hitRate ?? null);
    const sources = makeSourcePortfolios();
    const service = new TestSignalService(
      entityService,
      channels,
      inference,
      ledger,
      sources,
      makeLifecycle(options.price === undefined ? 231.5 : options.price),
    );
    return { service, entityService, channels, inference, ledger, sources, channelEntity };
  })();
}

describe('AlpacaSignalService — extraction (H14 acceptance)', () => {
  it('turns three cached videos into signals with verbatim quotes, each carrying a predictionId', async () => {
    const { service, entityService, ledger } = await build();

    const result = await service.extractSignals(OWNER, { limit: 3 });

    expect(result.videosRead).toBe(3);
    expect(result.signalsCreated).toBe(3);
    expect(result.provider).toBe('openrouter');
    expect(result.videos.map((video) => video.outcome)).toEqual(['extracted', 'extracted', 'extracted']);

    const signals = await service.listSignals(OWNER);
    expect(signals).toHaveLength(3);

    const source = new LocalTranscriptSource(CARLSON_CORPUS);
    for (const signal of signals) {
      expectValidSignal(entityService, signal.id);
      expect(signal.body.predictionId).toMatch(/^PRE_/);
      expect(signal.body.status).toBe('open');
      expect(signal.body.ticker).toBe('AAPL');
      // The quote is really in the video it claims to come from.
      const transcript = await source.fetchTranscript(signal.body.videoId);
      expect(transcript!.text).toContain(signal.body.quote);
      expect(signal.body.sourceRef).toContain(signal.body.videoId);
    }

    // Every claim reached the ledger verbatim, with a condition and a horizon.
    expect(ledger.logPrediction).toHaveBeenCalledTimes(3);
    const [, claim] = ledger.logPrediction.mock.calls[0];
    expect(claim).toMatchObject({
      claimType: 'stock_selection',
      verbatim: true,
      conditionAuthor: 'consumer_proposed',
      hedgeLevel: 'low',
      statedHorizon: '180 days',
      tickers: ['AAPL'],
    });
    expect(claim.falsifiableCondition).toContain('AAPL closes above $231.50');
    // Every claim on the ledger is one of the stored verbatim quotes — nothing was paraphrased in between.
    const loggedQuotes = ledger.logPrediction.mock.calls.map(([, logged]: any[]) => logged.claimVerbatim).sort();
    expect(loggedQuotes).toEqual(signals.map((signal) => signal.body.quote).sort());
  });

  it('drops the fabricated call and reports that it did, rather than storing it', async () => {
    const { service } = await build({ videoCount: 1 });
    const result = await service.extractSignals(OWNER, { limit: 1 });

    expect(result.signalsCreated).toBe(1);
    expect(result.videos[0].droppedCount).toBe(1);
    expect(result.videos[0].droppedReasons).toEqual(['quote_not_verbatim']);
    expect((await service.listSignals(OWNER)).map((signal) => signal.body.ticker)).toEqual(['AAPL']);
  });

  it('creates ONE ledger source for the creator, however many of his videos are read', async () => {
    const { service, sources } = await build();
    await service.extractSignals(OWNER, { limit: 3 });

    expect(sources.upsertSourcePortfolio).toHaveBeenCalledTimes(1);
    expect(sources.upsertSourcePortfolio.mock.calls[0][1]).toMatchObject({
      name: channelSourceName('Joseph Carlson'),
      kind: 'tracked_manager',
      // Empty on purpose: what is tracked is what he CLAIMS, never a book invented from a video.
      holdings: [],
    });
  });

  it('marks a video read only once, and never re-extracts it', async () => {
    const { service, entityService } = await build();
    await service.extractSignals(OWNER, { limit: 3 });

    const channel = await entityService.findById<$.AlpacaChannel>('ACH_seeded00000000000000');
    expect(channel!.body.videos.every((video) => video.extractedAt)).toBe(true);

    const second = await service.extractSignals(OWNER, { limit: 3 });
    expect(second.videosRead).toBe(0);
    expect(second.signalsCreated).toBe(0);
  });

  it('leaves a video unread when its transcript is not available, so a later pass retries it', async () => {
    const channelEntity = await seedChannel(1);
    channelEntity.body.videos[0].videoId = 'not_transcribed_video';
    const entityService = makeEntityService([{ ...channelEntity, status: 'active' }]);
    const service = new TestSignalService(
      entityService,
      new AlpacaChannelService(entityService),
      honestInference(),
      makeLedger(),
      makeSourcePortfolios(),
      makeLifecycle(),
    );

    const result = await service.extractSignals(OWNER, { limit: 1 });
    expect(result.videos[0].outcome).toBe('no_transcript');
    expect(result.videosRead).toBe(0);

    const channel = await entityService.findById<$.AlpacaChannel>('ACH_seeded00000000000000');
    expect(channel!.body.videos[0].extractedAt).toBeNull();
  });

  it('fails loudly when the provider is not really answering, instead of reporting "no calls"', async () => {
    const { service, entityService } = await build({ usedAi: false });

    await expect(service.extractSignals(OWNER, { limit: 1 })).rejects.toThrow(SignalProviderUnavailableError);

    // Nothing was recorded, and the video stays unread — the creator is not on record as having said nothing.
    const channel = await entityService.findById<$.AlpacaChannel>('ACH_seeded00000000000000');
    expect(channel!.body.videos.every((video) => video.extractedAt === null)).toBe(true);
  });

  it('still logs a falsifiable claim when the ticker cannot be priced', async () => {
    const { service, ledger } = await build({ price: null, videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });

    const [, claim] = ledger.logPrediction.mock.calls[0];
    expect(claim.falsifiableCondition).toMatch(/AAPL closes above its \d{4}-\d{2}-\d{2} close on \d{4}-\d{2}-\d{2}\./);
  });

  it('flips a signal to acted and remembers which proposal acted on it', async () => {
    const { service } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);

    expect(await service.markSignalsActed(OWNER, [signal.id], 'ACT_proposal000000000000000')).toBe(1);
    const [acted] = await service.listSignals(OWNER, { status: 'acted' });
    expect(acted.body.actedActionId).toBe('ACT_proposal000000000000000');
    expect(await service.listSignals(OWNER, { status: 'open' })).toHaveLength(0);
    // Acting twice is not two acts.
    expect(await service.markSignalsActed(OWNER, [signal.id], 'ACT_other0000000000000000000')).toBe(0);
  });

  // H16 — the live desk marked META and NVDA calls `acted` against orders the broker then refused, so
  // two creator calls were spent on trades that never reached the market and would never be weighed again.
  it('hands a call back when the action that cited it never reached the market', async () => {
    const { service, entityService } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);
    await service.markSignalsActed(OWNER, [signal.id], FAILED_ACTION.id);
    seedActions(entityService, [FAILED_ACTION]);

    const released = await service.releaseSignalsForUnexpressedActions(OWNER, 'paper');

    expect(released).toEqual([
      { signalId: signal.id, ticker: signal.body.ticker, actionId: FAILED_ACTION.id, actionStatus: 'failed' },
    ]);
    const [reopened] = await service.listSignals(OWNER, { status: 'open' });
    expect(reopened.id).toBe(signal.id);
    expect(reopened.body.actedActionId).toBeNull();
    expect(validateSignal(reopened)).toBe(true);
    // Idempotent: the call is open again, so a second sweep finds nothing to give back.
    expect(await service.releaseSignalsForUnexpressedActions(OWNER, 'paper')).toEqual([]);
  });

  it('keeps a call spent when its action reached the market, or when the owner said no', async () => {
    for (const status of ['filled', 'submitted', 'rejected', 'expired'] as const) {
      const { service, entityService } = await build({ videoCount: 1 });
      await service.extractSignals(OWNER, { limit: 1 });
      const [signal] = await service.listSignals(OWNER);
      const action = { ...FAILED_ACTION, body: { ...FAILED_ACTION.body, status } };
      await service.markSignalsActed(OWNER, [signal.id], action.id);
      seedActions(entityService, [action]);

      expect(await service.releaseSignalsForUnexpressedActions(OWNER, 'paper')).toEqual([]);
      expect(await service.listSignals(OWNER, { status: 'acted' })).toHaveLength(1);
    }
  });

  it('leaves a call alone when its action cannot be found at all', async () => {
    const { service } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);
    await service.markSignalsActed(OWNER, [signal.id], 'AAC_vanished0000000001');

    // A missing row is a bookkeeping question — guessing "it must have failed" hands a call back on no
    // evidence, which is exactly the kind of invented fact the ledger exists to prevent.
    expect(await service.releaseSignalsForUnexpressedActions(OWNER, 'paper')).toEqual([]);
    expect(await service.listSignals(OWNER, { status: 'acted' })).toHaveLength(1);
  });

  it("never touches another user's signal", async () => {
    const { service } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);

    expect(await service.markSignalsActed('USR_other000000000000000', [signal.id], 'ACT_x')).toBe(0);
    expect(await service.listSignals('USR_other000000000000000')).toEqual([]);
  });
});

// ── H15 · what the desk agent is shown ──────────────────────────────────────────────────────────────
describe('AlpacaSignalService.openSignalBriefs (H15)', () => {
  it("keeps one call per ticker — the creator's latest word supersedes his last one", async () => {
    // The corpus yields one AAPL call per video, three videos: three open signals, one ticker.
    const { service } = await build();
    await service.extractSignals(OWNER, { limit: 3 });
    expect(await service.listSignals(OWNER, { status: 'open' })).toHaveLength(3);

    const briefs = await service.openSignalBriefs(OWNER);

    expect(briefs).toHaveLength(1);
    expect(briefs[0].ticker).toBe('AAPL');
    expect(briefs[0].creator).toBe('Joseph Carlson');
    // Everything the agent needs to weigh it: the reason, the creator's own words, and when he said them.
    expect(briefs[0].thesis).toBeTruthy();
    expect(briefs[0].quote.length).toBeGreaterThan(0);
    expect(briefs[0].signalId).toMatch(/^ASG_/);
  });

  it('reports an ungraded creator as unproven, never as a zero score', async () => {
    const { service } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });

    const [brief] = await service.openSignalBriefs(OWNER);

    expect(brief.creatorHitRate).toEqual({
      claimType: 'stock_selection',
      sampleSize: 0,
      count: 0,
      percentage: null,
    });
  });

  it("carries the creator's graded record for the claim type once he has one", async () => {
    const { service } = await build({ videoCount: 1, hitRate: { sampleSize: 20, count: 13, percentage: 65 } });
    await service.extractSignals(OWNER, { limit: 1 });

    const [brief] = await service.openSignalBriefs(OWNER);

    expect(brief.creatorHitRate).toEqual({
      claimType: 'stock_selection',
      sampleSize: 20,
      count: 13,
      percentage: 65,
    });
  });

  it('excludes a call whose horizon has already passed, even while its row still reads open', async () => {
    const { service, entityService } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);
    // A lapsed call is a claim for the ledger to grade, never a trade to place today.
    entityService.__store.get(signal.id).body.resolveBy = '2020-01-01T00:00:00.000Z';

    expect(await service.openSignalBriefs(OWNER)).toEqual([]);
    expect(await service.listSignals(OWNER, { status: 'open' })).toHaveLength(1);
  });

  it('shows nothing once the call has been acted on', async () => {
    const { service } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);
    await service.markSignalsActed(OWNER, [signal.id], 'ACT_proposal000000000000000');

    expect(await service.openSignalBriefs(OWNER)).toEqual([]);
  });
});

function expectValidSignal(entityService: EntityService & { __store: Map<string, any> }, id: string) {
  validateSignal(entityService.__store.get(id));
  expect(validateSignal.errors ?? []).toEqual([]);
}

describe('AlpacaSignalService.markSignalsDeclined (H7)', () => {
  it("records the agent's reason and leaves the call open for the next cycle", async () => {
    const { service, entityService } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);

    const updated = await service.markSignalsDeclined(OWNER, [
      { signalId: signal.id, reason: 'Neutral call is a wait signal, not a bullish one.' },
    ]);

    expect(updated).toBe(1);
    const stored = entityService.__store.get(signal.id);
    expect(stored.body.lastDeclineReason).toBe('Neutral call is a wait signal, not a bullish one.');
    expect(stored.body.lastDeclinedAt).toEqual(expect.any(String));
    // A decline is this cycle's judgment, not a disposal — the call must still be weighable tomorrow.
    expect(stored.body.status).toBe('open');
    expect(await service.openSignalBriefs(OWNER)).toHaveLength(1);
    expect(validateSignal(stored)).toBe(true);
  });

  it('is superseded the moment the desk acts on the same call', async () => {
    const { service, entityService } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);
    await service.markSignalsDeclined(OWNER, [{ signalId: signal.id, reason: 'Too far out of the money.' }]);

    await service.markSignalsActed(OWNER, [signal.id], 'AAC_proposal0000000000001');

    const stored = entityService.__store.get(signal.id);
    expect(stored.body.status).toBe('acted');
    // Two contradictory verdicts on one call is exactly what the judge page must never show.
    expect(stored.body.lastDeclineReason).toBeNull();
    expect(stored.body.lastDeclinedAt).toBeNull();
  });

  it("will not decline a call that was already acted on, and won't touch another owner's row", async () => {
    const { service, entityService } = await build({ videoCount: 1 });
    await service.extractSignals(OWNER, { limit: 1 });
    const [signal] = await service.listSignals(OWNER);
    await service.markSignalsActed(OWNER, [signal.id], 'AAC_proposal0000000000001');

    expect(await service.markSignalsDeclined(OWNER, [{ signalId: signal.id, reason: 'changed my mind' }])).toBe(0);
    expect(await service.markSignalsDeclined('USR_someoneelse000000000', [{ signalId: signal.id, reason: 'x' }])).toBe(
      0,
    );
    expect(entityService.__store.get(signal.id).body.lastDeclineReason ?? null).toBeNull();
  });
});
