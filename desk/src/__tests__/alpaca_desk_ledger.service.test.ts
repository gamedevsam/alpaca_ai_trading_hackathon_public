import { EntityService } from '~/entity/entity.service';
import type { PredictionLedgerService } from '~/api/user/prediction_ledger/prediction_ledger.service';
import type { SourcePortfolioService } from '~/api/user/target_engine/source_portfolio.service';
import { AlpacaDeskLedgerService, buildDeskCondition, deskSourceName } from '../alpaca_desk_ledger.service';

const OWNER = 'USR_owner000000000000000';
const MANDATE_NAME = 'Income Manager';
const SOURCE_ID = 'SPT_desk0000000000000001';

const CSP_INSTRUMENT = {
  assetClass: 'option' as const,
  underlying: 'AAPL',
  occSymbol: 'AAPL260821P00150000',
  expiration: '2026-08-21',
  strike: 150,
  right: 'put' as const,
  multiplier: 100,
  positionIntent: 'sell_to_open' as const,
};

function makeAction(overrides: Record<string, any> = {}): any {
  const { body, ...rest } = overrides;
  return {
    id: 'AAC_action00000000000001',
    type: 'alpaca_action',
    owner_id: OWNER,
    status: 'active',
    header: {
      owner_user_id: OWNER,
      environment: 'paper',
      status: 'proposed',
      last_activity_at: '2026-08-01T14:00:00.000Z',
    },
    body: {
      environment: 'paper',
      status: 'proposed',
      symbol: 'AAPL',
      rationale: 'AAPL holds 150 through August; the put is 6% out of the money on a 21-day contract.',
      instrument: CSP_INSTRUMENT,
      predictionId: null,
      ...body,
    },
    ...rest,
  };
}

function makeEntityService(seed: any[] = []) {
  const store = new Map<string, any>(seed.map((entity) => [entity.id, structuredClone(entity)]));
  const findMany = jest.fn(async ({ where }: any) =>
    [...store.values()].filter((entity) => Object.entries(where ?? {}).every(([key, value]) => entity[key] === value)),
  );
  const update = jest.fn(async (entity: any, producer: (draft: any) => void) => {
    const draft = structuredClone(store.get(entity.id) ?? entity);
    producer(draft);
    store.set(draft.id, draft);
    return structuredClone(draft);
  });
  return { entityService: { findMany, update } as unknown as EntityService, findMany, update, store };
}

function makeSourcePortfolios(existing: Array<{ id: string; body: { name: string } }> = []) {
  const listSourcePortfolios = jest.fn(async () => existing);
  const upsertSourcePortfolio = jest.fn(async (_owner: string, params: any) => {
    const created = { id: SOURCE_ID, body: { name: params.name } };
    existing.push(created);
    return created;
  });
  return {
    sourcePortfolios: { listSourcePortfolios, upsertSourcePortfolio } as unknown as SourcePortfolioService,
    listSourcePortfolios,
    upsertSourcePortfolio,
  };
}

function makePredictions(views: any[] = []) {
  const logPrediction = jest.fn(async () => ({ prediction: { id: 'PRD_claim000000000000001' }, deduped: false }));
  const logResolution = jest.fn(async () => ({ resolution: { id: 'PRR_res00000000000000001' }, deduped: false }));
  const listPredictions = jest.fn(async () => views);
  return {
    predictions: { logPrediction, logResolution, listPredictions } as unknown as PredictionLedgerService,
    logPrediction,
    logResolution,
    listPredictions,
  };
}

function makeService(entity = makeEntityService(), predictions = makePredictions(), sources = makeSourcePortfolios()) {
  return {
    service: new AlpacaDeskLedgerService(entity.entityService, predictions.predictions, sources.sourcePortfolios),
    entity,
    predictions,
    sources,
  };
}

describe('buildDeskCondition (H8)', () => {
  it('states a short put as a close ABOVE the strike and a short call as a close BELOW it', () => {
    expect(buildDeskCondition(CSP_INSTRUMENT)).toContain('AAPL settles above $150 at the 2026-08-21 close');
    expect(buildDeskCondition({ ...CSP_INSTRUMENT, right: 'call' })).toContain(
      'AAPL settles below $150 at the 2026-08-21 close',
    );
  });
});

describe('AlpacaDeskLedgerService.recordProposalClaim', () => {
  it('logs the claim a proposal stands on and stamps its prediction id onto the action', async () => {
    const action = makeAction();
    const { service, predictions, entity } = makeService(makeEntityService([action]));

    const claimed = await service.recordProposalClaim(OWNER, MANDATE_NAME, action);

    expect(predictions.logPrediction).toHaveBeenCalledTimes(1);
    const [ownerArg, input] = predictions.logPrediction.mock.calls[0] as any[];
    expect(ownerArg).toBe(OWNER);
    expect(input).toMatchObject({
      sourcePortfolioId: SOURCE_ID,
      claimType: 'market_timing',
      // The desk's own words, stored exactly as written — the ledger never paraphrases a claim.
      claimVerbatim: action.body.rationale,
      verbatim: true,
      conditionAuthor: 'operator',
      hedgeLevel: 'low',
      claimSourceRef: `alpaca_action:${action.id}`,
      tickers: ['AAPL'],
    });
    expect(input.falsifiableCondition).toContain('AAPL settles above $150');
    // The contract's own expiration is what grades it, so that is when the claim comes due.
    expect(input.resolveBy.startsWith('2026-08-21')).toBe(true);
    expect(claimed.body.predictionId).toBe('PRD_claim000000000000001');
    expect(entity.update).toHaveBeenCalledTimes(1);
  });

  it('logs nothing for a proposal the ceilings discarded — a refused contract is not a claim the desk made', async () => {
    const action = makeAction({ body: { status: 'discarded' } });
    const { service, predictions, entity } = makeService(makeEntityService([action]));

    const result = await service.recordProposalClaim(OWNER, MANDATE_NAME, action);

    expect(predictions.logPrediction).not.toHaveBeenCalled();
    expect(entity.update).not.toHaveBeenCalled();
    expect(result.body.predictionId).toBeNull();
  });

  it('never double-logs: an action that already carries a claim is returned untouched', async () => {
    const action = makeAction({ body: { predictionId: 'PRD_already0000000000001' } });
    const { service, predictions } = makeService(makeEntityService([action]));

    await service.recordProposalClaim(OWNER, MANDATE_NAME, action);

    expect(predictions.logPrediction).not.toHaveBeenCalled();
  });

  it('reuses one ai_sleeve source per mandate, however many proposals it makes', async () => {
    const first = makeAction();
    const second = makeAction({ id: 'AAC_action00000000000002' });
    const { service, sources } = makeService(makeEntityService([first, second]));

    await service.recordProposalClaim(OWNER, MANDATE_NAME, first);
    await service.recordProposalClaim(OWNER, MANDATE_NAME, second);

    expect(sources.upsertSourcePortfolio).toHaveBeenCalledTimes(1);
    expect(sources.upsertSourcePortfolio.mock.calls[0][1]).toMatchObject({
      name: deskSourceName(MANDATE_NAME),
      kind: 'ai_sleeve',
      holdings: [],
    });
  });

  it('lets the proposal stand when the ledger write fails — the record never gates the trade', async () => {
    const action = makeAction();
    const predictions = makePredictions();
    (predictions.logPrediction as jest.Mock).mockRejectedValueOnce(new Error('ledger unavailable'));
    const { service } = makeService(makeEntityService([action]), predictions);

    const result = await service.recordProposalClaim(OWNER, MANDATE_NAME, action);

    expect(result.body.predictionId).toBeNull();
    expect(result.id).toBe(action.id);
  });
});

describe('AlpacaDeskLedgerService.resolveExpiredClaim', () => {
  it('grades a worthless expiration right and an assignment wrong', async () => {
    const action = makeAction({ body: { status: 'filled', predictionId: 'PRD_claim000000000000001' } });
    const { service, predictions } = makeService(makeEntityService([action]));

    await service.resolveExpiredClaim(OWNER, action, 'expired_worthless', '2026-08-21T21:00:00.000Z', 'Expired.');
    await service.resolveExpiredClaim(OWNER, action, 'assigned', '2026-08-21T21:00:00.000Z', 'Assigned.');

    expect((predictions.logResolution.mock.calls[0][1] as any).outcome).toBe('right');
    expect((predictions.logResolution.mock.calls[1][1] as any).outcome).toBe('wrong');
  });

  it('does nothing for an action that never carried a claim', async () => {
    const action = makeAction({ body: { status: 'filled' } });
    const { service, predictions } = makeService(makeEntityService([action]));

    await service.resolveExpiredClaim(OWNER, action, 'assigned', '2026-08-21T21:00:00.000Z', 'Assigned.');

    expect(predictions.logResolution).not.toHaveBeenCalled();
  });
});

describe('AlpacaDeskLedgerService.retractUnexpressedClaims', () => {
  const OPEN_VIEW = { id: 'PRD_claim000000000000001', liveResolution: null };

  it.each(['failed', 'discarded', 'canceled', 'rejected', 'expired'])(
    'withdraws the claim on a %s order as superseded — never tested, so neither right nor wrong',
    async (status) => {
      const action = makeAction({ body: { status, predictionId: OPEN_VIEW.id } });
      const { service, predictions } = makeService(makeEntityService([action]), makePredictions([OPEN_VIEW]));

      const retracted = await service.retractUnexpressedClaims(OWNER, 'paper');

      expect(retracted).toEqual([
        { actionId: action.id, predictionId: OPEN_VIEW.id, symbol: 'AAPL', actionStatus: status },
      ]);
      expect((predictions.logResolution.mock.calls[0][1] as any).outcome).toBe('superseded');
    },
  );

  it('leaves a filled order alone — its claim is live and will be graded at expiration', async () => {
    const action = makeAction({ body: { status: 'filled', predictionId: OPEN_VIEW.id } });
    const { service, predictions } = makeService(makeEntityService([action]), makePredictions([OPEN_VIEW]));

    expect(await service.retractUnexpressedClaims(OWNER, 'paper')).toEqual([]);
    expect(predictions.logResolution).not.toHaveBeenCalled();
  });

  it('does not re-withdraw a claim an earlier sweep already closed', async () => {
    const action = makeAction({ body: { status: 'failed', predictionId: OPEN_VIEW.id } });
    const closed = { id: OPEN_VIEW.id, liveResolution: { id: 'PRR_res00000000000000001' } };
    const { service, predictions } = makeService(makeEntityService([action]), makePredictions([closed]));

    expect(await service.retractUnexpressedClaims(OWNER, 'paper')).toEqual([]);
    expect(predictions.logResolution).not.toHaveBeenCalled();
  });

  it('ignores an action in another environment entirely', async () => {
    const action = makeAction({ body: { status: 'failed', environment: 'live', predictionId: OPEN_VIEW.id } });
    const { service, predictions } = makeService(makeEntityService([action]), makePredictions([OPEN_VIEW]));

    expect(await service.retractUnexpressedClaims(OWNER, 'paper')).toEqual([]);
    expect(predictions.logResolution).not.toHaveBeenCalled();
  });
});
