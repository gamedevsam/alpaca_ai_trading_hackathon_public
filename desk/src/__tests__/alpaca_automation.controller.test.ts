let mockToken: string | undefined;
let mockLiveToken: string | undefined;

jest.mock('~/server_config', () => ({
  ...jest.requireActual('~/server_config'),
  get ALPACA_PAPER_TRIGGER_TOKEN() {
    return mockToken;
  },
  get ALPACA_LIVE_TRIGGER_TOKEN() {
    return mockLiveToken;
  },
}));

import { AlpacaAutomationController } from '../alpaca_automation.controller';
import { AlpacaTradeCycleService } from '../alpaca_trade_cycle.service';

function makeRequest(authorization?: string) {
  return { headers: { authorization } } as any;
}

function makeController() {
  const runCycleForOwner = jest.fn(async (environment: 'paper' | 'live') => ({
    environment,
    mandateResults: [],
    expirationOutcomes: [],
  }));
  const tradeCycle = { runCycleForOwner } as unknown as AlpacaTradeCycleService;
  return { controller: new AlpacaAutomationController(tradeCycle), runCycleForOwner };
}

describe('AlpacaAutomationController.triggerTradeCycle (B55)', () => {
  afterEach(() => {
    mockToken = undefined;
    mockLiveToken = undefined;
    jest.resetAllMocks();
  });

  it('rejects an unknown environment segment', async () => {
    mockToken = 'secret-token';
    const { controller } = makeController();
    await expect(controller.triggerTradeCycle(makeRequest('Bearer secret-token'), 'sandbox')).rejects.toThrow(
      /unknown alpaca environment/i,
    );
  });

  it('hard-fails live when the live trigger token is not configured (B54)', async () => {
    mockToken = 'paper-token';
    mockLiveToken = '';
    const { controller, runCycleForOwner } = makeController();
    await expect(controller.triggerTradeCycle(makeRequest('Bearer paper-token'), 'live')).rejects.toThrow(
      /ALPACA_LIVE_TRIGGER_TOKEN is not configured/i,
    );
    expect(runCycleForOwner).not.toHaveBeenCalled();
  });

  it('rejects the paper token on the live URL — each environment has its own token (B54)', async () => {
    mockToken = 'paper-token';
    mockLiveToken = 'live-token';
    const { controller, runCycleForOwner } = makeController();
    await expect(controller.triggerTradeCycle(makeRequest('Bearer paper-token'), 'live')).rejects.toThrow(/invalid/i);
    expect(runCycleForOwner).not.toHaveBeenCalled();
  });

  it('runs the live cycle when the live token matches (arming is enforced downstream in the cycle) (B54)', async () => {
    mockLiveToken = 'live-token';
    const { controller, runCycleForOwner } = makeController();
    const result = await controller.triggerTradeCycle(makeRequest('Bearer live-token'), 'live');
    expect(runCycleForOwner).toHaveBeenCalledWith('live');
    expect(result.environment).toBe('live');
  });

  it('hard-fails when the paper trigger token is not configured', async () => {
    mockToken = '';
    const { controller } = makeController();
    await expect(controller.triggerTradeCycle(makeRequest('Bearer whatever'), 'paper')).rejects.toThrow(
      /not configured/i,
    );
  });

  it('rejects a missing or wrong bearer token', async () => {
    mockToken = 'secret-token';
    const { controller, runCycleForOwner } = makeController();

    await expect(controller.triggerTradeCycle(makeRequest(), 'paper')).rejects.toThrow(/invalid/i);
    await expect(controller.triggerTradeCycle(makeRequest('Bearer wrong-token'), 'paper')).rejects.toThrow(/invalid/i);
    expect(runCycleForOwner).not.toHaveBeenCalled();
  });

  it('runs the paper cycle when the token matches', async () => {
    mockToken = 'secret-token';
    const { controller, runCycleForOwner } = makeController();

    const result = await controller.triggerTradeCycle(makeRequest('Bearer secret-token'), 'paper');

    expect(runCycleForOwner).toHaveBeenCalledWith('paper');
    expect(result.environment).toBe('paper');
  });
});
