import { mapOptionSettlementActivities } from '../real_alpaca_client';

// B53: the real paper client sources assignment/expiry from Alpaca's account-activities feed. These
// exercise the pure mapper against representative wire shapes (the network GET itself is exercised by the
// live read-only probe documented in the memory log, and by the owner's eventual real-expiry run).
describe('mapOptionSettlementActivities', () => {
  it('maps OPASN (short leg assigned) to an assigned outcome with the parsed contract identity', () => {
    const [outcome] = mapOptionSettlementActivities([
      { id: '1', activity_type: 'OPASN', date: '2026-08-01', symbol: 'AAPL260801P00150000', qty: '2' },
    ]);
    expect(outcome).toEqual({
      instrument: {
        assetClass: 'option',
        underlying: 'AAPL',
        occSymbol: 'AAPL260801P00150000',
        expiration: '2026-08-01',
        strike: 150,
        right: 'put',
        multiplier: 100,
        positionIntent: 'buy_to_close',
      },
      outcome: 'assigned',
      contracts: 2,
    });
  });

  it('maps OPEXP to expired_worthless and OPEXC (long exercise) to assigned', () => {
    const outcomes = mapOptionSettlementActivities([
      { activity_type: 'OPEXP', symbol: 'MSFT260918C00500000', qty: '1' },
      { activity_type: 'OPEXC', symbol: 'MSFT260918P00400000', qty: '3' },
    ]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['expired_worthless', 'assigned']);
    expect(outcomes[0].instrument.right).toBe('call');
    expect(outcomes[1].contracts).toBe(3);
  });

  it('parses qty from a number or the cum_qty fallback, and takes the absolute count', () => {
    const outcomes = mapOptionSettlementActivities([
      { activity_type: 'OPEXP', symbol: 'AAPL260801P00150000', qty: -2 },
      { activity_type: 'OPASN', symbol: 'AAPL260801C00200000', qty: null, cum_qty: '4' },
    ]);
    expect(outcomes[0].contracts).toBe(2);
    expect(outcomes[1].contracts).toBe(4);
  });

  it('ignores non-settlement activity types and non-option / unparseable symbols', () => {
    const outcomes = mapOptionSettlementActivities([
      { activity_type: 'FILL', symbol: 'AAPL260801P00150000', qty: '1' }, // not a settlement type
      { activity_type: 'OPASN', symbol: 'AAPL', qty: '1' }, // equity leg of an assignment — not a contract
      { activity_type: 'OPEXP', symbol: 'not-an-occ-symbol', qty: '1' },
      { activity_type: 'OPEXP', symbol: undefined, qty: '1' },
      { activity_type: 'OPEXP', symbol: 'AAPL260801P00150000', qty: '1' }, // the one real settlement
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].instrument.occSymbol).toBe('AAPL260801P00150000');
  });

  it('is a no-op on an empty / missing feed', () => {
    expect(mapOptionSettlementActivities([])).toEqual([]);
    expect(mapOptionSettlementActivities(undefined as never)).toEqual([]);
  });
});
