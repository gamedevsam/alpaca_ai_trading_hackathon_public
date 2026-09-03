// THE SWAP POINT (B26 slice 1b, wired to real paper credentials B51).
//
// Every consumer of the Alpaca broker gets its client from here and only here. Selecting the
// simulated provider vs. the real paper client is a single config decision made in this one function.
//
// Provider resolution:
//   - kind 'simulated' (default)  → deterministic, seeded, no network. The owner's `alpaca_control.mode`
//     for the environment stays `dry_run` by default, which is what selects this (see
//     `AlpacaLifecycleService.createEnvironmentClient`).
//   - kind 'paper'                → real Alpaca paper REST client (fake money, real broker), selected
//     once the owner flips that environment's control `mode` to `paper`. Credentials + endpoint default
//     to `server_config.ts`'s `ALPACA_PAPER_*` vars; `config.credentials`/`config.baseUrl` override them
//     (tests, or a future per-user encrypted `alpaca_credentials` entity).
//
// Safety (B54): building a client for environment 'live' requires an explicit `allowLive: true` here —
// the deliberate defense-in-depth backstop. This flag is set in exactly one place: after
// `AlpacaLifecycleService.createEnvironmentClient` has confirmed the owner armed the live toggle
// (`alpaca_control.liveArmed === true`). So two independent gates must both hold before real money can
// move — the owner's armed toggle AND this explicit factory opt-in — and a stray `environment: 'live'`
// caller that forgets `allowLive` still hard-throws. When kind is 'paper' + environment 'live', creds and
// endpoint come from the `ALPACA_LIVE_*` config (distinct from the paper set).

import {
  ALPACA_LIVE_API_KEY,
  ALPACA_LIVE_ENDPOINT,
  ALPACA_LIVE_SECRET_KEY,
  ALPACA_PAPER_API_KEY,
  ALPACA_PAPER_ENDPOINT,
  ALPACA_PAPER_SECRET_KEY,
} from '~/server_config';
import { AlpacaClient, AlpacaClientKind, AlpacaEnvironment, AlpacaOptionInstrument } from './alpaca.types';
import { normalizeAlpacaBaseUrl, RealAlpacaPaperClient } from './real_alpaca_client';
import { SimulatedAlpacaClient } from './simulated_alpaca_client';

export interface AlpacaClientConfig {
  // Which implementation to build. Defaults to 'simulated' so the pipeline is exercisable with no key.
  kind?: AlpacaClientKind;
  environment?: AlpacaEnvironment;
  // Overrides the server-config `ALPACA_{PAPER,LIVE}_{API_KEY,SECRET_KEY,ENDPOINT}` defaults when
  // kind === 'paper' (tests / a future per-user encrypted `alpaca_credentials` entity). The default set
  // is selected by `environment` (paper → ALPACA_PAPER_*, live → ALPACA_LIVE_*).
  credentials?: { keyId: string; secret: string } | null;
  baseUrl?: string;
  // Required to build a real client for the `live` environment (B54). Without it, `environment: 'live'`
  // hard-throws. Set ONLY by `AlpacaLifecycleService.createEnvironmentClient` after it has verified the
  // owner's `alpaca_control.liveArmed` toggle is on — never hardcode `true` at any other call site.
  allowLive?: boolean;
  // Simulated-only knobs (deterministic clock control for tests/demos, plus resuming from a prior
  // reconciled state so fills carry forward across a fresh instance — see `AlpacaLifecycleService`).
  simulated?: {
    marketOpen?: boolean;
    nowIso?: string;
    initialPositions?: Array<{ symbol: string; qty: number; avgEntryPrice: number }>;
    initialCash?: number;
    initialOptionPositions?: Array<{ instrument: AlpacaOptionInstrument; qty: number; avgEntryPrice: number }>;
  };
}

export function createAlpacaClient(config: AlpacaClientConfig = {}): AlpacaClient {
  const kind: AlpacaClientKind = config.kind ?? 'simulated';
  const environment: AlpacaEnvironment = config.environment ?? 'paper';

  if (kind === 'paper') {
    // Live requires the explicit owner-armed opt-in (B54) — the defense-in-depth backstop. Refuse to
    // build a real client against the live account unless `allowLive` is set (only
    // `createEnvironmentClient` sets it, and only after checking `alpaca_control.liveArmed`).
    if (environment === 'live' && !config.allowLive) {
      throw new Error(
        'Refusing to build a live Alpaca client: the owner-armed live toggle is not set. Going live requires ' +
          'both an armed alpaca_control.liveArmed and the live trigger URL (B54).',
      );
    }
    const isLive = environment === 'live';
    const keyId = config.credentials?.keyId || (isLive ? ALPACA_LIVE_API_KEY : ALPACA_PAPER_API_KEY);
    const secret = config.credentials?.secret || (isLive ? ALPACA_LIVE_SECRET_KEY : ALPACA_PAPER_SECRET_KEY);
    if (!keyId || !secret) {
      const vars = isLive
        ? 'ALPACA_LIVE_API_KEY/ALPACA_LIVE_SECRET_KEY'
        : 'ALPACA_PAPER_API_KEY/ALPACA_PAPER_SECRET_KEY';
      throw new Error(
        `Cannot create a real ${environment} Alpaca client without credentials. Set ${vars}, or use kind: 'simulated'.`,
      );
    }
    const defaultEndpoint = isLive ? ALPACA_LIVE_ENDPOINT : ALPACA_PAPER_ENDPOINT;
    const baseUrl = normalizeAlpacaBaseUrl(config.baseUrl || defaultEndpoint);
    return new RealAlpacaPaperClient({ keyId, secret, baseUrl, environment });
  }

  return new SimulatedAlpacaClient({
    environment,
    marketOpen: config.simulated?.marketOpen,
    nowIso: config.simulated?.nowIso,
    initialPositions: config.simulated?.initialPositions,
    initialCash: config.simulated?.initialCash,
    initialOptionPositions: config.simulated?.initialOptionPositions,
  });
}
