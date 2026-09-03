// Schema-only coverage for B46 (options instrument model, Layer A). No service/business logic here —
// `proposeAction` doesn't accept an option leg yet (that's B48); this just proves the `alpaca_action`
// body's new `instrument` field is shaped correctly: null for an equity action (unchanged), a well-formed
// single option leg validates, and a malformed one is rejected.

import { entity_alpaca_action } from '#schema_registry';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { CUSTOM_SCHEMA_KEYWORDS } from '~/api/admin/schema/lib/ajv';

function compileValidator(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv, ['date-time']);
  for (const keyword of CUSTOM_SCHEMA_KEYWORDS) {
    ajv.addKeyword(keyword);
  }
  return ajv.compile(schema);
}

const validateAction = compileValidator(entity_alpaca_action as object);

// A schema-valid `alpaca_action` with every required body field, so each test only has to vary
// `instrument` (and `symbol`/`side` to keep an option case internally sensible).
function makeAction(overrides: { symbol?: string; side?: 'buy' | 'sell'; instrument?: unknown }) {
  return {
    type: 'alpaca_action',
    header: {
      owner_user_id: 'USR_aaaaaaaaaaaaaaaaaaaa',
      environment: 'paper',
      status: 'proposed',
      last_activity_at: '2026-07-07T00:00:00.000Z',
    },
    body: {
      environment: 'paper',
      status: 'proposed',
      mandateId: null,
      symbol: overrides.symbol ?? 'AAPL',
      side: overrides.side ?? 'buy',
      orderType: 'limit',
      qty: 1,
      notional: null,
      limitPrice: 3.5,
      timeInForce: 'day',
      rationale: 'test',
      clearedLimits: [],
      approval: null,
      instrument: overrides.instrument ?? null,
      clientOrderId: 'alpaca-paper-test',
      alpacaOrderId: null,
      fills: [],
      events: [],
      errorMessage: null,
      optionOutcome: null,
    },
  };
}

const wellFormedOption = {
  assetClass: 'option',
  underlying: 'AAPL',
  occSymbol: 'AAPL250620C00200000',
  expiration: '2026-06-20',
  strike: 200,
  right: 'call',
  multiplier: 100,
  positionIntent: 'sell_to_open',
};

describe('alpaca_action schema — options instrument model (B46)', () => {
  it('validates an equity action with instrument: null (unchanged shape)', () => {
    expect(validateAction(makeAction({ instrument: null }))).toBe(true);
  });

  it('validates a well-formed single-leg option instrument', () => {
    const action = makeAction({
      symbol: wellFormedOption.occSymbol,
      side: 'sell',
      instrument: wellFormedOption,
    });
    expect(validateAction(action)).toBe(true);
  });

  it('rejects an instrument missing a required field (multiplier)', () => {
    const { multiplier: _multiplier, ...withoutMultiplier } = wellFormedOption;
    const action = makeAction({ instrument: withoutMultiplier });
    expect(validateAction(action)).toBe(false);
  });

  it('rejects an invalid `right`', () => {
    const action = makeAction({ instrument: { ...wellFormedOption, right: 'both' } });
    expect(validateAction(action)).toBe(false);
  });

  it('rejects an invalid `positionIntent`', () => {
    const action = makeAction({ instrument: { ...wellFormedOption, positionIntent: 'buy' } });
    expect(validateAction(action)).toBe(false);
  });

  it('rejects a malformed `expiration` (not YYYY-MM-DD)', () => {
    const action = makeAction({ instrument: { ...wellFormedOption, expiration: '06/20/2026' } });
    expect(validateAction(action)).toBe(false);
  });

  it('rejects an unknown extra property on the instrument (additionalProperties: false)', () => {
    const action = makeAction({ instrument: { ...wellFormedOption, legs: [] } });
    expect(validateAction(action)).toBe(false);
  });

  it('rejects an instrument that is not null or an object', () => {
    const action = makeAction({ instrument: 'AAPL250620C00200000' });
    expect(validateAction(action)).toBe(false);
  });
});
