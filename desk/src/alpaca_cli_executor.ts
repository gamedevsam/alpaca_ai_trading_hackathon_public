// Alpaca's own CLI as the ORDER-PLACEMENT transport (H1 — the hackathon's hard requirement).
//
// The hackathon requires the project to reach Alpaca through their MCP server or their CLI. This is the
// CLI half: when `ALPACA_EXECUTION_VIA=cli`, the one call that actually places an order shells out to
// `alpaca order submit` instead of POSTing `/v2/orders` ourselves. Everything else is unchanged —
// reads (account, positions, chain, quotes, order readback) stay on the typed HTTP client, every
// deterministic safeguard still runs before we get here, and `reconcileAction` still reads the fill back
// over HTTP. The CLI is a transport swap at one line of `executeAction`, not a second broker.
//
// SAFETY POSTURE — three things this deliberately does NOT do:
//   1. It refuses any environment other than `paper`. The CLI's own default is paper and we never set
//      `ALPACA_LIVE_TRADE`, so there is no code path here that can address the live account.
//   2. It runs `execFile` with an argv ARRAY and no shell, so a symbol or client-order-id can never be
//      interpreted as a command.
//   3. The child process gets a hand-built environment carrying only the two credential vars (plus PATH
//      and a scratch `ALPACA_CONFIG_DIR`), so it can neither read a stray profile on disk nor inherit
//      an `ALPACA_LIVE_TRADE=true` that leaked into the server's own environment.
//
// Behaviour verified by probing v0.0.14 against the paper broker on 2026-09-03 (plan §H1's two unknowns,
// plus one the probe turned up):
//   - An OCC contract symbol (`SPY251219P00600000`) passes through `--symbol` verbatim, as does
//     `--position-intent buy_to_open`; the dry-run body echoes both unchanged.
//   - `time_in_force` defaults to `day` when `--time-in-force` is omitted — we pass it explicitly anyway,
//     because an implicit default is not an audit trail.
//   - Exit 0 = success, JSON on stdout. Exit 1 = request/validation error, exit 2 = auth failure; both
//     print a JSON `{ error, hint, status, code, method, path, request_id }` object on stderr, where
//     `error` carries the broker's own message.
//   - A re-used `--client-order-id` is exit 1 / HTTP 422 / `"client_order_id must be unique"` — the
//     wording that `isDuplicateClientOrderIdBody` exists to recognise. See its comment in
//     `real_alpaca_client.ts`: the same predicate guards both transports.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AlpacaClientKind,
  AlpacaDuplicateOrderError,
  AlpacaEnvironment,
  AlpacaOrderRequest,
  AlpacaOrderResult,
} from './alpaca.types';
import { isDuplicateClientOrderIdBody, mapOrderWire } from './real_alpaca_client';
import { validateOrderRequest } from './simulated_alpaca_client';

const execFileAsync = promisify(execFile);

// The CLI retries 429/5xx itself (max 3, honouring Retry-After), so this only has to be longer than
// that worst case rather than a single request's timeout.
const CLI_TIMEOUT_MS = 60_000;

/** A CLI invocation that ended non-zero, carrying the structured error the CLI printed on stderr. */
export class AlpacaCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly httpStatus: number | null,
    readonly hint: string | null,
    // The CLI's structured stderr object, verbatim. Kept as parsed rather than folded into `message`
    // so error classification reads the broker's own body instead of our re-wording of it.
    readonly payload: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'AlpacaCliError';
  }
}

/** The verbatim receipt of one CLI invocation, persisted onto the action as execution evidence. */
export interface AlpacaCliReceipt {
  at: string;
  /** The exact command line, credentials never included (they are passed as env vars). */
  command: string;
  payload: Record<string, unknown>;
}

export interface AlpacaCliExecutorConfig {
  binaryPath: string;
  credentials: { keyId: string; secret: string };
  environment: AlpacaEnvironment;
}

export class AlpacaCliExecutor {
  private readonly binaryPath: string;
  private readonly credentials: { keyId: string; secret: string };

  constructor(config: AlpacaCliExecutorConfig) {
    if (config.environment !== 'paper') {
      // Defense in depth alongside the factory's `allowLive` backstop: the CLI path is paper-only, full
      // stop. Live execution is its own owner-gated slice and will not arrive by way of a transport swap.
      throw new Error(`AlpacaCliExecutor refuses environment '${config.environment}' — the CLI path is paper-only.`);
    }
    if (!config.credentials.keyId || !config.credentials.secret) {
      throw new Error('AlpacaCliExecutor requires Alpaca paper credentials (ALPACA_PAPER_API_KEY/SECRET_KEY).');
    }
    this.binaryPath = config.binaryPath;
    this.credentials = config.credentials;
  }

  /** `alpaca version` — the CLI build that placed an order, recorded on the action for the audit trail. */
  async version(): Promise<string> {
    const { stdout } = await this.run(['version']);
    return stdout.trim();
  }

  /**
   * `--dry-run`: the CLI prints the request body it WOULD send and exits without calling the API. This
   * is the pre-flight receipt — proof of the exact order our safeguards cleared, captured before
   * anything reaches the broker.
   */
  async dryRun(order: AlpacaOrderRequest): Promise<AlpacaCliReceipt> {
    const args = [...buildSubmitArgs(order), '--dry-run'];
    const { stdout } = await this.run(args);
    return { at: new Date().toISOString(), command: this.commandLine(args), payload: parseJsonObject(stdout, args) };
  }

  /**
   * `alpaca order submit --client-order-id <key>`: the real placement. The idempotency key is the one
   * already derived at propose time, so a retry is refused by the broker rather than duplicating the
   * order — surfaced as `AlpacaDuplicateOrderError` exactly like the HTTP client does, so the
   * lifecycle's existing "look the order up instead" branch handles it unchanged.
   */
  async submit(order: AlpacaOrderRequest): Promise<{ result: AlpacaOrderResult; receipt: AlpacaCliReceipt }> {
    validateOrderRequest(order);
    const args = buildSubmitArgs(order);
    let stdout: string;
    try {
      ({ stdout } = await this.run(args));
    } catch (error) {
      if (isDuplicateOrderError(error)) {
        throw new AlpacaDuplicateOrderError(order.clientOrderId);
      }
      throw error;
    }
    const payload = parseJsonObject(stdout, args);
    return {
      result: mapOrderWire(payload),
      receipt: { at: new Date().toISOString(), command: this.commandLine(args), payload },
    };
  }

  private commandLine(args: string[]): string {
    return [this.binaryPath, ...args].join(' ');
  }

  private async run(args: string[]): Promise<{ stdout: string }> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, args, {
        env: this.childEnv(),
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout };
    } catch (error) {
      throw toCliError(error, args, this.binaryPath);
    }
  }

  // Only what the CLI needs. Notably absent: ALPACA_LIVE_TRADE (its absence is what keeps the CLI on
  // paper) and the server's own environment, which would otherwise leak unrelated secrets into a child
  // process. `ALPACA_CONFIG_DIR` points at a scratch dir so a profile file on disk can never override
  // the credentials we pass, and `ALPACA_OUTPUT=json` pins the output format we parse.
  private childEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      ALPACA_CONFIG_DIR: '/tmp/alpaca-cli-config',
      ALPACA_OUTPUT: 'json',
      ALPACA_API_KEY: this.credentials.keyId,
      ALPACA_SECRET_KEY: this.credentials.secret,
    };
  }
}

/**
 * Does this submission go through the CLI? Three conditions must ALL hold, and each rules out a
 * different way the transport swap could go wrong:
 *   - `via === 'cli'` — the deployment opted in (`ALPACA_EXECUTION_VIA`).
 *   - the client is the real `paper` broker. This one is a safety property, not a preference: the
 *     simulated broker is an in-memory ledger with no account behind it, so shelling out while the
 *     owner's `alpaca_control.mode` is `dry_run` would place a REAL paper order the simulation never
 *     records — the audit trail and the broker would disagree. Dry-run must stay dry.
 *   - the environment is `paper` — belt to the executor constructor's braces, which throws otherwise.
 */
export function shouldExecuteViaCli(
  via: 'http' | 'cli',
  clientKind: AlpacaClientKind,
  environment: AlpacaEnvironment,
): boolean {
  return via === 'cli' && clientKind === 'paper' && environment === 'paper';
}

/**
 * Order request → CLI flags. `--quiet` suppresses the CLI's hints and colour so stdout is pure JSON;
 * `--position-intent` is passed for an option leg so the broker sees open-vs-close the same way the
 * HTTP path's instrument does.
 */
export function buildSubmitArgs(order: AlpacaOrderRequest): string[] {
  const args = [
    'order',
    'submit',
    '--symbol',
    order.symbol.toUpperCase(),
    '--side',
    order.side,
    '--type',
    order.type,
    // Proven default is `day`, but an implicit default is not an audit trail — always state it.
    '--time-in-force',
    order.timeInForce,
  ];
  if (order.qty != null) {
    args.push('--qty', String(order.qty));
  }
  if (order.notional != null) {
    args.push('--notional', String(order.notional));
  }
  if (order.limitPrice != null) {
    args.push('--limit-price', String(order.limitPrice));
  }
  if (order.instrument) {
    args.push('--position-intent', order.instrument.positionIntent);
  }
  args.push('--client-order-id', order.clientOrderId, '--quiet');
  return args;
}

function parseJsonObject(stdout: string, args: string[]): Record<string, unknown> {
  const text = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AlpacaCliError(
      `Alpaca CLI returned unparseable output for \`${args.join(' ')}\`: ${text.slice(0, 500)}`,
      0,
      null,
      null,
    );
  }
}

// The CLI's structured stderr error. Every field is optional in practice (a pre-flight failure carries
// no HTTP status), so nothing here assumes more than it can see.
interface CliErrorPayload {
  error?: string;
  hint?: string;
  status?: number;
  code?: number;
}

function toCliError(error: unknown, args: string[], binaryPath: string): AlpacaCliError {
  const err = error as { code?: number | string; stderr?: string; message?: string; killed?: boolean };

  // Two failures that never reach the broker, and so carry no exit code or stderr payload of their own.
  // Both are worth naming: an order that fails here fails for an OPERATIONAL reason, and an operator
  // reading `spawn alpaca ENOENT` on a failed action has to go source-diving to learn that the image is
  // missing the binary — while `Alpaca CLI error (HTTP 422): ...` next to it means something else
  // entirely. Say which one it is.
  if (err.code === 'ENOENT') {
    return new AlpacaCliError(
      `Alpaca CLI not found at '${binaryPath}' — ` +
        'ALPACA_EXECUTION_VIA=cli is set but the binary is not on PATH. Either deploy an image built with ' +
        'the `alpaca-cli` Dockerfile stage, or unset ALPACA_EXECUTION_VIA to place orders over HTTP.',
      0,
      null,
      null,
    );
  }
  if (err.killed) {
    return new AlpacaCliError(
      `Alpaca CLI timed out after ${CLI_TIMEOUT_MS}ms running \`${args.join(' ')}\` — the order may or may ` +
        'not have reached the broker. The client_order_id makes a retry safe: it will either place the ' +
        'order or be refused as a duplicate.',
      0,
      null,
      null,
    );
  }

  const exitCode = typeof err.code === 'number' ? err.code : 0;
  const payload = parseCliErrorPayload(err.stderr);
  const detail = payload?.error || err.message || 'Unknown Alpaca CLI failure.';
  const status = typeof payload?.status === 'number' && payload.status > 0 ? payload.status : null;
  const hint = payload?.hint || null;
  // Exit 2 is specifically an auth failure — worth naming, because it means the deployed credentials are
  // wrong rather than the order being bad, and the two demand very different responses from the owner.
  const prefix = exitCode === 2 ? 'Alpaca CLI authentication failed' : 'Alpaca CLI error';
  const statusPart = status ? ` (HTTP ${status})` : '';
  return new AlpacaCliError(
    `${prefix}${statusPart}: ${detail} [${args[0]} ${args[1] ?? ''}]`.trim(),
    exitCode,
    status,
    hint,
    payload as Record<string, unknown> | null,
  );
}

function parseCliErrorPayload(stderr: string | undefined): CliErrorPayload | null {
  if (!stderr) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stderr.trim());
    return parsed && typeof parsed === 'object' ? (parsed as CliErrorPayload) : null;
  } catch {
    return null;
  }
}

// Alpaca 422s a re-used client_order_id. Runs the SAME predicate the HTTP client does, over the broker's
// own error body, so both transports treat the idempotency guarantee firing as success-in-disguise rather
// than failure — and cannot drift apart on the one check that prevents a duplicated order.
function isDuplicateOrderError(error: unknown): boolean {
  if (!(error instanceof AlpacaCliError) || error.httpStatus !== 422) {
    return false;
  }
  return isDuplicateClientOrderIdBody(error.payload);
}
