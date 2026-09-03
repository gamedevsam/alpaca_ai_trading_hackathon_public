import { AlpacaDuplicateOrderError, AlpacaOptionInstrument, AlpacaOrderValidationError } from '../alpaca.types';
import { createAlpacaClient } from '../alpaca_client.factory';
import {
  SimulatedAlpacaClient,
  simulatedOptionMarkFor,
  simulatedPriceFor,
  validateOrderRequest,
} from '../simulated_alpaca_client';

describe('SimulatedAlpacaClient', () => {
  it('is deterministic: two instances return identical account, positions, and prices', async () => {
    const a = new SimulatedAlpacaClient();
    const b = new SimulatedAlpacaClient();
    expect(await a.getAccount()).toEqual(await b.getAccount());
    expect(await a.getPositions()).toEqual(await b.getPositions());
    expect(simulatedPriceFor('AAPL')).toBe(simulatedPriceFor('AAPL'));
  });

  it('reports a paper account with seed positions and consistent equity', async () => {
    const client = new SimulatedAlpacaClient();
    const account = await client.getAccount();
    const positions = await client.getPositions();
    expect(account.currency).toBe('USD');
    expect(positions.map((p) => p.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    const positionsValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
    // equity = cash + market value of positions (cash is 100k by seed).
    expect(account.equity).toBeCloseTo(account.cash + positionsValue, 2);
    expect(account.portfolioValue).toBe(account.equity);
  });

  it('getAsset returns null for an untradable/unknown symbol and an asset for a known one', async () => {
    const client = new SimulatedAlpacaClient();
    expect(await client.getAsset('AAPL')).toEqual({ symbol: 'AAPL', tradable: true, fractionable: true });
    expect(await client.getAsset('aapl')).toEqual({ symbol: 'AAPL', tradable: true, fractionable: true });
    expect(await client.getAsset('NOTREAL')).toBeNull();
  });

  it('fills a marketable order immediately and stages it idempotently', async () => {
    const client = new SimulatedAlpacaClient();
    const order = await client.submitOrder({
      clientOrderId: 'act-1',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      timeInForce: 'day',
      qty: 10,
    });
    expect(order.id).toBe('sim-act-1');
    expect(order.status).toBe('filled');
    expect(order.filledQty).toBe(10);
    expect(order.filledAvgPrice).toBe(simulatedPriceFor('AAPL'));

    // Idempotency: a repeated clientOrderId throws, and the staged order is still retrievable.
    await expect(
      client.submitOrder({
        clientOrderId: 'act-1',
        symbol: 'AAPL',
        side: 'buy',
        type: 'market',
        timeInForce: 'day',
        qty: 10,
      }),
    ).rejects.toBeInstanceOf(AlpacaDuplicateOrderError);
    expect(await client.getOrderByClientOrderId('act-1')).toEqual(order);
    expect(await client.listOrders()).toHaveLength(1);
  });

  describe('option market data (B52)', () => {
    it('returns a deterministic option chain around the underlying price', async () => {
      const client = new SimulatedAlpacaClient();
      const chain = await client.getOptionChain('AAPL');
      expect(chain.length).toBeGreaterThan(0);

      const base = simulatedPriceFor('AAPL');
      for (const q of chain) {
        expect(q.underlying).toBe('AAPL');
        expect(['call', 'put']).toContain(q.right);
        // Strikes stay within the ±25% band, stepped $5.
        expect(q.strike).toBeGreaterThanOrEqual(5);
        expect(q.strike % 5).toBe(0);
        expect(q.strike).toBeLessThanOrEqual(base * 1.25 + 5);
        // Indicative feed → real quote, no greeks; mid is the average of the synthetic bid/ask.
        expect(q.bid).not.toBeNull();
        expect(q.ask).not.toBeNull();
        expect(q.mid).toBeCloseTo(((q.bid as number) + (q.ask as number)) / 2, 2);
        expect(q.mid).toBeCloseTo(simulatedOptionMarkFor(q.occSymbol), 1);
      }

      // Deterministic across instances.
      const again = await new SimulatedAlpacaClient().getOptionChain('AAPL');
      expect(again).toEqual(chain);
    });

    it('honors right / strike / limit filters', async () => {
      const client = new SimulatedAlpacaClient();
      const base = simulatedPriceFor('MSFT');
      const calls = await client.getOptionChain('MSFT', {
        right: 'call',
        strikeGte: base,
        strikeLte: base * 1.1,
        limit: 3,
      });
      expect(calls.length).toBeLessThanOrEqual(3);
      expect(calls.every((q) => q.right === 'call')).toBe(true);
      expect(calls.every((q) => q.strike >= base && q.strike <= base * 1.1)).toBe(true);
    });

    it('quotes a single OCC symbol and rejects an unparseable one', async () => {
      const client = new SimulatedAlpacaClient();
      const chain = await client.getOptionChain('AAPL', { right: 'call' });
      const target = chain[0];
      const quote = await client.getOptionQuote(target.occSymbol);
      expect(quote).not.toBeNull();
      expect(quote?.occSymbol).toBe(target.occSymbol);
      expect(quote?.mid).toBe(target.mid);

      expect(await client.getOptionQuote('NOT-AN-OCC-SYMBOL')).toBeNull();
    });
  });

  it('rests a non-marketable limit order as accepted (unfilled)', async () => {
    const client = new SimulatedAlpacaClient();
    const price = simulatedPriceFor('MSFT');
    const order = await client.submitOrder({
      clientOrderId: 'act-2',
      symbol: 'MSFT',
      side: 'buy',
      type: 'limit',
      timeInForce: 'day',
      qty: 5,
      limitPrice: price - 50, // below market → not marketable
    });
    expect(order.status).toBe('accepted');
    expect(order.filledQty).toBe(0);
    expect(order.filledAvgPrice).toBeNull();
  });

  it('derives a share qty for a notional order', async () => {
    const client = new SimulatedAlpacaClient();
    const price = simulatedPriceFor('NVDA');
    const order = await client.submitOrder({
      clientOrderId: 'act-3',
      symbol: 'NVDA',
      side: 'buy',
      type: 'market',
      timeInForce: 'day',
      notional: price * 2,
    });
    expect(order.qty).toBeCloseTo(2, 4);
    expect(order.notional).toBe(price * 2);
  });

  it('honors an explicitly closed market clock', async () => {
    const closed = new SimulatedAlpacaClient({ marketOpen: false });
    const clock = await closed.getClock();
    expect(clock.isOpen).toBe(false);
    expect(clock.nextOpen).not.toBeNull();
  });

  // B45: a filled order must update the ledger so a fill readback / reconciliation pass sees it.
  it('applies a filled buy to positions and cash (fill readback, B45)', async () => {
    const client = new SimulatedAlpacaClient();
    const price = simulatedPriceFor('AAPL');
    const before = await client.getAccount();

    await client.submitOrder({
      clientOrderId: 'act-buy',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      timeInForce: 'day',
      qty: 10,
    });

    const positions = await client.getPositions();
    const aapl = positions.find((p) => p.symbol === 'AAPL');
    expect(aapl?.qty).toBe(60); // 50 seeded + 10 filled
    const after = await client.getAccount();
    expect(after.cash).toBeCloseTo(before.cash - 10 * price, 2);
  });

  it('applies a filled sell to positions and cash, and a non-marketable order leaves the ledger untouched', async () => {
    const client = new SimulatedAlpacaClient();
    await client.submitOrder({
      clientOrderId: 'act-sell',
      symbol: 'AAPL',
      side: 'sell',
      type: 'market',
      timeInForce: 'day',
      qty: 20,
    });
    const positions = await client.getPositions();
    expect(positions.find((p) => p.symbol === 'AAPL')?.qty).toBe(30); // 50 seeded - 20 sold

    const price = simulatedPriceFor('MSFT');
    await client.submitOrder({
      clientOrderId: 'act-resting',
      symbol: 'MSFT',
      side: 'buy',
      type: 'limit',
      timeInForce: 'day',
      qty: 5,
      limitPrice: price - 50, // not marketable — must not touch the ledger
    });
    expect((await client.getPositions()).find((p) => p.symbol === 'MSFT')?.qty).toBe(20); // unchanged seed
  });

  it('resumes from a supplied initial position/cash state instead of the fixed seed', async () => {
    const client = new SimulatedAlpacaClient({
      initialPositions: [{ symbol: 'AAPL', qty: 60, avgEntryPrice: 170 }],
      initialCash: 50_000,
    });
    const positions = await client.getPositions();
    expect(positions).toEqual([expect.objectContaining({ symbol: 'AAPL', qty: 60, avgEntryPrice: 170 })]);
    const account = await client.getAccount();
    expect(account.cash).toBe(50_000);
  });
});

// B50 — the options position ledger + expiration/assignment settlement.
const CSP_INSTRUMENT: AlpacaOptionInstrument = {
  assetClass: 'option',
  underlying: 'AAPL',
  occSymbol: 'AAPL260801P00150000',
  expiration: '2026-08-01',
  strike: 150,
  right: 'put',
  multiplier: 100,
  positionIntent: 'sell_to_open',
};

// AAPL's deterministic price (`simulatedPriceFor`) is ~$34.36 — a $20 strike call is ITM, a $5,000
// strike call is deeply OTM (used by the expired-worthless test below).
const COVERED_CALL_INSTRUMENT: AlpacaOptionInstrument = {
  assetClass: 'option',
  underlying: 'AAPL',
  occSymbol: 'AAPL260801C00020000',
  expiration: '2026-08-01',
  strike: 20,
  right: 'call',
  multiplier: 100,
  positionIntent: 'sell_to_open',
};

describe('SimulatedAlpacaClient — options ledger (B50)', () => {
  it('fills a sell-to-open option order at the deterministic mark, crediting cash and going short', async () => {
    const client = new SimulatedAlpacaClient();
    const mark = simulatedOptionMarkFor(CSP_INSTRUMENT.occSymbol);
    const before = await client.getAccount();

    const order = await client.submitOrder({
      clientOrderId: 'opt-1',
      symbol: CSP_INSTRUMENT.occSymbol,
      side: 'sell',
      type: 'market',
      timeInForce: 'day',
      qty: 1,
      instrument: CSP_INSTRUMENT,
    });

    expect(order.status).toBe('filled');
    expect(order.filledQty).toBe(1);
    expect(order.filledAvgPrice).toBe(mark);

    const positions = await client.getPositions();
    const optionPosition = positions.find((p) => p.symbol === CSP_INSTRUMENT.occSymbol);
    expect(optionPosition).toMatchObject({ qty: -1, side: 'short', instrument: CSP_INSTRUMENT });
    expect(optionPosition?.daysToExpiry).toBeGreaterThan(0);

    const after = await client.getAccount();
    // Selling to open is a credit: cash increases by the premium (100 shares/contract).
    expect(after.cash).toBeCloseTo(before.cash + 100 * mark, 2);
  });

  it('closing (buy-to-close) an open short option flattens the ledger position', async () => {
    const client = new SimulatedAlpacaClient();
    await client.submitOrder({
      clientOrderId: 'opt-open',
      symbol: CSP_INSTRUMENT.occSymbol,
      side: 'sell',
      type: 'market',
      timeInForce: 'day',
      qty: 1,
      instrument: CSP_INSTRUMENT,
    });
    await client.submitOrder({
      clientOrderId: 'opt-close',
      symbol: CSP_INSTRUMENT.occSymbol,
      side: 'buy',
      type: 'market',
      timeInForce: 'day',
      qty: 1,
      instrument: { ...CSP_INSTRUMENT, positionIntent: 'buy_to_close' },
    });

    const positions = await client.getPositions();
    expect(positions.find((p) => p.symbol === CSP_INSTRUMENT.occSymbol)).toBeUndefined();
  });

  it('resumes an open option position from a supplied snapshot', async () => {
    const client = new SimulatedAlpacaClient({
      initialPositions: [],
      initialOptionPositions: [{ instrument: CSP_INSTRUMENT, qty: -1, avgEntryPrice: 3.5 }],
    });
    const positions = await client.getPositions();
    expect(positions).toEqual([
      expect.objectContaining({ symbol: CSP_INSTRUMENT.occSymbol, qty: -1, avgEntryPrice: 3.5 }),
    ]);
  });

  it('processExpirations is a no-op while every open option contract still has time left', async () => {
    const client = new SimulatedAlpacaClient({
      initialPositions: [],
      initialOptionPositions: [{ instrument: CSP_INSTRUMENT, qty: -1, avgEntryPrice: 3.5 }],
    });
    expect(await client.processExpirations()).toEqual([]);
    expect(await client.getPositions()).toHaveLength(1); // untouched
  });

  it('settles an in-the-money short PUT as an assignment: shares bought, cash paid at the strike', async () => {
    // AAPL's deterministic price (simulatedPriceFor) is well under the $150 strike, so this put is ITM.
    const client = new SimulatedAlpacaClient({
      initialPositions: [],
      initialCash: 100_000,
      initialOptionPositions: [{ instrument: CSP_INSTRUMENT, qty: -1, avgEntryPrice: 3.5 }],
      nowIso: '2026-09-01T00:00:00.000Z', // after the 2026-08-01 expiration
    });

    const outcomes = await client.processExpirations();

    expect(outcomes).toEqual([{ instrument: CSP_INSTRUMENT, outcome: 'assigned', contracts: 1 }]);
    const positions = await client.getPositions();
    expect(positions.find((p) => p.symbol === CSP_INSTRUMENT.occSymbol)).toBeUndefined(); // option position closed
    const aapl = positions.find((p) => p.symbol === 'AAPL');
    expect(aapl).toMatchObject({ qty: 100, avgEntryPrice: 150 }); // 100 shares put to us at the $150 strike
    const account = await client.getAccount();
    expect(account.cash).toBeCloseTo(100_000 - 100 * 150, 2); // paid the strike for the assigned shares
  });

  it('settles an in-the-money short CALL as an assignment: shares called away, cash received at the strike', async () => {
    const client = new SimulatedAlpacaClient({
      initialPositions: [{ symbol: 'AAPL', qty: 100, avgEntryPrice: 20 }],
      initialCash: 0,
      initialOptionPositions: [{ instrument: COVERED_CALL_INSTRUMENT, qty: -1, avgEntryPrice: 2 }],
      nowIso: '2026-09-01T00:00:00.000Z',
    });

    const outcomes = await client.processExpirations();

    expect(outcomes).toEqual([{ instrument: COVERED_CALL_INSTRUMENT, outcome: 'assigned', contracts: 1 }]);
    const positions = await client.getPositions();
    expect(positions.find((p) => p.symbol === COVERED_CALL_INSTRUMENT.occSymbol)).toBeUndefined();
    // All 100 shares were called away — the equity position is fully closed, not just reduced.
    expect(positions.find((p) => p.symbol === 'AAPL')).toBeUndefined();
    const account = await client.getAccount();
    expect(account.cash).toBeCloseTo(100 * 20, 2); // received the strike for the called-away shares
  });

  it('lets an out-of-the-money short option expire worthless with no shares/cash movement', async () => {
    // Strike $5,000 (far OTM for a call) — expires worthless, no assignment.
    const otmCall: AlpacaOptionInstrument = {
      ...COVERED_CALL_INSTRUMENT,
      occSymbol: 'AAPL260801C05000000',
      strike: 5_000,
    };
    const client = new SimulatedAlpacaClient({
      initialPositions: [{ symbol: 'AAPL', qty: 100, avgEntryPrice: 20 }],
      initialCash: 1_000,
      initialOptionPositions: [{ instrument: otmCall, qty: -1, avgEntryPrice: 2 }],
      nowIso: '2026-09-01T00:00:00.000Z',
    });

    const outcomes = await client.processExpirations();

    expect(outcomes).toEqual([{ instrument: otmCall, outcome: 'expired_worthless', contracts: 1 }]);
    const positions = await client.getPositions();
    expect(positions.find((p) => p.symbol === otmCall.occSymbol)).toBeUndefined();
    expect(positions.find((p) => p.symbol === 'AAPL')).toMatchObject({ qty: 100, avgEntryPrice: 20 }); // untouched
    expect((await client.getAccount()).cash).toBe(1_000); // untouched — the credit was already booked at open
  });
});

describe('validateOrderRequest', () => {
  const base = { clientOrderId: 'x', symbol: 'AAPL', side: 'buy', type: 'market', timeInForce: 'day' } as const;

  it('rejects missing idempotency key or symbol', () => {
    expect(() => validateOrderRequest({ ...base, clientOrderId: '', qty: 1 })).toThrow(AlpacaOrderValidationError);
    expect(() => validateOrderRequest({ ...base, symbol: '', qty: 1 })).toThrow(AlpacaOrderValidationError);
  });

  it('requires exactly one of qty or notional', () => {
    expect(() => validateOrderRequest({ ...base })).toThrow(/exactly one of qty or notional/);
    expect(() => validateOrderRequest({ ...base, qty: 1, notional: 1 })).toThrow(/exactly one of qty or notional/);
    expect(() => validateOrderRequest({ ...base, qty: 1 })).not.toThrow();
  });

  it('rejects non-positive amounts', () => {
    expect(() => validateOrderRequest({ ...base, qty: 0 })).toThrow(/qty must be positive/);
    expect(() => validateOrderRequest({ ...base, notional: -5 })).toThrow(/notional must be positive/);
  });

  it('enforces limit-price rules per order type', () => {
    expect(() => validateOrderRequest({ ...base, type: 'limit', qty: 1 })).toThrow(/limit orders require/);
    expect(() => validateOrderRequest({ ...base, type: 'market', qty: 1, limitPrice: 10 })).toThrow(
      /must not carry a limitPrice/,
    );
    expect(() => validateOrderRequest({ ...base, type: 'limit', qty: 1, limitPrice: 10 })).not.toThrow();
  });
});

describe('createAlpacaClient (the swap point)', () => {
  it('defaults to the simulated client', () => {
    const client = createAlpacaClient();
    expect(client.kind).toBe('simulated');
    expect(client.environment).toBe('paper');
  });

  it('refuses a real client without credentials', () => {
    expect(() => createAlpacaClient({ kind: 'paper' })).toThrow(/without credentials/);
  });

  it('refuses a live real client without the explicit owner-armed allowLive opt-in (B54)', () => {
    expect(() =>
      createAlpacaClient({ kind: 'paper', environment: 'live', credentials: { keyId: 'k', secret: 's' } }),
    ).toThrow(/owner-armed live toggle is not set/);
  });

  it('builds a real paper client when credentials are supplied', () => {
    const client = createAlpacaClient({ kind: 'paper', credentials: { keyId: 'k', secret: 's' } });
    expect(client.kind).toBe('paper');
    expect(client.environment).toBe('paper');
  });
});
