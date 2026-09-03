import { EntityService } from '~/entity/entity.service';
import { AlpacaOptionExpirationOutcome } from '../alpaca.types';
import { AlpacaLifecycleService } from '../alpaca_lifecycle.service';
import { AlpacaMandateService, MandateDryRunResult } from '../alpaca_mandate.service';
import { AlpacaDeskLedgerService, RetractedClaim } from '../alpaca_desk_ledger.service';
import { AlpacaSignalService, ReleasedSignal } from '../alpaca_signal.service';
import { AlpacaTradeCycleService } from '../alpaca_trade_cycle.service';

const USER = 'USR_test_owner_00000001';

const CSP_INSTRUMENT = {
  assetClass: 'option' as const,
  underlying: 'AAPL',
  occSymbol: 'AAPL260801P00150000',
  expiration: '2026-08-01',
  strike: 150,
  right: 'put' as const,
  multiplier: 100,
  positionIntent: 'sell_to_open' as const,
};

function makeMandate(overrides: Partial<Required<$.AlpacaMandate>['body']> = {}): Required<$.AlpacaMandate> {
  return {
    id: `AMN_${Math.random().toString(36).slice(2)}`,
    owner_id: USER,
    external_id: null,
    status: 'active',
    schema_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    type: 'alpaca_mandate',
    header: { owner_user_id: USER, environment: 'paper', status: 'active', promotion_state: 'sandbox' },
    body: {
      environment: 'paper',
      name: 'Income Manager',
      mandate: 'Sell conservative covered calls and cash-secured puts.',
      provider: 'local',
      model: null,
      status: 'active',
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

const EMPTY_DRY_RUN: MandateDryRunResult = {
  mandateId: 'x',
  candidates: [],
  selected: [],
  usedAi: false,
  provider: 'local',
  narrative: null,
  actions: [],
};

function makeFakeMandateService(mandates: Array<Required<$.AlpacaMandate>>) {
  const list = jest.fn(async () => mandates);
  const dryRun = jest.fn(async (_userId: string, mandateId: string) => ({ ...EMPTY_DRY_RUN, mandateId }));
  return { mandateService: { list, dryRun } as unknown as AlpacaMandateService, list, dryRun };
}

/**
 * The signal side of a cycle (H16). Defaults to "nothing to give back", so every pre-H16 test keeps
 * asserting exactly what it did before; pass `released` to exercise the release sweep.
 */
function makeFakeSignals(released: ReleasedSignal[] = []) {
  const releaseSignalsForUnexpressedActions = jest.fn(async () => released);
  return {
    signals: { releaseSignalsForUnexpressedActions } as unknown as AlpacaSignalService,
    releaseSignalsForUnexpressedActions,
  };
}

/**
 * The ledger side of a cycle (H8). Defaults to "nothing to withdraw" and a no-op grade, so every earlier
 * test keeps asserting exactly what it did before; pass `retracted` to exercise the withdrawal sweep.
 */
function makeFakeDeskLedger(retracted: RetractedClaim[] = []) {
  const retractUnexpressedClaims = jest.fn(async () => retracted);
  const resolveExpiredClaim = jest.fn(async () => undefined);
  return {
    deskLedger: { retractUnexpressedClaims, resolveExpiredClaim } as unknown as AlpacaDeskLedgerService,
    retractUnexpressedClaims,
    resolveExpiredClaim,
  };
}

function makeCycleService(
  entityService: EntityService,
  lifecycle: AlpacaLifecycleService,
  mandateService: AlpacaMandateService,
  signals: AlpacaSignalService = makeFakeSignals().signals,
  deskLedger: AlpacaDeskLedgerService = makeFakeDeskLedger().deskLedger,
) {
  return new AlpacaTradeCycleService(entityService, lifecycle, mandateService, signals, deskLedger);
}

function makeFakeLifecycle(
  processExpirations: jest.Mock,
  // H4: the control the cycle re-reads before it may auto-approve. Defaults to the safe resting state —
  // the gate closed and the desk disarmed — so every pre-H4 test keeps asserting a propose-only cycle.
  control: { executionGate: string; killState: string } = { executionGate: 'per_action', killState: 'disarmed' },
) {
  const client = { processExpirations };
  const createEnvironmentClient = jest.fn(async () => client);
  const captureAccountSnapshot = jest.fn(async () => undefined);
  const getControl = jest.fn(async () => control);
  const decideAction = jest.fn(async (_userId: string, id: string) => ({
    id,
    body: { status: 'filled', symbol: 'AAPL', errorMessage: '' },
  }));
  // Defaults to "nothing was resting" so every pre-existing test still describes a cycle that only
  // proposes and settles. The catch-up pass itself is asserted in its own describe block below.
  const reconcileRestingOrders = jest.fn(async () => []);
  return {
    lifecycle: {
      createEnvironmentClient,
      captureAccountSnapshot,
      getControl,
      decideAction,
      reconcileRestingOrders,
    } as unknown as AlpacaLifecycleService,
    createEnvironmentClient,
    captureAccountSnapshot,
    getControl,
    decideAction,
    reconcileRestingOrders,
  };
}

// A dry-run result carrying `n` staged actions, each in the given status (the cycle only ever considers
// the `proposed` ones).
function dryRunWith(actions: Array<{ id: string; status: string; symbol?: string }>): MandateDryRunResult {
  return {
    ...EMPTY_DRY_RUN,
    actions: actions.map(
      (a) =>
        ({ id: a.id, body: { status: a.status, symbol: a.symbol ?? 'AAPL' } }) as unknown as Required<$.AlpacaAction>,
    ),
  };
}

// Minimal fake EntityService: findMany returns whatever's seeded, update mutates a clone via the
// Immer-style producer (mirrors the other Alpaca test files' fakes).
function makeFakeEntityService(seedActions: any[], owner: { id: string } | null = null) {
  // Owner resolution reads the *declared* owner (`role: 'owner'`), so the fake answers a user query with
  // the seeded owner and every other query with the seeded actions.
  const findMany = jest.fn(async (args: any) =>
    args?.where?.type === 'user' ? (owner ? [{ ...owner, type: 'user', body: { role: 'owner' } }] : []) : seedActions,
  );
  const findFirst = jest.fn(async () => owner);
  const update = jest.fn(async (entity: any, producer: (draft: any) => unknown) => {
    const draft = structuredClone(entity);
    producer(draft);
    Object.assign(entity, draft); // reflect the mutation back onto the seed array's entry
    return draft;
  });
  return { entityService: { findMany, findFirst, update } as unknown as EntityService, findMany, findFirst, update };
}

function makeOptionAction(overrides: Partial<any> = {}): any {
  return {
    id: 'AAC_filled0000000000001',
    type: 'alpaca_action',
    owner_id: USER,
    status: 'active',
    header: { owner_user_id: USER, environment: 'paper', status: 'filled', last_activity_at: new Date().toISOString() },
    body: {
      environment: 'paper',
      status: 'filled',
      instrument: CSP_INSTRUMENT,
      events: [],
      optionOutcome: null,
      ...overrides.body,
    },
    ...overrides,
  };
}

describe('AlpacaTradeCycleService.runCycle — the resting-order catch-up', () => {
  // Ordering is the whole point, not a detail. A `submitted` action counts as an open collateral
  // commitment, so if the catch-up ran after the mandates, every proposal in this cycle would size
  // itself against a book still pledging an order the broker killed hours ago. That is exactly the prod
  // failure (2026-09-03): a cancelled QQQ 701P held $70,100 and `defined_risk_floor` refused every
  // later cash-secured put, while the broker itself reported the full $100,000 free.
  it('catches up resting orders BEFORE any mandate is evaluated, and reports what it caught', async () => {
    const active = makeMandate({ status: 'active' });
    const { mandateService, dryRun } = makeFakeMandateService([active]);
    const { lifecycle, reconcileRestingOrders } = makeFakeLifecycle(jest.fn(async () => []));
    (reconcileRestingOrders as jest.Mock).mockResolvedValue([
      { id: 'AAC_dead', body: { status: 'canceled', instrument: { occSymbol: 'QQQ260904P00701000' } } },
    ]);
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(reconcileRestingOrders).toHaveBeenCalledWith(USER, 'paper');
    expect(reconcileRestingOrders.mock.invocationCallOrder[0]).toBeLessThan(dryRun.mock.invocationCallOrder[0]);
    expect(result.reconciledRestingOrders).toEqual([
      { actionId: 'AAC_dead', status: 'canceled', occSymbol: 'QQQ260904P00701000' },
    ]);
  });

  it('reports nothing when every resting order is still working', async () => {
    const { mandateService } = makeFakeMandateService([makeMandate({ status: 'active' })]);
    const { lifecycle } = makeFakeLifecycle(jest.fn(async () => []));
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    expect((await service.runCycle(USER, 'paper')).reconciledRestingOrders).toEqual([]);
  });
});

describe('AlpacaTradeCycleService.runCycle', () => {
  it('evaluates every ACTIVE mandate in the environment via dryRun, skipping draft/archived and other environments', async () => {
    const active = makeMandate({ status: 'active' });
    const draft = makeMandate({ status: 'draft' });
    const liveEnvMandate = makeMandate({ status: 'active', environment: 'live' });
    const { mandateService, list, dryRun } = makeFakeMandateService([active, draft, liveEnvMandate]);
    const { lifecycle } = makeFakeLifecycle(jest.fn(async () => []));
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(list).toHaveBeenCalledWith(USER);
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(dryRun).toHaveBeenCalledWith(USER, active.id);
    expect(result.mandateResults).toHaveLength(1);
    expect(result.expirationOutcomes).toEqual([]);
  });

  it('is a no-op on the expiration side when nothing has expired at the broker', async () => {
    const { mandateService } = makeFakeMandateService([]);
    const { lifecycle, captureAccountSnapshot } = makeFakeLifecycle(jest.fn(async () => []));
    const { entityService, findMany } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(result.expirationOutcomes).toEqual([]);
    expect(captureAccountSnapshot).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reflects a settled assignment onto the matching filled alpaca_action and persists the snapshot', async () => {
    const { mandateService } = makeFakeMandateService([]);
    const brokerOutcome: AlpacaOptionExpirationOutcome = {
      instrument: CSP_INSTRUMENT,
      outcome: 'assigned',
      contracts: 1,
    };
    const { lifecycle, captureAccountSnapshot } = makeFakeLifecycle(jest.fn(async () => [brokerOutcome]));
    const action = makeOptionAction();
    const { entityService, update } = makeFakeEntityService([action]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(captureAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(action.body.optionOutcome).toMatchObject({ kind: 'assigned' });
    expect(action.body.events.at(-1)).toMatchObject({ status: 'filled', message: expect.stringMatching(/assigned/i) });
    expect(result.expirationOutcomes).toEqual([
      expect.objectContaining({
        occSymbol: CSP_INSTRUMENT.occSymbol,
        actionId: action.id,
        outcome: 'assigned',
        contracts: 1,
      }),
    ]);
  });

  it('reports expired-worthless with no shares/cash movement described in the detail', async () => {
    const { mandateService } = makeFakeMandateService([]);
    const brokerOutcome: AlpacaOptionExpirationOutcome = {
      instrument: CSP_INSTRUMENT,
      outcome: 'expired_worthless',
      contracts: 2,
    };
    const { lifecycle } = makeFakeLifecycle(jest.fn(async () => [brokerOutcome]));
    const action = makeOptionAction();
    const { entityService } = makeFakeEntityService([action]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(result.expirationOutcomes[0].detail).toMatch(/expired worthless/i);
    expect(action.body.optionOutcome.kind).toBe('expired_worthless');
  });

  it('reconciles a re-reported settlement exactly once (idempotent against the append-only activities feed)', async () => {
    const { mandateService } = makeFakeMandateService([]);
    const brokerOutcome: AlpacaOptionExpirationOutcome = {
      instrument: CSP_INSTRUMENT,
      outcome: 'assigned',
      contracts: 1,
    };
    // The real paper client re-reports the same historical settlement every cycle.
    const { lifecycle, captureAccountSnapshot } = makeFakeLifecycle(jest.fn(async () => [brokerOutcome]));
    const action = makeOptionAction();
    const { entityService, update } = makeFakeEntityService([action]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const first = await service.runCycle(USER, 'paper');
    const second = await service.runCycle(USER, 'paper');

    // First cycle reconciles; second sees the action already carries an optionOutcome and is a no-op.
    expect(update).toHaveBeenCalledTimes(1);
    expect(captureAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(action.body.events).toHaveLength(1);
    expect(first.expirationOutcomes).toHaveLength(1);
    expect(second.expirationOutcomes).toEqual([]);
  });

  it('still settles the broker-side outcome even when no open action matches the OCC symbol', async () => {
    const { mandateService } = makeFakeMandateService([]);
    const brokerOutcome: AlpacaOptionExpirationOutcome = {
      instrument: CSP_INSTRUMENT,
      outcome: 'assigned',
      contracts: 1,
    };
    const { lifecycle, captureAccountSnapshot } = makeFakeLifecycle(jest.fn(async () => [brokerOutcome]));
    const { entityService, update } = makeFakeEntityService([]); // no matching action seeded
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(captureAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(result.expirationOutcomes).toEqual([expect.objectContaining({ actionId: null, outcome: 'assigned' })]);
  });
});

describe('AlpacaTradeCycleService.runCycle — the autonomy gate (H4)', () => {
  const ARMED_AUTONOMOUS = { executionGate: 'fully_autonomous', killState: 'armed' };

  it('gate ON (fully_autonomous + paper + armed): approves each fresh proposal through the SAME guarded execute', async () => {
    const mandate = makeMandate({ status: 'active' });
    const { mandateService, dryRun } = makeFakeMandateService([mandate]);
    dryRun.mockImplementation(async () => dryRunWith([{ id: 'AAC_p1', status: 'proposed', symbol: 'MSFT' }]));
    const { lifecycle, decideAction } = makeFakeLifecycle(
      jest.fn(async () => []),
      ARMED_AUTONOMOUS,
    );
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(decideAction).toHaveBeenCalledTimes(1);
    expect(decideAction).toHaveBeenCalledWith(
      USER,
      'AAC_p1',
      'approved',
      // The timeline must name the gate that granted permission, never claim the owner clicked.
      { message: expect.stringContaining('executionGate=fully_autonomous') },
    );
    expect(result.autoApprovals).toEqual([expect.objectContaining({ actionId: 'AAC_p1', status: 'filled' })]);
  });

  it('gate OFF (the default per_action): nothing is approved and the proposals wait for the owner', async () => {
    const mandate = makeMandate({ status: 'active' });
    const { mandateService, dryRun } = makeFakeMandateService([mandate]);
    dryRun.mockImplementation(async () => dryRunWith([{ id: 'AAC_p1', status: 'proposed' }]));
    const { lifecycle, decideAction } = makeFakeLifecycle(
      jest.fn(async () => []),
      {
        executionGate: 'per_action',
        killState: 'armed',
      },
    );
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(decideAction).not.toHaveBeenCalled();
    expect(result.autoApprovals).toEqual([]);
  });

  it('the kill switch outranks the gate: autonomy on but not armed approves nothing', async () => {
    for (const killState of ['disarmed', 'killed']) {
      const mandate = makeMandate({ status: 'active' });
      const { mandateService, dryRun } = makeFakeMandateService([mandate]);
      dryRun.mockImplementation(async () => dryRunWith([{ id: 'AAC_p1', status: 'proposed' }]));
      const { lifecycle, decideAction } = makeFakeLifecycle(
        jest.fn(async () => []),
        {
          executionGate: 'fully_autonomous',
          killState,
        },
      );
      const { entityService } = makeFakeEntityService([]);
      const service = makeCycleService(entityService, lifecycle, mandateService);

      const result = await service.runCycle(USER, 'paper');

      expect(decideAction).not.toHaveBeenCalled();
      expect(result.autoApprovals).toEqual([]);
    }
  });

  it('autonomy is paper-only: a live cycle never self-approves even with the gate open and armed', async () => {
    const mandate = makeMandate({ status: 'active', environment: 'live' });
    const { mandateService, dryRun } = makeFakeMandateService([mandate]);
    dryRun.mockImplementation(async () => dryRunWith([{ id: 'AAC_p1', status: 'proposed' }]));
    const { lifecycle, decideAction } = makeFakeLifecycle(
      jest.fn(async () => []),
      ARMED_AUTONOMOUS,
    );
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'live');

    expect(decideAction).not.toHaveBeenCalled();
    expect(result.autoApprovals).toEqual([]);
  });

  it('only `proposed` actions are decided — a discarded one is left alone', async () => {
    const mandate = makeMandate({ status: 'active' });
    const { mandateService, dryRun } = makeFakeMandateService([mandate]);
    dryRun.mockImplementation(async () =>
      dryRunWith([
        { id: 'AAC_discarded1', status: 'discarded' },
        { id: 'AAC_p1', status: 'proposed' },
      ]),
    );
    const { lifecycle, decideAction } = makeFakeLifecycle(
      jest.fn(async () => []),
      ARMED_AUTONOMOUS,
    );
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    await service.runCycle(USER, 'paper');

    expect(decideAction).toHaveBeenCalledTimes(1);
    expect(decideAction).toHaveBeenCalledWith(USER, 'AAC_p1', 'approved', expect.anything());
  });

  it('a failed approval never aborts the cycle — the remaining proposals and the expiration pass still run', async () => {
    const mandate = makeMandate({ status: 'active' });
    const { mandateService, dryRun } = makeFakeMandateService([mandate]);
    dryRun.mockImplementation(async () =>
      dryRunWith([
        { id: 'AAC_boom00000000000001', status: 'proposed' },
        { id: 'AAC_ok00000000000000001', status: 'proposed', symbol: 'NVDA' },
      ]),
    );
    const { lifecycle, decideAction, captureAccountSnapshot } = makeFakeLifecycle(
      jest.fn(async () => [{ instrument: CSP_INSTRUMENT, outcome: 'assigned', contracts: 1 }]),
      ARMED_AUTONOMOUS,
    );
    (decideAction as jest.Mock).mockImplementation(async (_userId: string, id: string) => {
      if (id === 'AAC_boom00000000000001') {
        throw new Error('conflict: already decided');
      }
      return { id, body: { status: 'submitted', symbol: 'NVDA', errorMessage: '' } };
    });
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycle(USER, 'paper');

    expect(decideAction).toHaveBeenCalledTimes(2);
    expect(result.autoApprovals).toEqual([
      expect.objectContaining({ actionId: 'AAC_ok00000000000000001', status: 'submitted' }),
    ]);
    expect(captureAccountSnapshot).toHaveBeenCalledTimes(1);
    expect(result.expirationOutcomes).toHaveLength(1);
  });

  // H16 — an auto-approved order the broker refuses comes back `failed`, and the creator's call it cited
  // must not stay spent on it. The sweep runs at the end of the cycle, so this cycle's own failure is
  // already visible to it.
  it('gives back the creator calls cited by orders that never reached the market', async () => {
    const mandate = makeMandate({ status: 'active' });
    const { mandateService, dryRun } = makeFakeMandateService([mandate]);
    dryRun.mockImplementation(async () => dryRunWith([{ id: 'AAC_p1', status: 'proposed' }]));
    const { lifecycle, decideAction } = makeFakeLifecycle(
      jest.fn(async () => []),
      ARMED_AUTONOMOUS,
    );
    (decideAction as jest.Mock).mockImplementation(async (_userId: string, id: string) => ({
      id,
      body: { status: 'failed', symbol: 'META', errorMessage: 'insufficient options buying power' },
    }));
    const releasedCall = {
      signalId: 'ASG_meta00000000000001',
      ticker: 'META',
      actionId: 'AAC_p1',
      actionStatus: 'failed',
    };
    const { signals, releaseSignalsForUnexpressedActions } = makeFakeSignals([releasedCall]);
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService, signals);

    const result = await service.runCycle(USER, 'paper');

    expect(releaseSignalsForUnexpressedActions).toHaveBeenCalledWith(USER, 'paper');
    expect(result.releasedSignals).toEqual([releasedCall]);
    expect(result.autoApprovals).toEqual([expect.objectContaining({ actionId: 'AAC_p1', status: 'failed' })]);
  });

  it('does not even read the control when a dry-run staged no proposals', async () => {
    const mandate = makeMandate({ status: 'active' });
    const { mandateService } = makeFakeMandateService([mandate]);
    const { lifecycle, getControl } = makeFakeLifecycle(
      jest.fn(async () => []),
      ARMED_AUTONOMOUS,
    );
    const { entityService } = makeFakeEntityService([]);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    await service.runCycle(USER, 'paper');

    expect(getControl).not.toHaveBeenCalled();
  });
});

describe('AlpacaTradeCycleService.runCycleForOwner (B55 trigger surface)', () => {
  const ownerLookups = (findMany: jest.Mock) =>
    findMany.mock.calls.filter(([args]: any) => args?.where?.type === 'user').length;

  it('resolves the owner by declared role and runs the cycle for them', async () => {
    const { mandateService, list } = makeFakeMandateService([]);
    const { lifecycle } = makeFakeLifecycle(jest.fn(async () => []));
    const { entityService, findMany } = makeFakeEntityService([], { id: USER });
    const service = makeCycleService(entityService, lifecycle, mandateService);

    const result = await service.runCycleForOwner('paper');

    expect(findMany).toHaveBeenCalledWith({
      where: { type: 'user', status: 'active', body: { path: ['role'], equals: 'owner' } },
    });
    expect(list).toHaveBeenCalledWith(USER);
    expect(result.environment).toBe('paper');
  });

  it('caches the resolved owner id across calls (single lookup)', async () => {
    const { mandateService } = makeFakeMandateService([]);
    const { lifecycle } = makeFakeLifecycle(jest.fn(async () => []));
    const { entityService, findMany } = makeFakeEntityService([], { id: USER });
    const service = makeCycleService(entityService, lifecycle, mandateService);

    await service.runCycleForOwner('paper');
    await service.runCycleForOwner('paper');

    expect(ownerLookups(findMany)).toBe(1);
  });

  it('refuses to run a cycle when no user is declared owner rather than picking one', async () => {
    const { mandateService, list } = makeFakeMandateService([]);
    const { lifecycle } = makeFakeLifecycle(jest.fn(async () => []));
    const { entityService } = makeFakeEntityService([], null);
    const service = makeCycleService(entityService, lifecycle, mandateService);

    await expect(service.runCycleForOwner('paper')).rejects.toThrow(/exactly one active user with role 'owner'/i);
    // Nothing ran against a guessed user — this path proposes trades, so ambiguity must stop it dead.
    expect(list).not.toHaveBeenCalled();
  });
});
