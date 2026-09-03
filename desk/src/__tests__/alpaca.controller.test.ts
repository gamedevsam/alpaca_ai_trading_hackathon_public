import { JwtSession } from '~/api/auth/utilities/jwt_utilities';
import { AlpacaController } from '../alpaca.controller';
import { AlpacaLifecycleService } from '../alpaca_lifecycle.service';
import { AlpacaMandateService } from '../alpaca_mandate.service';
import { AlpacaTradeCycleService } from '../alpaca_trade_cycle.service';

const SESSION = { userId: 'USR_aaaaaaaaaaaaaaaaaaaa' } as JwtSession;

// Minimal fake lifecycle service — the controller only orchestrates these three methods.
function makeController() {
  const readAccount = jest.fn(async () => ({
    kind: 'simulated' as const,
    environment: 'paper' as const,
    account: { cash: 1, buyingPower: 2, equity: 3, portfolioValue: 4, currency: 'USD', optionsBuyingPower: 1 },
    positions: [{ symbol: 'AAPL', qty: 1, side: 'long' as const, avgEntryPrice: 1, marketValue: 1, unrealizedPl: 0 }],
    clock: { isOpen: true, nextOpen: null, nextClose: null },
  }));
  const getControl = jest.fn(async () => ({
    killState: 'disarmed',
    mode: 'dry_run',
    executionGate: 'per_action',
    limits: {},
  }));
  const setControl = jest.fn(async (_userId: string, environment: string, input: Record<string, string>) => ({
    killState: 'disarmed',
    mode: 'dry_run',
    executionGate: 'per_action',
    environment,
    limits: {},
    ...input,
  }));
  const listActions = jest.fn(async () => [{ id: 'AAC_x' }]);
  const proposeAction = jest.fn(async () => ({ id: 'AAC_y', body: { status: 'proposed' } }));
  const decideAction = jest.fn(async (_userId: string, id: string, decision: string) => ({
    id,
    body: { status: decision },
  }));
  const lifecycle = {
    readAccount,
    getControl,
    setControl,
    listActions,
    proposeAction,
    decideAction,
  } as unknown as AlpacaLifecycleService;
  const mandates = {} as unknown as AlpacaMandateService;
  const runCycle = jest.fn(async () => ({
    environment: 'paper' as const,
    mandateResults: [],
    expirationOutcomes: [],
    autoApprovals: [],
  }));
  const tradeCycle = { runCycle } as unknown as AlpacaTradeCycleService;
  return {
    controller: new AlpacaController(lifecycle, mandates, tradeCycle),
    readAccount,
    getControl,
    setControl,
    listActions,
    proposeAction,
    decideAction,
    runCycle,
  };
}

describe('AlpacaController.overview', () => {
  it('composes account view + control + recent actions in one response', async () => {
    const { controller, readAccount, getControl, listActions } = makeController();
    const result = await controller.overview(SESSION);

    expect(result.kind).toBe('simulated');
    expect(result.environment).toBe('paper');
    expect(result.control.killState).toBe('disarmed');
    expect(result.actions).toEqual([{ id: 'AAC_x' }]);
    expect(readAccount).toHaveBeenCalledWith(SESSION.userId, 'paper');
    expect(getControl).toHaveBeenCalledWith(SESSION.userId, 'paper');
    expect(listActions).toHaveBeenCalledWith(SESSION.userId, 'paper');
  });

  it('clamps an unsupported environment query param to paper (slice 1 is paper-only)', async () => {
    const { controller, readAccount } = makeController();
    await controller.overview(SESSION, 'live');
    expect(readAccount).toHaveBeenCalledWith(SESSION.userId, 'paper');
  });
});

describe('AlpacaController.setControl (H4)', () => {
  it('passes the gate through, clamped to the paper environment', async () => {
    const { controller, setControl } = makeController();

    const result = await controller.setControl(SESSION, { executionGate: 'fully_autonomous' });

    expect(setControl).toHaveBeenCalledWith(SESSION.userId, 'paper', { executionGate: 'fully_autonomous' });
    expect(result.control.executionGate).toBe('fully_autonomous');
  });

  it('passes the kill switch through on the same route', async () => {
    const { controller, setControl } = makeController();

    await controller.setControl(SESSION, { killState: 'killed' });

    expect(setControl).toHaveBeenCalledWith(SESSION.userId, 'paper', { killState: 'killed' });
  });
});

describe('AlpacaController.propose', () => {
  it('delegates the proposal to the lifecycle service for the session user', async () => {
    const { controller, proposeAction } = makeController();
    const input = { symbol: 'AAPL', side: 'buy' as const, orderType: 'market' as const, notional: 1_000 };
    const result = await controller.propose(SESSION, input);

    expect(proposeAction).toHaveBeenCalledWith(SESSION.userId, input);
    expect(result.action.body.status).toBe('proposed');
  });
});

describe('AlpacaController approve/reject (B16)', () => {
  it('approves an action for the session user', async () => {
    const { controller, decideAction } = makeController();
    const result = await controller.approve(SESSION, 'AAC_z');
    expect(decideAction).toHaveBeenCalledWith(SESSION.userId, 'AAC_z', 'approved');
    expect(result.action.body.status).toBe('approved');
  });

  it('rejects an action for the session user', async () => {
    const { controller, decideAction } = makeController();
    const result = await controller.reject(SESSION, 'AAC_z');
    expect(decideAction).toHaveBeenCalledWith(SESSION.userId, 'AAC_z', 'rejected');
    expect(result.action.body.status).toBe('rejected');
  });
});

describe('AlpacaController.runTradeCycle (B55 manual trigger)', () => {
  it('runs the trade cycle for the session user, clamped to paper', async () => {
    const { controller, runCycle } = makeController();
    const result = await controller.runTradeCycle(SESSION);
    expect(runCycle).toHaveBeenCalledWith(SESSION.userId, 'paper');
    expect(result.environment).toBe('paper');
  });
});
