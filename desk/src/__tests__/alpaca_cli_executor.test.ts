// H1 — the Alpaca CLI execution path.
//
// The CLI's own behaviour was verified by probing v0.0.14 against the paper broker on 2026-09-03 (the
// findings are recorded at the top of `alpaca_cli_executor.ts`). These tests cover OUR side of that
// contract — the argv we hand it, and the two guarantees that a wrong answer would quietly break:
// paper-only construction, and recognising the broker's duplicate-order refusal.

import { AlpacaOrderRequest } from '../alpaca.types';
import { AlpacaCliExecutor, buildSubmitArgs, shouldExecuteViaCli } from '../alpaca_cli_executor';
import { isDuplicateClientOrderIdBody } from '../real_alpaca_client';

const optionOrder: AlpacaOrderRequest = {
  symbol: 'SPY251219P00600000',
  side: 'buy',
  type: 'limit',
  timeInForce: 'day',
  qty: 1,
  limitPrice: 5.25,
  clientOrderId: 'act-abc123',
  instrument: {
    occSymbol: 'SPY251219P00600000',
    underlying: 'SPY',
    expiration: '2025-12-19',
    right: 'put',
    strike: 600,
    positionIntent: 'buy_to_open',
    multiplier: 100,
  },
};

describe('buildSubmitArgs (H1)', () => {
  it('passes an OCC contract symbol and position intent through verbatim', () => {
    const args = buildSubmitArgs(optionOrder);
    // Proven against the real CLI: `--symbol` accepts an OCC symbol unchanged, and the dry-run body
    // echoes both it and `--position-intent` back as sent.
    expect(args).toEqual([
      'order',
      'submit',
      '--symbol',
      'SPY251219P00600000',
      '--side',
      'buy',
      '--type',
      'limit',
      '--time-in-force',
      'day',
      '--qty',
      '1',
      '--limit-price',
      '5.25',
      '--position-intent',
      'buy_to_open',
      '--client-order-id',
      'act-abc123',
      '--quiet',
    ]);
  });

  it('always states time-in-force explicitly, even though the CLI defaults to day', () => {
    // The default is `day` either way — but an audit trail that relies on a broker-side default is not
    // an audit trail. The flag must be present on every order we place.
    const args = buildSubmitArgs({ ...optionOrder, timeInForce: 'day' });
    expect(args).toContain('--time-in-force');
    expect(args[args.indexOf('--time-in-force') + 1]).toBe('day');
  });

  it('omits the flags for values the order does not carry', () => {
    const marketEquity: AlpacaOrderRequest = {
      symbol: 'spy',
      side: 'sell',
      type: 'market',
      timeInForce: 'day',
      qty: 3,
      clientOrderId: 'act-xyz',
    };
    const args = buildSubmitArgs(marketEquity);
    expect(args).not.toContain('--limit-price');
    expect(args).not.toContain('--notional');
    expect(args).not.toContain('--position-intent');
    // The symbol is normalized the same way the HTTP client normalizes it.
    expect(args[args.indexOf('--symbol') + 1]).toBe('SPY');
  });

  it('never puts a credential on the command line', () => {
    // Credentials reach the CLI as environment variables only — the command line is persisted verbatim
    // onto the action as execution evidence, so a secret here would land in the audit trail.
    const args = buildSubmitArgs(optionOrder);
    expect(args.join(' ')).not.toMatch(/--api-key|--secret|PK[A-Z0-9]{10,}/);
  });
});

describe('AlpacaCliExecutor construction (H1)', () => {
  const credentials = { keyId: 'PKTEST', secret: 'secret' };

  it('builds for the paper environment', () => {
    expect(() => new AlpacaCliExecutor({ binaryPath: 'alpaca', credentials, environment: 'paper' })).not.toThrow();
  });

  it('refuses the live environment outright', () => {
    // Defense in depth alongside the factory's `allowLive` backstop: live execution is its own
    // owner-gated slice and must never arrive by way of a transport swap.
    expect(() => new AlpacaCliExecutor({ binaryPath: 'alpaca', credentials, environment: 'live' })).toThrow(
      /paper-only/,
    );
  });

  it('refuses to run without credentials rather than falling through to a profile on disk', () => {
    expect(
      () =>
        new AlpacaCliExecutor({ binaryPath: 'alpaca', credentials: { keyId: '', secret: '' }, environment: 'paper' }),
    ).toThrow(/ALPACA_PAPER_API_KEY/);
  });
});

describe('isDuplicateClientOrderIdBody — the idempotency guarantee (H1)', () => {
  it("recognises the broker's actual duplicate wording", () => {
    // Captured verbatim from the paper broker on 2026-09-03 by submitting the same client_order_id
    // twice. Note there is no "exists" anywhere in it — the reason this predicate exists.
    expect(
      isDuplicateClientOrderIdBody({
        code: 42210000,
        error: 'client_order_id must be unique',
        status: 422,
      }),
    ).toBe(true);
  });

  it('recognises the older "already exists" phrasing too', () => {
    // Both transports must keep recovering if the broker reverts to its previous copy.
    expect(isDuplicateClientOrderIdBody({ message: 'client_order_id already exists' })).toBe(true);
  });

  it('accepts a raw string body as well as a parsed one', () => {
    // The HTTP client passes axios' parsed body; the CLI passes its parsed stderr. A non-JSON body
    // must still be matchable rather than throwing.
    expect(isDuplicateClientOrderIdBody('client_order_id must be unique')).toBe(true);
  });

  it('does not mistake an unrelated 422 for the guarantee firing', () => {
    // This is the dangerous direction: treating a genuine rejection as "already placed" would make the
    // desk look up an order that does not exist and report a failure it never had.
    expect(isDuplicateClientOrderIdBody({ code: 42210000, error: 'asset "ZZZZNOTREAL" not found' })).toBe(false);
    expect(isDuplicateClientOrderIdBody({ error: 'insufficient buying power' })).toBe(false);
    expect(isDuplicateClientOrderIdBody(null)).toBe(false);
    expect(isDuplicateClientOrderIdBody(undefined)).toBe(false);
  });
});

describe('shouldExecuteViaCli — when the transport swaps (H1)', () => {
  it('uses the CLI only for the real paper broker with the deployment opted in', () => {
    expect(shouldExecuteViaCli('cli', 'paper', 'paper')).toBe(true);
  });

  it('leaves the default deployment on HTTP', () => {
    expect(shouldExecuteViaCli('http', 'paper', 'paper')).toBe(false);
  });

  it('never shells out for the simulated broker, even with the CLI opted in', () => {
    // The safety property: while the owner's control mode is `dry_run` the broker is an in-memory
    // ledger. Shelling out would place a REAL paper order that the simulation never records, leaving
    // the audit trail and the broker disagreeing. Dry-run stays dry.
    expect(shouldExecuteViaCli('cli', 'simulated', 'paper')).toBe(false);
  });

  it('never shells out for the live environment', () => {
    expect(shouldExecuteViaCli('cli', 'paper', 'live')).toBe(false);
    expect(shouldExecuteViaCli('cli', 'simulated', 'live')).toBe(false);
  });
});
