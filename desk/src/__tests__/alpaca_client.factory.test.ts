import { normalizeAlpacaBaseUrl } from '../real_alpaca_client';

// The factory sources real-paper credentials/endpoint from server_config by default (B51) — mock it so
// these tests control exactly what "configured" looks like without touching a real .env.
jest.mock('~/server_config', () => ({
  ALPACA_PAPER_API_KEY: '',
  ALPACA_PAPER_SECRET_KEY: '',
  ALPACA_PAPER_ENDPOINT: 'https://paper-api.alpaca.markets',
  ALPACA_LIVE_API_KEY: '',
  ALPACA_LIVE_SECRET_KEY: '',
  ALPACA_LIVE_ENDPOINT: 'https://api.alpaca.markets',
}));

import { createAlpacaClient } from '../alpaca_client.factory';
import { SimulatedAlpacaClient } from '../simulated_alpaca_client';

describe('normalizeAlpacaBaseUrl', () => {
  it('appends /v2 when the configured endpoint omits it', () => {
    expect(normalizeAlpacaBaseUrl('https://paper-api.alpaca.markets')).toBe('https://paper-api.alpaca.markets/v2');
  });

  it('leaves an endpoint that already ends in /v2 unchanged', () => {
    expect(normalizeAlpacaBaseUrl('https://paper-api.alpaca.markets/v2')).toBe('https://paper-api.alpaca.markets/v2');
  });

  it('strips a trailing slash before checking for /v2', () => {
    expect(normalizeAlpacaBaseUrl('https://paper-api.alpaca.markets/v2/')).toBe('https://paper-api.alpaca.markets/v2');
    expect(normalizeAlpacaBaseUrl('https://paper-api.alpaca.markets/')).toBe('https://paper-api.alpaca.markets/v2');
  });
});

describe('createAlpacaClient', () => {
  it('defaults to the deterministic simulated client', () => {
    const client = createAlpacaClient();
    expect(client).toBeInstanceOf(SimulatedAlpacaClient);
    expect(client.kind).toBe('simulated');
  });

  it('refuses to build a live client without the explicit allowLive opt-in, even with credentials (B54)', () => {
    expect(() =>
      createAlpacaClient({ kind: 'paper', environment: 'live', credentials: { keyId: 'k', secret: 's' } }),
    ).toThrow(/owner-armed live toggle is not set/);
  });

  it('builds a live client when allowLive is set and live credentials are given (B54)', () => {
    const client = createAlpacaClient({
      kind: 'paper',
      environment: 'live',
      allowLive: true,
      credentials: { keyId: 'live-key', secret: 'live-secret' },
    });
    expect(client.kind).toBe('paper');
    expect(client.environment).toBe('live');
  });

  it('refuses a live client with allowLive but no live credentials configured (B54)', () => {
    expect(() => createAlpacaClient({ kind: 'paper', environment: 'live', allowLive: true })).toThrow(
      /Cannot create a real live Alpaca client without credentials.*ALPACA_LIVE_API_KEY/,
    );
  });

  it('refuses kind:paper without credentials configured anywhere', () => {
    expect(() => createAlpacaClient({ kind: 'paper', environment: 'paper' })).toThrow(
      /Cannot create a real paper Alpaca client without credentials/,
    );
  });

  it('builds a real paper client from explicit credentials (override), independent of server_config', () => {
    const client = createAlpacaClient({
      kind: 'paper',
      environment: 'paper',
      credentials: { keyId: 'test-key', secret: 'test-secret' },
    });
    expect(client.kind).toBe('paper');
    expect(client.environment).toBe('paper');
  });
});
