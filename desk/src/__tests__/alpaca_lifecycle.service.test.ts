import { entity_alpaca_account_snapshot, entity_alpaca_action } from '#schema_registry';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { EntityService } from '~/entity/entity.service';
import { AlpacaLifecycleService, DEFAULT_PAPER_CONTROL } from '../alpaca_lifecycle.service';
import { CUSTOM_SCHEMA_KEYWORDS } from '~/api/admin/schema/lib/ajv';

// createEnvironmentClient resolves real-vs-simulated from server_config (B51) once a control's mode
// leaves the default `dry_run` — mock it so the "mode: paper" tests below control what "configured"
// means without touching a real .env or the network.
jest.mock('~/server_config', () => ({
  ...jest.requireActual('~/server_config'),
  ALPACA_PAPER_API_KEY: '',
  ALPACA_PAPER_SECRET_KEY: '',
  ALPACA_PAPER_ENDPOINT: 'https://paper-api.alpaca.markets',
  // Live creds configured (B54 arming-gate tests) — so an *armed* live env can build a real client, and
  // the disarmed-live tests prove the arming toggle (not mere key presence) is what gates live.
  ALPACA_LIVE_API_KEY: 'live-key',
  ALPACA_LIVE_SECRET_KEY: 'live-secret',
  ALPACA_LIVE_ENDPOINT: 'https://api.alpaca.markets',
}));

// Compile the generated registry schemas the same way the runtime validator does, so these tests catch
// any shape mistake (e.g. storing null where the validator requires a sentinel) before it reaches a DB.
function compileValidator(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv, ['date-time']);
  for (const keyword of CUSTOM_SCHEMA_KEYWORDS) {
    ajv.addKeyword(keyword);
  }
  return ajv.compile(schema);
}

const validateAction = compileValidator(entity_alpaca_action as object);
const validateSnapshot = compileValidator(entity_alpaca_account_snapshot as object);

// Minimal fake: the lifecycle service only uses findMany (control + today's activity), findFirst (the
// account-snapshot lookup, B45) and upsert. findFirst defaults to "no snapshot yet" (undefined found).
function makeService(storedEntities: any[] = []) {
  const upsert = jest.fn(async (entity: any) => entity);
  const findMany = jest.fn(async () => storedEntities);
  const findFirst = jest.fn(async () => null);
  const entityService = { upsert, findMany, findFirst } as unknown as EntityService;
  return { service: new AlpacaLifecycleService(entityService), upsert, findMany, findFirst };
}

// A fuller in-memory fake spanning findById/findFirst/findMany/update/upsert — needed once
// `decideAction('approved')` cascades into the guarded execute (B45), which reads control/snapshot
// state and persists both the action and the account snapshot across several steps.
function makeFullService(seedEntities: any[] = []) {
  const store = new Map<string, any>(seedEntities.map((entity) => [entity.id, structuredClone(entity)]));
  let counter = 0;

  const matches = (entity: any, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'gte' in (value as object)) {
        return entity[key] >= (value as { gte: string }).gte;
      }
      return entity[key] === value;
    });

  const findById = jest.fn(async (id: string) => store.get(id) ?? null);
  const findFirst = jest.fn(async (params: any) => {
    for (const entity of store.values()) {
      if (matches(entity, params?.where)) {
        return entity;
      }
    }
    return null;
  });
  const findMany = jest.fn(async (params: any) =>
    [...store.values()].filter((entity) => matches(entity, params?.where)),
  );
  const update = jest.fn(async (entity: any, producer: (draft: any) => unknown) => {
    const draft = structuredClone(entity);
    producer(draft);
    store.set(draft.id, draft);
    return draft;
  });
  const upsert = jest.fn(async (entity: any) => {
    // Real ids are exactly 24 chars (schema minLength/maxLength) — pad the counter to match.
    const stamped = { status: 'active', ...entity, id: entity.id ?? `TST_${String(counter++).padStart(20, '0')}` };
    store.set(stamped.id, stamped);
    return stamped;
  });

  const entityService = { findById, findFirst, findMany, update, upsert } as unknown as EntityService;
  return { service: new AlpacaLifecycleService(entityService), store, findById, findFirst, findMany, update, upsert };
}

// Fake for the decide path: findById returns the stored action; update applies the Immer-style producer
// to a clone (mirroring EntityService.update's produce()).
function makeDecideService(action: any) {
  const findById = jest.fn(async (id: string) => (action && action.id === id ? action : null));
  const update = jest.fn(async (entity: any, producer: (draft: any) => unknown) => {
    const draft = structuredClone(entity);
    producer(draft);
    return draft;
  });
  const entityService = { findById, update } as unknown as EntityService;
  return { service: new AlpacaLifecycleService(entityService), findById, update };
}

// Build a real, schema-valid `proposed` action to feed the decide path. The top-level entity `status` is
// set by the persistence layer (not `.new()`), so stamp it 'active' here to mirror a DB-loaded entity.
async function makeProposedAction() {
  const { service } = makeService();
  const action = await service.proposeAction(USER, {
    symbol: 'AAPL',
    side: 'buy',
    orderType: 'market',
    notional: 1_000,
  });
  return { ...action, status: 'active' as const };
}

// owner_id must be a valid 24-char entity id (the schema requires it), matching a real user id.
const USER = 'USR_aaaaaaaaaaaaaaaaaaaa';

describe('AlpacaLifecycleService.readAccount', () => {
  it('returns the deterministic simulated account, positions and clock', async () => {
    const { service } = makeService();
    const view = await service.readAccount(USER, 'paper');
    expect(view.kind).toBe('simulated');
    expect(view.environment).toBe('paper');
    expect(view.positions.map((p) => p.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(view.account.currency).toBe('USD');
  });
});

describe('AlpacaLifecycleService.getControl', () => {
  it('falls back to the safe default (disarmed / dry-run) when none is stored', async () => {
    const { service } = makeService([]);
    const control = await service.getControl(USER, 'paper');
    expect(control.killState).toBe('disarmed');
    expect(control.mode).toBe('dry_run');
    expect(control.limits.maxNotionalPerOrder).toBe(10_000);
  });

  it('returns the stored control for the matching environment', async () => {
    const stored = {
      type: 'alpaca_control',
      body: { environment: 'paper', killState: 'killed', mode: 'paper', limits: { maxNotionalPerOrder: 1 } },
    };
    const { service } = makeService([stored]);
    const control = await service.getControl(USER, 'paper');
    expect(control.killState).toBe('killed');
  });

  // H4 — the autonomy gate is read fail-closed: only the explicit string opts in, so a control written
  // before H4 (or with a garbage value) can never be mistaken for the owner having enabled autonomy.
  it('reads the execution gate as per_action unless fully_autonomous is explicitly stored', async () => {
    const base = { environment: 'paper', killState: 'armed', mode: 'paper', limits: {} };
    const cases: Array<[unknown, string]> = [
      [undefined, 'per_action'],
      ['per_action', 'per_action'],
      ['fully_autonomous', 'fully_autonomous'],
      ['FULLY_AUTONOMOUS', 'per_action'],
      [true, 'per_action'],
    ];
    for (const [storedGate, expected] of cases) {
      const { service } = makeService([{ type: 'alpaca_control', body: { ...base, executionGate: storedGate } }]);
      expect((await service.getControl(USER, 'paper')).executionGate).toBe(expected);
    }
  });

  it('defaults to per_action when no control is stored at all', async () => {
    const { service } = makeService([]);
    expect((await service.getControl(USER, 'paper')).executionGate).toBe('per_action');
  });
});

describe('AlpacaLifecycleService.setControl (H4)', () => {
  const storedControl = (overrides: Record<string, unknown> = {}) => ({
    id: 'ACT_aaaaaaaaaaaaaaaaaaaa',
    type: 'alpaca_control',
    owner_id: USER,
    status: 'active',
    header: { owner_user_id: USER, environment: 'paper', status: 'armed' },
    body: {
      environment: 'paper',
      killState: 'armed',
      mode: 'paper',
      liveArmed: false,
      limits: { ...DEFAULT_PAPER_CONTROL.limits, maxNotionalPerOrder: 1_234 },
      ...overrides,
    },
  });

  it('flips the gate on the stored control without touching mode, liveArmed or any ceiling', async () => {
    const { service, store } = makeFullService([storedControl()]);

    const control = await service.setControl(USER, 'paper', { executionGate: 'fully_autonomous' });

    expect(control.executionGate).toBe('fully_autonomous');
    expect(control.mode).toBe('paper');
    expect(control.liveArmed).toBe(false);
    expect(control.limits.maxNotionalPerOrder).toBe(1_234);
    expect(store.get('ACT_aaaaaaaaaaaaaaaaaaaa').body.executionGate).toBe('fully_autonomous');
  });

  it('sets the kill switch and mirrors it onto the entity header', async () => {
    const { service, store } = makeFullService([storedControl()]);

    const control = await service.setControl(USER, 'paper', { killState: 'killed' });

    expect(control.killState).toBe('killed');
    expect(store.get('ACT_aaaaaaaaaaaaaaaaaaaa').header.status).toBe('killed');
  });

  it('creates the control from the SAFE defaults when none exists yet (disarmed, dry-run, live not armed)', async () => {
    const { service, upsert } = makeFullService([]);

    const control = await service.setControl(USER, 'paper', { executionGate: 'fully_autonomous' });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(control.executionGate).toBe('fully_autonomous');
    expect(control.killState).toBe('disarmed');
    expect(control.mode).toBe('dry_run');
    expect(control.liveArmed).toBe(false);
  });

  it('rejects an unrecognized gate rather than persisting it', async () => {
    const { service, update, upsert } = makeFullService([storedControl()]);

    await expect(service.setControl(USER, 'paper', { executionGate: 'yolo' as never })).rejects.toThrow(
      /executionGate must be one of/,
    );
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const { service } = makeFullService([storedControl()]);
    await expect(service.setControl(USER, 'paper', {})).rejects.toThrow(/Nothing to set/);
  });
});

describe('AlpacaLifecycleService.createEnvironmentClient (B51 mode-based broker selection)', () => {
  it('stays on the deterministic simulated client while mode is the default dry_run', async () => {
    const { service } = makeService([]);
    const client = await service.createEnvironmentClient(USER, 'paper');
    expect(client.kind).toBe('simulated');
  });

  it('fails closed (never silently falls back to simulated) once mode is paper but no real credentials are configured', async () => {
    const stored = {
      type: 'alpaca_control',
      body: { environment: 'paper', killState: 'disarmed', mode: 'paper', limits: DEFAULT_PAPER_CONTROL.limits },
    };
    const { service } = makeService([stored]);
    await expect(service.createEnvironmentClient(USER, 'paper')).rejects.toThrow(
      /Cannot create a real paper Alpaca client without credentials/,
    );
  });
});

describe('AlpacaLifecycleService.createEnvironmentClient — live arming gate (B54)', () => {
  const liveControl = (over: Record<string, unknown> = {}) => ({
    type: 'alpaca_control',
    body: { environment: 'live', killState: 'disarmed', mode: 'live', limits: DEFAULT_PAPER_CONTROL.limits, ...over },
  });

  it('getControl reports live as disarmed by default (no liveArmed stored)', async () => {
    const { service } = makeService([]);
    const control = await service.getControl(USER, 'live');
    expect(control.liveArmed).toBe(false);
  });

  it('refuses to build ANY live client while the owner-armed toggle is off (fail closed)', async () => {
    // Live creds ARE configured (see the mock) — proving key presence alone is NOT what arms live.
    const { service } = makeService([liveControl({ liveArmed: false })]);
    await expect(service.createEnvironmentClient(USER, 'live')).rejects.toThrow(/disarmed.*liveArmed=true/);
  });

  it('treats a live control that omits liveArmed as disarmed', async () => {
    const { service } = makeService([liveControl()]); // no liveArmed key at all
    await expect(service.createEnvironmentClient(USER, 'live')).rejects.toThrow(/disarmed/);
  });

  it('builds the real live client once the owner arms liveArmed', async () => {
    const { service } = makeService([liveControl({ liveArmed: true })]);
    const client = await service.createEnvironmentClient(USER, 'live');
    expect(client.kind).toBe('paper'); // real REST client (vs. simulated)
    expect(client.environment).toBe('live'); // pointed at the live account
  });

  it('does not affect paper — paper never requires the live toggle', async () => {
    const { service } = makeService([]);
    const client = await service.createEnvironmentClient(USER, 'paper');
    expect(client.kind).toBe('simulated');
  });
});

describe('AlpacaLifecycleService.proposeAction', () => {
  it('proposes a clean in-bounds buy and persists a schema-valid action', async () => {
    const { service, upsert } = makeService();
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'buy',
      orderType: 'market',
      notional: 1_000,
      rationale: 'add to a core holding',
    });

    expect(action.body.status).toBe('proposed');
    expect(action.header.status).toBe('proposed');
    // Pre-generated id requires a matching created_at, else prepareEntityToValidate rejects the upsert
    // ("missing created_at") — a real-DB failure the mocked upsert can't see. Guard it here.
    expect(action.created_at).toBeTruthy();
    expect(action.body.approval).toBeNull();
    expect(action.body.clientOrderId).toBe(`alpaca-paper-${action.id}`);
    expect(action.body.errorMessage).toBe('');
    expect(action.body.expiresAt).toBeTruthy();
    expect(action.body.clearedLimits.every((c) => c.passed)).toBe(true);
    expect(action.body.events.map((e) => e.status)).toEqual(['draft', 'proposed']);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(validateAction(action)).toBe(true);
  });

  it('discards an untradable symbol with a schema-valid action and an error message', async () => {
    const { service } = makeService();
    const action = await service.proposeAction(USER, {
      symbol: 'NOTREAL',
      side: 'buy',
      orderType: 'market',
      notional: 1_000,
    });

    expect(action.body.status).toBe('discarded');
    expect(action.header.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('symbol_tradable');
    expect(action.body.expiresAt).toBeNull();
    expect(action.body.events[1].status).toBe('discarded');
    expect(validateAction(action)).toBe(true);
  });

  it('discards an order that exceeds the per-order notional cap', async () => {
    const { service } = makeService();
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'buy',
      orderType: 'market',
      notional: 25_000,
    });
    expect(action.body.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('max_notional_per_order');
  });

  it('discards selling more than is held', async () => {
    const { service } = makeService();
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 999,
    });
    expect(action.body.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('sufficient_holdings');
  });

  it('derives a deterministic per-environment client_order_id and never approves/submits', async () => {
    const { service } = makeService();
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'buy',
      orderType: 'limit',
      qty: 5,
      limitPrice: 150,
    });
    expect(action.body.clientOrderId.startsWith('alpaca-paper-')).toBe(true);
    expect(action.body.alpacaOrderId).toBe('');
    expect(action.body.fills).toEqual([]);
    expect(['proposed', 'discarded']).toContain(action.body.status);
  });
});

// B48 — wiring the B46 instrument model + B47 safeguards through proposeAction/decideAction. Carries
// owner_id/status so `makeFullService`'s (non-trivial) findMany filter matches it too, not just
// `makeService`'s always-return-everything fake. mode stays `dry_run` (these tests exercise the
// deterministic simulated broker, not real-paper wiring — that's the dedicated B51 describe block above).
const OPTIONS_ENABLED_CONTROL = {
  type: 'alpaca_control',
  owner_id: USER,
  status: 'active',
  body: {
    environment: 'paper',
    killState: 'disarmed',
    mode: 'dry_run',
    limits: {
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
      minDaysToExpiry: null,
      maxDaysToExpiry: null,
      requireOtm: false,
      minStrikeVsCostBasisPct: null,
      maxAbsDelta: null,
      earningsBlackoutDays: null,
    },
  },
};

// One already-open option action, as `computeOptionBookState` reads the book. Only the fields the
// collateral tallies touch — everything else about an action is irrelevant to them.
function optionActionFixture(leg: {
  id: string;
  underlying: string;
  occSymbol: string;
  strike: number;
  right: 'put' | 'call';
  qty?: number;
}) {
  return {
    id: leg.id,
    type: 'alpaca_action',
    owner_id: USER,
    status: 'active',
    created_at: new Date().toISOString(),
    body: {
      environment: 'paper',
      status: 'proposed',
      symbol: leg.underlying,
      qty: leg.qty ?? 1,
      instrument: {
        assetClass: 'option',
        underlying: leg.underlying,
        occSymbol: leg.occSymbol,
        expiration: '2026-08-01',
        strike: leg.strike,
        right: leg.right,
        multiplier: 100,
        positionIntent: 'sell_to_open',
      },
    },
  };
}

describe('AlpacaLifecycleService.proposeAction — options (B48)', () => {
  it('discards an option proposal when options are disabled in the control limits', async () => {
    const { service } = makeService(); // no stored control ⇒ DEFAULT_PAPER_CONTROL, optionsEnabled: false
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-08-01', strike: 150, right: 'put', positionIntent: 'sell_to_open' },
    });
    expect(action.body.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('options_enabled');
  });

  it('proposes a cash-secured put and persists the B46 option instrument (occ symbol, multiplier default)', async () => {
    const { service } = makeService([OPTIONS_ENABLED_CONTROL]);
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'buy', // deliberately wrong — side must be DERIVED from positionIntent, ignoring this
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-08-01', strike: 150, right: 'put', positionIntent: 'sell_to_open' },
    });
    expect(action.body.status).toBe('proposed');
    expect(action.body.side).toBe('sell'); // derived from positionIntent, not the (deliberately wrong) input.side
    expect(action.body.instrument).toMatchObject({
      assetClass: 'option',
      underlying: 'AAPL',
      occSymbol: 'AAPL260801P00150000',
      expiration: '2026-08-01',
      strike: 150,
      right: 'put',
      multiplier: 100,
      positionIntent: 'sell_to_open',
    });
    expect(validateAction(action)).toBe(true);
  });

  it('discards a covered call lacking sufficient covering shares (defined-risk floor, B47)', async () => {
    const { service } = makeService([OPTIONS_ENABLED_CONTROL]);
    // Seed AAPL position is 50 shares; 2 contracts of a covered call need 200 shares.
    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 2,
      optionLeg: { expiration: '2026-08-01', strike: 220, right: 'call', positionIntent: 'sell_to_open' },
    });
    expect(action.body.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('defined_risk_floor');
  });

  it('rejects a request with a malformed option leg before it reaches the safeguards', async () => {
    const { service } = makeService([OPTIONS_ENABLED_CONTROL]);
    await expect(
      service.proposeAction(USER, {
        symbol: 'AAPL',
        side: 'sell',
        orderType: 'market',
        qty: 1,
        optionLeg: { expiration: 'not-a-date', strike: 150, right: 'put', positionIntent: 'sell_to_open' },
      }),
    ).rejects.toThrow(/expiration/);
  });

  it("counts another OPEN option action's pledge against the same underlying's book state", async () => {
    // A prior proposed CSP already pledges $80,000 of AAPL's $100,000 cash — leaves only $20,000 free.
    const priorAction = {
      id: 'AAC_prior00000000000001',
      type: 'alpaca_action',
      owner_id: USER,
      status: 'active',
      created_at: new Date().toISOString(),
      body: {
        environment: 'paper',
        status: 'proposed',
        symbol: 'AAPL',
        qty: 1,
        instrument: {
          assetClass: 'option',
          underlying: 'AAPL',
          occSymbol: 'AAPL260801P00800000',
          expiration: '2026-08-01',
          strike: 800,
          right: 'put',
          multiplier: 100,
          positionIntent: 'sell_to_open',
        },
      },
    };
    const { service } = makeService([OPTIONS_ENABLED_CONTROL, priorAction]);

    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-09-01', strike: 300, right: 'put', positionIntent: 'sell_to_open' },
    });

    // $30,000 needed for the new CSP, but only $20,000 is free once the prior pledge is counted.
    expect(action.body.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('defined_risk_floor');
  });

  // H16 — the live desk cleared a $58k META put and a $21.7k NVDA put against a $100k account whose cash
  // was already pledged to an open QQQ put, and the broker refused both ("insufficient options buying
  // power ... available: 0"). Short-put collateral is ONE pool at the broker, whatever the name on it.
  it("counts an open CSP on a DIFFERENT underlying against a new put's cash", async () => {
    const priorQqqPut = optionActionFixture({
      id: 'AAC_priorqqq0000000001',
      underlying: 'QQQ',
      occSymbol: 'QQQ260801P00800000',
      strike: 800,
      right: 'put',
    });
    const { service } = makeService([OPTIONS_ENABLED_CONTROL, priorQqqPut]);

    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-09-01', strike: 300, right: 'put', positionIntent: 'sell_to_open' },
    });

    // $30,000 needed; the QQQ put holds $80,000 of the $100,000, so only $20,000 is actually free.
    expect(action.body.status).toBe('discarded');
    expect(action.body.errorMessage).toContain('defined_risk_floor');
    const floor = action.body.clearedLimits.find((c: any) => c.limit === 'defined_risk_floor');
    expect(floor?.detail).toContain("this cycle's own pledges");
  });

  // The other half of H16's asymmetry: cash is one pool, but the CONTRACT COUNT is a per-name ceiling.
  // An open QQQ put must not consume AAPL's `max_contracts_per_underlying` budget.
  it("keeps the contract count per underlying — a QQQ put doesn't fill AAPL's cap", async () => {
    const priorQqqPut = optionActionFixture({
      id: 'AAC_priorqqq2000000001',
      underlying: 'QQQ',
      occSymbol: 'QQQ260801P00100000',
      strike: 100,
      right: 'put',
    });
    const control = {
      ...OPTIONS_ENABLED_CONTROL,
      body: {
        ...OPTIONS_ENABLED_CONTROL.body,
        limits: { ...OPTIONS_ENABLED_CONTROL.body.limits, maxContractsPerUnderlying: 1 },
      },
    };
    const { service } = makeService([control, priorQqqPut]);

    const action = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-09-01', strike: 150, right: 'put', positionIntent: 'sell_to_open' },
    });

    // $15,000 needed, $90,000 free after QQQ's $10,000 pledge — and AAPL's own contract count is still 0.
    expect(action.body.status).toBe('proposed');
  });
});

describe('AlpacaLifecycleService.decideAction — options execute end-to-end (B50)', () => {
  it('approving a cash-secured put runs it through submitted → filled → reconciled', async () => {
    const { service, store } = makeFullService([OPTIONS_ENABLED_CONTROL]);
    const proposed = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-08-01', strike: 150, right: 'put', positionIntent: 'sell_to_open' },
    });
    expect(proposed.body.status).toBe('proposed');

    const result = await service.decideAction(USER, proposed.id, 'approved');

    expect(result.body.status).toBe('reconciled');
    expect(result.header.status).toBe('reconciled');
    expect(result.body.events.map((e) => e.status)).toEqual([
      'draft',
      'proposed',
      'approved',
      'submitted',
      'filled',
      'reconciled',
    ]);
    expect(result.body.alpacaOrderId).toBe(`sim-${result.body.clientOrderId}`);
    expect(result.body.fills).toHaveLength(1);
    expect(result.body.fills[0].qty).toBe(1);
    expect(validateAction(result)).toBe(true);

    // The option leg shows up in the reconciled account snapshot, tagged with its contract identity.
    const snapshot = [...store.values()].find((entity) => entity.type === 'alpaca_account_snapshot');
    expect(snapshot).toBeTruthy();
    const optionPosition = snapshot.body.positions.find(
      (p: { symbol: string }) => p.symbol === result.body.instrument.occSymbol,
    );
    expect(optionPosition).toMatchObject({ qty: -1, instrument: { assetClass: 'option', right: 'put', strike: 150 } });
    expect(validateSnapshot(snapshot)).toBe(true);
  });

  it('discards (does not execute) an option action if another proposal pledged away its cash before approval, without double-counting its own pledge', async () => {
    const { service, store } = makeFullService([OPTIONS_ENABLED_CONTROL]);
    // Seed cash is $100,000. This CSP needs $15,000 (150 strike * 100 * 1 contract) — clears at propose time.
    const proposed = await service.proposeAction(USER, {
      symbol: 'AAPL',
      side: 'sell',
      orderType: 'market',
      qty: 1,
      optionLeg: { expiration: '2026-08-01', strike: 150, right: 'put', positionIntent: 'sell_to_open' },
    });
    expect(proposed.body.status).toBe('proposed');

    // A second, unrelated proposal lands on the same underlying before this one is decided, pledging
    // $90,000 — only $10,000 would be left, less than the $15,000 this action needs.
    store.set('AAC_conflicting00000001', {
      id: 'AAC_conflicting00000001',
      type: 'alpaca_action',
      owner_id: USER,
      status: 'active',
      created_at: new Date().toISOString(),
      body: {
        environment: 'paper',
        status: 'proposed',
        symbol: 'AAPL',
        qty: 1,
        instrument: {
          assetClass: 'option',
          underlying: 'AAPL',
          occSymbol: 'AAPL260801P00900000',
          expiration: '2026-08-01',
          strike: 900,
          right: 'put',
          multiplier: 100,
          positionIntent: 'sell_to_open',
        },
      },
    });

    const result = await service.decideAction(USER, proposed.id, 'approved');

    // Fails at the execution re-check (not at approval) — the book state drifted since propose time.
    expect(result.body.status).toBe('discarded');
    expect(result.body.errorMessage).toContain('defined_risk_floor');
    expect(result.body.alpacaOrderId).toBe('');
  });
});

describe('AlpacaLifecycleService.decideAction (B16 approval surface) + guarded execute (B45)', () => {
  it('approving a market buy runs it through submitted → filled → reconciled and stays schema-valid', async () => {
    const { service, store } = makeFullService();
    const proposed = await service.proposeAction(USER, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 });

    const result = await service.decideAction(USER, proposed.id, 'approved');

    expect(result.body.status).toBe('reconciled');
    expect(result.header.status).toBe('reconciled');
    expect(result.body.approval).toMatchObject({ decision: 'approved', decidedBy: USER, tokenId: null });
    // Full audit trail, appended never rewritten.
    expect(result.body.events.map((e) => e.status)).toEqual([
      'draft',
      'proposed',
      'approved',
      'submitted',
      'filled',
      'reconciled',
    ]);
    expect(result.body.alpacaOrderId).toBe(`sim-${result.body.clientOrderId}`);
    expect(result.body.fills).toHaveLength(1);
    expect(result.body.fills[0].qty).toBe(10);
    expect(result.body.fills[0].price).toBeGreaterThan(0);
    expect(validateAction(result)).toBe(true);

    // Fill readback persisted to the per-environment account snapshot (B45), and it validates too.
    const snapshot = [...store.values()].find((entity) => entity.type === 'alpaca_account_snapshot');
    expect(snapshot).toBeTruthy();
    expect(snapshot.external_id).toBe('alpaca-account-snapshot-paper');
    expect(snapshot.body.environment).toBe('paper');
    const aaplPosition = snapshot.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    expect(aaplPosition.qty).toBe(60); // 50 seeded + 10 filled
    expect(validateSnapshot(snapshot)).toBe(true);
  });

  it('a later readAccount reflects the position update from a prior execution', async () => {
    const { service } = makeFullService();
    const proposed = await service.proposeAction(USER, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 });
    await service.decideAction(USER, proposed.id, 'approved');

    const view = await service.readAccount(USER, 'paper');
    const aapl = view.positions.find((p) => p.symbol === 'AAPL');
    expect(aapl?.qty).toBe(60);
  });

  it('discards (does not execute) when conditions drift between approval and the guarded re-check', async () => {
    const { service, store } = makeFullService();
    const proposed = await service.proposeAction(USER, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 });

    // Conditions changed after approval was requested (e.g. the owner engaged the kill switch) — the
    // re-check must catch this even though nothing about the request itself changed (design §3).
    store.set('ACC_kill_test', {
      id: 'ACC_kill_test',
      type: 'alpaca_control',
      owner_id: USER,
      status: 'active',
      body: {
        environment: 'paper',
        killState: 'killed',
        mode: DEFAULT_PAPER_CONTROL.mode,
        limits: DEFAULT_PAPER_CONTROL.limits,
      },
    });

    const result = await service.decideAction(USER, proposed.id, 'approved');

    expect(result.body.status).toBe('discarded');
    expect(result.header.status).toBe('discarded');
    expect(result.body.errorMessage).toContain('kill_switch');
    expect(result.body.alpacaOrderId).toBe('');
    expect(result.body.fills).toEqual([]);
    expect(result.body.events.at(-1)?.status).toBe('discarded');
    expect(validateAction(result)).toBe(true);
  });

  it('rejects a proposed action and records the rejection', async () => {
    const proposed = await makeProposedAction();
    const { service } = makeDecideService(proposed);

    const rejected = await service.decideAction(USER, proposed.id, 'rejected');

    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.approval?.decision).toBe('rejected');
    expect(rejected.body.events.at(-1)?.status).toBe('rejected');
    expect(validateAction(rejected)).toBe(true);
  });

  it('refuses to re-decide an action that is no longer proposed (409)', async () => {
    const proposed = await makeProposedAction();
    proposed.body.status = 'approved';
    proposed.header.status = 'approved';
    const { service } = makeDecideService(proposed);

    await expect(service.decideAction(USER, proposed.id, 'approved')).rejects.toThrow(/not awaiting approval/);
  });

  it('expires (does not approve) a proposal whose TTL has lapsed', async () => {
    const proposed = await makeProposedAction();
    proposed.body.expiresAt = new Date(Date.now() - 60_000).toISOString();
    const { service } = makeDecideService(proposed);

    const result = await service.decideAction(USER, proposed.id, 'approved');

    expect(result.body.status).toBe('expired');
    expect(result.body.approval).toBeNull();
    expect(result.body.events.at(-1)?.status).toBe('expired');
    expect(validateAction(result)).toBe(true);
  });

  it('404s a missing or non-owned action', async () => {
    const proposed = await makeProposedAction();
    const { service } = makeDecideService(proposed);

    await expect(service.decideAction(USER, 'AAC_doesnotexistxxxxxxxx', 'approved')).rejects.toThrow(/not found/i);
    await expect(service.decideAction('USR_bbbbbbbbbbbbbbbbbbbb', proposed.id, 'approved')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('AlpacaLifecycleService.reconcileRestingOrders', () => {
  // A `submitted` action counts as an open collateral commitment, and until this pass existed nothing
  // ever re-checked one: `reconcileAction` runs only on the submit path, and B50's monitoring settles
  // expirations of FILLED options. So an order cancelled at the broker by anyone but us stayed
  // `submitted` forever and kept pledging its strike. On prod (2026-09-03) one cancelled QQQ 701P held
  // $70,100 of a $100,000 account, and `defined_risk_floor` refused every later cash-secured put.
  function restingAction(overrides: Record<string, any> = {}) {
    return {
      id: 'AAC_resting',
      type: 'alpaca_action',
      owner_id: 'user-1',
      status: 'active',
      header: { owner_user_id: 'user-1', status: 'submitted', environment: 'paper' },
      body: {
        status: 'submitted',
        environment: 'paper',
        symbol: 'QQQ260904P00701000',
        side: 'sell',
        qty: 1,
        clientOrderId: 'alpaca-paper-AAC_resting',
        alpacaOrderId: 'broker-1',
        fills: [],
        events: [],
        instrument: {
          occSymbol: 'QQQ260904P00701000',
          right: 'put',
          strike: 701,
          multiplier: 100,
          positionIntent: 'sell_to_open',
        },
        ...overrides,
      },
    };
  }

  function fakeClient(order: any) {
    return {
      getOrderByClientOrderId: jest.fn(async () => order),
      getAccount: jest.fn(async () => ({ cash: 100000, equity: 100000 })),
      getPositions: jest.fn(async () => []),
      getClock: jest.fn(async () => ({ isOpen: true })),
    } as any;
  }

  it('marks a resting action canceled once the broker reports the order canceled', async () => {
    const { service } = makeFullService([restingAction()]);
    const client = fakeClient({
      id: 'broker-1',
      clientOrderId: 'alpaca-paper-AAC_resting',
      status: 'canceled',
      filledQty: 0,
      filledAvgPrice: null,
      submittedAt: '2026-09-03T13:30:04Z',
    });

    const reconciled = await service.reconcileRestingOrders('user-1', 'paper', client);

    expect(client.getOrderByClientOrderId).toHaveBeenCalledWith('alpaca-paper-AAC_resting');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].body.status).toBe('canceled');
  });

  it('leaves an order the broker cannot find alone — releasing collateral on a lookup miss is the dangerous direction', async () => {
    const { service } = makeFullService([restingAction()]);
    const client = fakeClient(null);

    const reconciled = await service.reconcileRestingOrders('user-1', 'paper', client);

    expect(reconciled).toEqual([]);
  });

  it('leaves a still-working order submitted', async () => {
    const { service } = makeFullService([restingAction()]);
    const client = fakeClient({
      id: 'broker-1',
      clientOrderId: 'alpaca-paper-AAC_resting',
      status: 'new',
      filledQty: 0,
      filledAvgPrice: null,
      submittedAt: '2026-09-03T13:30:04Z',
    });

    expect(await service.reconcileRestingOrders('user-1', 'paper', client)).toEqual([]);
  });
});

describe('AlpacaLifecycleService.setControl — the ceilings the owner may change', () => {
  const storedControl = (limits: Record<string, unknown>) => ({
    id: 'ACT_000000000000000000001',
    type: 'alpaca_control',
    owner_id: 'user-1',
    status: 'active',
    header: { owner_user_id: 'user-1', environment: 'paper', status: 'armed' },
    body: {
      environment: 'paper',
      killState: 'armed',
      mode: 'paper',
      liveArmed: false,
      executionGate: 'per_action',
      limits: {
        maxNotionalPerOrder: 10_000,
        maxPositionPct: 25,
        maxOrdersPerDay: 6,
        maxDailyNotional: 50_000,
        symbolAllowList: [],
        symbolDenyList: [],
        optionsEnabled: true,
        cooldownAfterFailureMs: 60_000,
        maxContractsPerOrder: 5,
        maxContractsPerUnderlying: 10,
        maxShortCallCoveredPct: 75,
        minDaysToExpiry: 1,
        maxDaysToExpiry: 5,
        requireOtm: true,
        minStrikeVsCostBasisPct: null,
        maxAbsDelta: 0.25,
        earningsBlackoutDays: null,
        ...limits,
      },
    },
  });

  it('raises one ceiling and leaves every other one exactly as stored', async () => {
    const { service } = makeFullService([storedControl({})]);

    const control = await service.setControl('user-1', 'paper', { limits: { maxOrdersPerDay: 25 } });

    expect(control.limits.maxOrdersPerDay).toBe(25);
    // The patch must not carry the caller's idea of the other fifteen ceilings back into the entity.
    expect(control.limits.maxNotionalPerOrder).toBe(10_000);
    expect(control.limits.maxAbsDelta).toBe(0.25);
    expect(control.limits.requireOtm).toBe(true);
  });

  it('accepts null as an explicit removal of a cap', async () => {
    const { service } = makeFullService([storedControl({})]);

    const control = await service.setControl('user-1', 'paper', { limits: { maxOrdersPerDay: null } });

    expect(control.limits.maxOrdersPerDay).toBeNull();
  });

  it('refuses a negative or non-finite ceiling rather than storing one that stops limiting', async () => {
    const { service } = makeFullService([storedControl({})]);

    await expect(service.setControl('user-1', 'paper', { limits: { maxOrdersPerDay: -1 } })).rejects.toThrow(
      /must be a number >= 0/i,
    );
    await expect(service.setControl('user-1', 'paper', { limits: { maxOrdersPerDay: Number.NaN } })).rejects.toThrow(
      /must be a number >= 0/i,
    );
  });

  it('refuses an unknown limit field instead of writing a ceiling nothing reads', async () => {
    const { service } = makeFullService([storedControl({})]);

    await expect(service.setControl('user-1', 'paper', { limits: { maxOrdersPerDayy: 25 } as never })).rejects.toThrow(
      /Unknown limit field/i,
    );
  });

  it('cannot arm the live broker or change the mode as a side effect of raising a ceiling', async () => {
    const { service, store } = makeFullService([storedControl({})]);

    await service.setControl('user-1', 'paper', { limits: { maxOrdersPerDay: null, maxDailyNotional: null } });

    const stored = store.get('ACT_000000000000000000001');
    expect(stored.body.liveArmed).toBe(false);
    expect(stored.body.mode).toBe('paper');
    expect(stored.body.killState).toBe('armed');
  });

  it('normalizes symbol lists so a lowercase ticker still denies the right name', async () => {
    const { service } = makeFullService([storedControl({})]);

    const control = await service.setControl('user-1', 'paper', { limits: { symbolDenyList: [' tsla ', 'gme'] } });

    expect(control.limits.symbolDenyList).toEqual(['TSLA', 'GME']);
  });

  it('still refuses a call that sets nothing at all', async () => {
    const { service } = makeFullService([storedControl({})]);

    await expect(service.setControl('user-1', 'paper', { limits: {} })).rejects.toThrow(/Nothing to set/i);
  });
});
