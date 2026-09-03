import { entity_alpaca_account_snapshot, entity_alpaca_action, entity_alpaca_control } from '#schema_registry';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityService } from '~/entity/entity.service';
import { generateEntityId } from '~/utilities/generate_xid';
import {
  AlpacaAccountInfo,
  AlpacaClient,
  AlpacaClientKind,
  AlpacaClockInfo,
  AlpacaDuplicateOrderError,
  AlpacaEnvironment,
  AlpacaOptionInstrument,
  AlpacaOptionRight,
  AlpacaOrderRequest,
  AlpacaOrderResult,
  AlpacaOrderValidationError,
  AlpacaPositionIntent,
  AlpacaPositionInfo,
  buildOccSymbol,
} from './alpaca.types';
import { ALPACA_CLI_PATH, ALPACA_EXECUTION_VIA, ALPACA_PAPER_API_KEY, ALPACA_PAPER_SECRET_KEY } from '~/server_config';
import { createAlpacaClient } from './alpaca_client.factory';
import { AlpacaCliExecutor, AlpacaCliReceipt, shouldExecuteViaCli } from './alpaca_cli_executor';
import {
  AlpacaControlLimits,
  AlpacaExecutionGate,
  AlpacaKillState,
  computeOptionDelta,
  daysUntilExpiration,
  deltaSourceOf,
  NormalizedProposal,
  OptionProposalContext,
  runProposalPreChecks,
} from './alpaca_safeguards';
import { validateOrderRequest } from './simulated_alpaca_client';

/**
 * Alpaca action lifecycle service (B26 slice 1c) — the `draft → proposed` half of the spine.
 *
 * Takes a proposed trade, runs it through the deterministic safeguards (alpaca_safeguards.ts), and
 * persists a schema-validated `alpaca_action` entity that stops at `proposed` (cleared all checks,
 * awaiting human approval) or `discarded` (failed a pre-check / kill switch). NOTHING here approves,
 * submits, or touches real money — real broker execution is real money (paper, since B51), gated by the
 * owner's own `alpaca_control.mode` toggle. The broker is reached only through `createEnvironmentClient`,
 * which resolves simulated vs. real paper from that per-environment control at `createAlpacaClient`'s one
 * factory boundary — zero changes to anything below this point regardless of which broker answers.
 *
 * Reuses existing primitives only (EntityService EAV CRUD, the typed Alpaca client, feature flags) —
 * no new architectural pattern.
 */

// The execution receipt persisted on an action (H1) — derived from the schema so the two can never
// drift. `via` records WHICH transport placed the order; the CLI branch additionally carries the exact
// command line, the dry-run body the broker was going to be sent, and its verbatim response.
type ActionExecution = NonNullable<$.AlpacaAction['body']['execution']>;

// Default control used when the owner hasn't configured an `alpaca_control` for the environment yet.
// Per design §4: first launch is disarmed + dry-run with conservative, owner-overridable ceilings.
export const DEFAULT_PAPER_CONTROL: {
  environment: AlpacaEnvironment;
  killState: AlpacaKillState;
  mode: 'dry_run' | 'paper' | 'live';
  // H4's autonomy gate. Defaults to `per_action` — the desk proposes and waits for a human.
  executionGate: AlpacaExecutionGate;
  // The owner-armed live toggle (B54). Real money can only move when this is explicitly true AND the live
  // trigger URL is fired — building a live broker client is refused otherwise. Default false = disarmed.
  liveArmed: boolean;
  limits: AlpacaControlLimits;
} = {
  environment: 'paper',
  killState: 'disarmed',
  mode: 'dry_run',
  executionGate: 'per_action',
  liveArmed: false,
  limits: {
    maxNotionalPerOrder: 10_000,
    maxPositionPct: 25,
    maxOrdersPerDay: 10,
    maxDailyNotional: 50_000,
    symbolAllowList: [],
    symbolDenyList: [],
    optionsEnabled: false,
    cooldownAfterFailureMs: 60_000,
    // Conservative options defaults (B47) — options stay disabled above until the owner opts in; these
    // ceilings apply once `optionsEnabled` is flipped on.
    maxContractsPerOrder: 5,
    maxContractsPerUnderlying: 10,
    maxShortCallCoveredPct: 75,
    minDaysToExpiry: 7,
    maxDaysToExpiry: 45,
    requireOtm: true,
    minStrikeVsCostBasisPct: 100,
    maxAbsDelta: 0.35,
    earningsBlackoutDays: 3,
  },
};

// How long a proposed action waits for approval before it should be treated as expired (design §3).
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export type ApprovalDecision = 'approved' | 'rejected';

// The runtime-steerable half of `alpaca_control` (H4). Deliberately narrow: `mode`, `liveArmed` and every
// ceiling stay out, so turning autonomy on can never also widen a limit or promote the desk to a real
// broker as a side effect. Both fields are optional; at least one must be present.
// Lets a non-interactive caller (H4's autonomous cycle) record WHY the decision was made in the action's
// own timeline. Nothing else about the decision changes — the guarded execute runs either way.
export interface DecideActionOptions {
  message?: string;
}

export interface SetControlInput {
  executionGate?: AlpacaExecutionGate;
  killState?: AlpacaKillState;
  /** A partial patch over the ceilings. Only the keys present are written; the rest keep their stored value. */
  limits?: Partial<AlpacaControlLimits>;
}

/** Ceilings that take a non-negative number, or `null` meaning "no cap". */
const NUMERIC_LIMIT_KEYS = [
  'maxNotionalPerOrder',
  'maxPositionPct',
  'maxOrdersPerDay',
  'maxDailyNotional',
  'cooldownAfterFailureMs',
  'maxContractsPerOrder',
  'maxContractsPerUnderlying',
  'maxShortCallCoveredPct',
  'minDaysToExpiry',
  'maxDaysToExpiry',
  'minStrikeVsCostBasisPct',
  'maxAbsDelta',
  'earningsBlackoutDays',
] as const satisfies readonly (keyof AlpacaControlLimits)[];

const BOOLEAN_LIMIT_KEYS = ['optionsEnabled', 'requireOtm'] as const satisfies readonly (keyof AlpacaControlLimits)[];
const SYMBOL_LIST_LIMIT_KEYS = [
  'symbolAllowList',
  'symbolDenyList',
] as const satisfies readonly (keyof AlpacaControlLimits)[];

/**
 * Validate a ceiling patch off the wire. Everything the owner can raise, he can also mistype, and a
 * ceiling that silently became `NaN` or `-1` would read as "no cap" to a check that only asks whether a
 * value is above it — so a bad field is a 400 here rather than a limit that quietly stops limiting.
 */
function parseLimitsInput(input: Partial<AlpacaControlLimits> | undefined): Partial<AlpacaControlLimits> | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('limits must be an object of ceiling fields.');
  }

  const known = new Set<string>([...NUMERIC_LIMIT_KEYS, ...BOOLEAN_LIMIT_KEYS, ...SYMBOL_LIST_LIMIT_KEYS]);
  const unknownKeys = Object.keys(input).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    throw new BadRequestException(`Unknown limit field(s): ${unknownKeys.join(', ')}.`);
  }

  const patch: Partial<AlpacaControlLimits> = {};
  for (const key of NUMERIC_LIMIT_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new BadRequestException(`${key} must be a number >= 0, or null for no cap.`);
    }
    patch[key] = value;
  }
  for (const key of BOOLEAN_LIMIT_KEYS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') {
      throw new BadRequestException(`${key} must be true or false.`);
    }
    patch[key] = input[key];
  }
  for (const key of SYMBOL_LIST_LIMIT_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (!Array.isArray(value) || value.some((symbol) => typeof symbol !== 'string' || !symbol.trim())) {
      throw new BadRequestException(`${key} must be an array of non-empty ticker strings.`);
    }
    patch[key] = value.map((symbol) => symbol.trim().toUpperCase());
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

const EXECUTION_GATES = ['per_action', 'fully_autonomous'] as const satisfies readonly AlpacaExecutionGate[];
const KILL_STATES = ['armed', 'disarmed', 'killed'] as const satisfies readonly AlpacaKillState[];

/** Accept only a member of `allowed` (or nothing at all) — anything else is a 400, never a silent write. */
function parseEnumInput<T extends string>(field: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

// The option leg to propose (B48, Level 1 scope — covered calls + cash-secured puts, single-leg only
// per B46). `underlying` isn't repeated here — it's the top-level `symbol` on `ProposeActionInput`, same
// field equity proposals use, so the safeguards checks (allow/deny-list, tradability, holdings) evaluate
// against the underlying exactly as B47's tests assume.
export interface ProposeOptionLegInput {
  expiration: string; // YYYY-MM-DD
  strike: number;
  right: AlpacaOptionRight;
  positionIntent: AlpacaPositionIntent;
  multiplier?: number; // defaults to 100 (standard equity option contract)
}

export interface ProposeActionInput {
  environment?: AlpacaEnvironment;
  mandateId?: string | null;
  symbol: string;
  // Ignored when `optionLeg` is set — side is derived from `optionLeg.positionIntent` instead, so the
  // two can never disagree.
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  // Shares for an equity proposal, contracts for an option proposal.
  qty?: number | null;
  notional?: number | null;
  limitPrice?: number | null;
  timeInForce?: 'day' | 'gtc';
  rationale?: string;
  optionLeg?: ProposeOptionLegInput | null;
  // The creator calls (H14 `alpaca_signal` ids) the proposing agent said it acted on — provenance only.
  // Nothing here is trusted for a safeguard decision; the ceilings are evaluated exactly as they are for a
  // proposal that cites nothing.
  signalIds?: string[];
}

/**
 * The owner's runtime control as every surface reads it — stated explicitly rather than inferred, so the
 * two fail-closed reads inside `getControl` (`killState`, `executionGate`) keep their narrow types on the
 * way out instead of widening to `string` at the first consumer.
 */
export interface AlpacaControlView {
  killState: AlpacaKillState;
  mode: $.AlpacaControl['body']['mode'];
  liveArmed: boolean;
  executionGate: AlpacaExecutionGate;
  limits: AlpacaControlLimits;
}

export interface AlpacaAccountView {
  kind: AlpacaClient['kind'];
  environment: AlpacaEnvironment;
  account: Awaited<ReturnType<AlpacaClient['getAccount']>>;
  positions: AlpacaPositionInfo[];
  clock: Awaited<ReturnType<AlpacaClient['getClock']>>;
}

@Injectable()
export class AlpacaLifecycleService {
  private readonly logger = new Logger(AlpacaLifecycleService.name);

  constructor(private readonly entityService: EntityService) {}

  /**
   * Read-only account/positions/clock (simulated today). Prefers the last reconciled
   * `alpaca_account_snapshot` when one exists (B45) so a prior fill's effect is visible on the next
   * read, falling back to a fresh broker pull (the seed) when nothing has ever been reconciled.
   */
  async readAccount(userId: string, environment: AlpacaEnvironment = 'paper'): Promise<AlpacaAccountView> {
    const client = await this.createEnvironmentClient(userId, environment);
    const [account, positions, clock] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
      client.getClock(),
    ]);
    return { kind: client.kind, environment, account, positions, clock };
  }

  /**
   * Build the broker client for an environment. Which implementation depends on the environment's
   * `alpaca_control.mode` (B51): the default `dry_run` resumes the deterministic simulated broker from
   * the persisted `alpaca_account_snapshot` (our last reconciled belief), so a fresh instance carries
   * forward prior fills — the simulated broker has no durable state of its own (B45). Once the owner
   * flips `mode` to `paper`, this instead builds the real Alpaca paper client (credentials/endpoint from
   * `server_config.ts` via the factory), which reads its own live state straight from the broker — no
   * snapshot resume needed. Since B50, the snapshot's `positions` carries both equity rows and option
   * rows (the latter tagged with `instrument`) in one array — split them back into the two ledgers the
   * simulated client resumes from.
   */
  async createEnvironmentClient(userId: string, environment: AlpacaEnvironment): Promise<AlpacaClient> {
    const control = await this.getControl(userId, environment);
    const kind: AlpacaClientKind = control.mode === 'dry_run' ? 'simulated' : 'paper';

    // B54's owner-armed live gate — the single chokepoint every broker access flows through (read,
    // propose, execute, reconcile, trade cycle). Building ANY client for the live environment requires
    // the owner to have explicitly armed `alpaca_control.liveArmed`; otherwise fail closed. `allowLive`
    // is the factory's matching backstop — both must hold before a live client is constructed.
    const allowLive = environment === 'live';
    if (allowLive && !control.liveArmed) {
      throw new Error(
        `Live Alpaca environment is disarmed — set alpaca_control.liveArmed=true to arm it (B54). ` +
          `No live client is built and no live order can be placed until then.`,
      );
    }

    if (kind === 'paper') {
      return createAlpacaClient({ kind, environment, allowLive });
    }

    const snapshot = await this.findAccountSnapshot(userId, environment);
    if (!snapshot) {
      return createAlpacaClient({ kind, environment, allowLive });
    }
    const equityPositions = snapshot.body.positions.filter((p) => !p.instrument);
    const optionPositions = snapshot.body.positions.filter(
      (p): p is typeof p & { instrument: AlpacaOptionInstrument } => p.instrument != null,
    );
    return createAlpacaClient({
      kind,
      environment,
      simulated: {
        initialCash: snapshot.body.account.cash,
        initialPositions: equityPositions.map((p) => ({
          symbol: p.symbol,
          qty: p.qty,
          avgEntryPrice: p.avgEntryPrice,
        })),
        initialOptionPositions: optionPositions.map((p) => ({
          instrument: p.instrument,
          qty: p.qty,
          avgEntryPrice: p.avgEntryPrice,
        })),
      },
    });
  }

  /**
   * Pull account/positions/clock from an already-constructed client (e.g. one that just had
   * `processExpirations()` mutate its in-memory ledger, B50) and persist them as the environment's
   * account snapshot — reused by the trade-cycle service so an expiration/assignment pass's effect on
   * cash/shares is durably reconciled the same way a fill is.
   */
  async captureAccountSnapshot(userId: string, environment: AlpacaEnvironment, client: AlpacaClient): Promise<void> {
    const [account, positions, clock] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
      client.getClock(),
    ]);
    await this.upsertAccountSnapshot(userId, environment, account, positions, clock);
  }

  private async findAccountSnapshot(
    userId: string,
    environment: AlpacaEnvironment,
  ): Promise<Required<$.AlpacaAccountSnapshot> | null> {
    return this.entityService.findFirst<$.AlpacaAccountSnapshot>({
      where: {
        type: 'alpaca_account_snapshot',
        owner_id: userId,
        external_id: accountSnapshotExternalId(environment),
        status: 'active',
      },
    });
  }

  /** The owner's control (kill switch / mode / limits) for an environment, or the safe default. */
  async getControl(userId: string, environment: AlpacaEnvironment = 'paper'): Promise<AlpacaControlView> {
    const controls = await this.entityService.findMany<$.AlpacaControl>({
      where: { type: 'alpaca_control', owner_id: userId, status: 'active' },
    });
    const stored = controls.find((c) => c.body.environment === environment);
    if (stored) {
      return {
        killState: stored.body.killState as AlpacaKillState,
        mode: stored.body.mode,
        // Absent on any control written before B54 → disarmed. Only an explicit stored `true` arms live.
        liveArmed: stored.body.liveArmed === true,
        // Same fail-closed read for H4's gate: only the explicit string opts into autonomy, so a control
        // written before H4 (or with the field stripped) reads as `per_action` and nothing self-approves.
        executionGate: stored.body.executionGate === 'fully_autonomous' ? 'fully_autonomous' : 'per_action',
        limits: stored.body.limits as AlpacaControlLimits,
      };
    }
    return {
      killState: DEFAULT_PAPER_CONTROL.killState,
      mode: DEFAULT_PAPER_CONTROL.mode,
      liveArmed: DEFAULT_PAPER_CONTROL.liveArmed,
      executionGate: DEFAULT_PAPER_CONTROL.executionGate,
      limits: DEFAULT_PAPER_CONTROL.limits,
    };
  }

  /**
   * H4 — set the owner's runtime controls (autonomy gate, kill switch) for an environment, creating the
   * control from the safe defaults when none exists yet. Returns the control as `getControl` reads it.
   *
   * `executionGate`, `killState` and the `limits` ceilings are writable here. `mode` and `liveArmed` are
   * not, and are left exactly as stored — so raising a ceiling can never arm a live broker as a side
   * effect, and the kill switch still overrides every ceiling either way.
   *
   * The ceilings are the owner's risk appetite, so he can raise, lower or remove them while using the
   * product (owner directive 2026-09-03) — a limit he cannot change is a limit he works around. Each
   * field is validated before it lands: a ceiling that became `NaN` through a typo would read as "no cap"
   * to the checks, which is the one failure mode that must not be reachable from a text input.
   */
  async setControl(userId: string, environment: AlpacaEnvironment, input: SetControlInput) {
    // The body arrives untyped off the wire, so validate before it can reach the entity — a clean 400
    // beats a schema-validation 500, and an unrecognized gate must never be persisted as autonomy.
    const executionGate = parseEnumInput('executionGate', input?.executionGate, EXECUTION_GATES);
    const killState = parseEnumInput('killState', input?.killState, KILL_STATES);
    const limits = parseLimitsInput(input?.limits);
    if (!executionGate && !killState && !limits) {
      throw new BadRequestException('Nothing to set — supply executionGate, killState and/or limits.');
    }

    const controls = await this.entityService.findMany<$.AlpacaControl>({
      where: { type: 'alpaca_control', owner_id: userId, status: 'active' },
    });
    const stored = controls.find((c) => c.body.environment === environment);

    if (stored) {
      await this.entityService.update<$.AlpacaControl>(stored, (draft) => {
        if (executionGate) {
          draft.body.executionGate = executionGate;
        }
        if (killState) {
          draft.body.killState = killState;
          // The header mirrors the kill state — it's what the entity list/status filters read.
          draft.header.status = killState;
        }
        if (limits) {
          // A patch, not a replacement: a caller that sends one ceiling must not silently reset the
          // other twelve to whatever its client-side defaults happened to be.
          Object.assign(draft.body.limits, limits);
        }
      });
    } else {
      const resolvedKillState = killState ?? DEFAULT_PAPER_CONTROL.killState;
      await this.entityService.upsert<$.AlpacaControl>(
        entity_alpaca_control.new({
          owner_id: userId,
          header: { owner_user_id: userId, environment, status: resolvedKillState },
          body: {
            environment,
            killState: resolvedKillState,
            mode: DEFAULT_PAPER_CONTROL.mode,
            liveArmed: DEFAULT_PAPER_CONTROL.liveArmed,
            executionGate: executionGate ?? DEFAULT_PAPER_CONTROL.executionGate,
            // Same patch semantics as the update branch, over the safe defaults rather than over stored
            // values — so the first write can set a ceiling without having to restate all sixteen.
            limits: { ...DEFAULT_PAPER_CONTROL.limits, ...limits },
          },
        }),
      );
    }

    this.logger.log(
      `Alpaca control (${environment}) updated by ${userId}: ` +
        [
          executionGate && `executionGate=${executionGate}`,
          killState && `killState=${killState}`,
          // Name every ceiling that moved and to what. A raised ceiling is the owner's decision and has
          // to be legible afterwards in the log, not only in the entity's version history.
          limits &&
            `limits{${Object.entries(limits)
              .map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(' ')}]` : value}`)
              .join(' ')}}`,
        ]
          .filter(Boolean)
          .join(', '),
    );
    return this.getControl(userId, environment);
  }

  /**
   * Run a proposal through the deterministic safeguards and persist the resulting `alpaca_action`.
   * Returns the persisted entity (`proposed` if every check cleared, else `discarded`). Never executes.
   */
  async proposeAction(userId: string, input: ProposeActionInput): Promise<Required<$.AlpacaAction>> {
    const environment = input.environment ?? 'paper';
    const symbol = input.symbol.trim().toUpperCase();
    const timeInForce = input.timeInForce ?? 'day';
    const now = new Date().toISOString();

    // The client_order_id is derived from the (pre-generated) action id so a retry/double-worker can
    // never place the same order twice — Alpaca rejects a duplicate client_order_id (design §4.5).
    const actionId = generateEntityId(entity_alpaca_action);
    const clientOrderId = `alpaca-${environment}-${actionId}`;

    const optionLeg = input.optionLeg ?? null;
    if (optionLeg) {
      validateOptionLeg(optionLeg);
    }
    const instrument: AlpacaOptionInstrument | null = optionLeg
      ? {
          assetClass: 'option',
          underlying: symbol,
          occSymbol: buildOccSymbol(symbol, optionLeg.expiration, optionLeg.right, optionLeg.strike),
          expiration: optionLeg.expiration,
          strike: optionLeg.strike,
          right: optionLeg.right,
          multiplier: optionLeg.multiplier ?? 100,
          positionIntent: optionLeg.positionIntent,
        }
      : null;

    const proposal: NormalizedProposal = {
      symbol,
      // For an option leg, side is derived from positionIntent so it can never disagree with it.
      side: instrument ? deriveSideFromIntent(instrument.positionIntent) : input.side,
      orderType: input.orderType,
      qty: input.qty ?? null,
      notional: input.notional ?? null,
      limitPrice: input.limitPrice ?? null,
      timeInForce,
      instrument,
    };

    const client = await this.createEnvironmentClient(userId, environment);
    const control = await this.getControl(userId, environment);

    // Gather broker state + same-day activity for the deterministic checks (all I/O lives here).
    const [account, positions, asset, today] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
      client.getAsset(symbol),
      this.loadTodaysActivity(userId, environment),
    ]);

    // Options need extra evaluation context the safeguards can't derive from account/positions alone
    // (B47's `OptionProposalContext`) — see `buildOptionContext`.
    const optionContext = instrument
      ? await this.buildOptionContext(userId, environment, symbol, instrument, account, positions, client)
      : null;

    const orderRequest: AlpacaOrderRequest = {
      clientOrderId,
      // For an option order the broker-facing symbol is the OCC contract, per `AlpacaOrderRequest.symbol`.
      symbol: instrument ? instrument.occSymbol : symbol,
      side: proposal.side,
      type: proposal.orderType,
      timeInForce,
      qty: proposal.qty,
      notional: proposal.notional,
      limitPrice: proposal.limitPrice,
      instrument,
    };
    const { orderRequestValid, orderRequestError } = checkOrderRequest(orderRequest);

    const result = runProposalPreChecks(proposal, {
      killState: control.killState,
      limits: control.limits,
      buyingPower: account.buyingPower,
      equity: account.equity,
      positions,
      asset,
      todayOrderCount: today.count,
      todayNotional: today.notional,
      orderRequestValid,
      orderRequestError,
      option: optionContext,
    });

    const status: $.AlpacaAction['body']['status'] = result.passed ? 'proposed' : 'discarded';
    const events = [
      { at: now, status: 'draft', message: 'Action drafted from proposal request.' },
      {
        at: now,
        status,
        message: result.passed
          ? 'All deterministic pre-checks cleared — awaiting human approval.'
          : `Discarded: ${result.failedSummary}`,
      },
    ];

    const action = entity_alpaca_action.new({
      id: actionId,
      // We pre-generate the id (to derive the deterministic clientOrderId before persistence), so we
      // must also supply created_at: prepareEntityToValidate treats "id present, created_at absent" as
      // a malformed update and rejects it. A caller that chooses its own id owns the full identity.
      created_at: now,
      owner_id: userId,
      header: { owner_user_id: userId, environment, status, last_activity_at: now },
      body: {
        environment,
        status,
        mandateId: input.mandateId?.trim() || '',
        symbol,
        side: proposal.side,
        orderType: proposal.orderType,
        // Conceptually-nullable amounts are stored as the 0 sentinel (the validator's runtime schema
        // requires a number); the order semantics are carried by which of qty/notional is non-zero.
        qty: proposal.qty ?? 0,
        notional: proposal.notional ?? 0,
        limitPrice: proposal.limitPrice ?? 0,
        timeInForce,
        rationale: input.rationale?.trim() || '',
        // Which creator calls this proposal cites (H15). Empty for a manual proposal and for a
        // deterministic-fallback dry-run, which reasoned about no signal at all.
        signalIds: [...new Set(input.signalIds ?? [])],
        clearedLimits: result.checks,
        approval: null,
        // Null for an equity proposal; the B46 option-contract identity for an options proposal (B48).
        instrument,
        clientOrderId,
        alpacaOrderId: '',
        fills: [],
        events,
        expiresAt: result.passed ? new Date(Date.now() + PROPOSAL_TTL_MS).toISOString() : null,
        errorMessage: result.passed ? '' : result.failedSummary,
        // Set only once the option's contract reaches expiration (B50's trade-cycle reconciliation pass).
        optionOutcome: null,
      },
    });

    const saved = await this.entityService.upsert<$.AlpacaAction>(action);
    this.logger.log(
      `Alpaca action ${actionId} for ${symbol} ${proposal.side} → ${status}` +
        (result.passed ? '' : ` (${result.failedSummary})`),
    );
    return saved;
  }

  /**
   * Record the owner's approve/reject decision on a `proposed` action (B16, the approval surface).
   *
   * Authenticated: the caller is the logged-in owner (A6 → Option B — no login-free token mutation), so
   * the decision is attributed to the session user. `approved` is *permission to execute* — per design
   * §6 ("tapping Approve ... triggers the guarded execute"), an approval immediately hands off to
   * `executeAction` (B45), which re-runs every safeguard against FRESH broker state before anything
   * reaches the broker. Approval is necessary but not sufficient: if conditions drifted since proposal,
   * the guarded re-check fails closed and the action ends `discarded`, never executed, even though the
   * owner just approved it.
   *
   * Fail-closed: only a still-`proposed` action the caller owns can be decided (a re-decision or a decision
   * on a discarded/expired action is a 409). A proposal past its TTL is transitioned to `expired` and
   * returned un-decided — an owner can't approve a stale proposal whose conditions may have moved.
   */
  async decideAction(
    userId: string,
    id: string,
    decision: ApprovalDecision,
    options: DecideActionOptions = {},
  ): Promise<Required<$.AlpacaAction>> {
    const action = await this.loadOwnedAction(userId, id);
    if (action.body.status !== 'proposed') {
      throw new ConflictException(`Action ${id} is ${action.body.status}, not awaiting approval.`);
    }

    const now = new Date().toISOString();

    // TTL fail-closed: a lapsed proposal can never be approved — flip it to expired and return it un-decided.
    if (action.body.expiresAt && Date.parse(action.body.expiresAt) <= Date.now()) {
      this.logger.log(`Alpaca action ${id} expired before a decision (TTL lapsed).`);
      return this.entityService.update<$.AlpacaAction>(action, (draft) => {
        draft.body.status = 'expired';
        draft.header.status = 'expired';
        draft.header.last_activity_at = now;
        draft.body.events.push({
          at: now,
          status: 'expired',
          message: 'Proposal expired before a decision was recorded — re-propose to act.',
        });
      });
    }

    // H4: an auto-approval passes its own message so the timeline names the gate that granted it rather
    // than claiming the owner clicked. The decision itself is identical — same guarded execute below.
    const message =
      options.message ??
      (decision === 'approved' ? 'Approved by owner — permission to execute.' : 'Rejected by owner.');

    const saved = await this.entityService.update<$.AlpacaAction>(action, (draft) => {
      draft.body.status = decision;
      draft.header.status = decision;
      draft.body.approval = { decision, decidedAt: now, decidedBy: userId, tokenId: null };
      draft.header.last_activity_at = now;
      draft.body.events.push({ at: now, status: decision, message });
    });
    this.logger.log(`Alpaca action ${id} ${decision} by ${userId}.`);

    if (decision === 'rejected') {
      return saved;
    }
    // Guarded execute (design §6): approval hands off immediately to execution, which re-runs every
    // safeguard against fresh broker state before anything reaches the broker (B45; options since B50 —
    // the simulated broker now carries an options position ledger, so an option action executes through
    // the same submitted → filled → reconciled spine as an equity one).
    return this.executeAction(userId, id);
  }

  /**
   * Guarded execute — the `approved → submitted → filled → reconciled` spine (B45), run only against
   * the deterministic `SimulatedAlpacaClient` today. Reachable only via `decideAction('approved')`.
   *
   * Critical rule (design §3): approval is necessary but NOT sufficient — every safeguard is re-run here
   * against FRESH broker state (kill switch, limits, buying power, holdings, tradability). A stale
   * approval can't fire if conditions changed since proposal; a failed re-check ends the action
   * `discarded`, never executed. This re-check, the idempotent `client_order_id` (already derived at
   * propose time), and the reconciliation pass are the reusable pattern real-paper execution (B51) wires
   * to unchanged — only the broker client at `createEnvironmentClient` swaps.
   */
  private async executeAction(userId: string, id: string): Promise<Required<$.AlpacaAction>> {
    const action = await this.loadOwnedAction(userId, id);
    if (action.body.status !== 'approved') {
      throw new ConflictException(`Action ${id} is ${action.body.status}, not approved for execution.`);
    }

    const environment = action.body.environment as AlpacaEnvironment;
    const client = await this.createEnvironmentClient(userId, environment);
    const control = await this.getControl(userId, environment);
    const instrument = action.body.instrument as AlpacaOptionInstrument | null;

    const proposal: NormalizedProposal = {
      symbol: action.body.symbol,
      side: action.body.side,
      orderType: action.body.orderType,
      qty: action.body.qty || null,
      notional: action.body.notional || null,
      limitPrice: action.body.limitPrice || null,
      timeInForce: action.body.timeInForce,
      instrument,
    };
    const orderRequest: AlpacaOrderRequest = {
      clientOrderId: action.body.clientOrderId,
      // For an option order the broker-facing symbol is the OCC contract, same as at propose time.
      symbol: instrument ? instrument.occSymbol : proposal.symbol,
      side: proposal.side,
      type: proposal.orderType,
      timeInForce: proposal.timeInForce,
      qty: proposal.qty,
      notional: proposal.notional,
      limitPrice: proposal.limitPrice,
      instrument,
    };
    const { orderRequestValid, orderRequestError } = checkOrderRequest(orderRequest);

    const [account, positions, asset, today] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
      client.getAsset(action.body.symbol),
      this.loadTodaysActivity(userId, environment),
    ]);

    // Re-derive the same option evaluation context proposal-time used (B47's `OptionProposalContext`),
    // excluding THIS action's own pledge from the book-state tally — it's already `approved`/counted as
    // open, and double-counting it against itself would make every option re-check spuriously fail.
    const optionContext = instrument
      ? await this.buildOptionContext(
          userId,
          environment,
          action.body.symbol,
          instrument,
          account,
          positions,
          client,
          id,
        )
      : null;

    const recheck = runProposalPreChecks(proposal, {
      killState: control.killState,
      limits: control.limits,
      buyingPower: account.buyingPower,
      equity: account.equity,
      positions,
      asset,
      todayOrderCount: today.count,
      todayNotional: today.notional,
      orderRequestValid,
      orderRequestError,
      option: optionContext,
    });

    if (!recheck.passed) {
      const discardedAt = new Date().toISOString();
      this.logger.warn(`Alpaca action ${id} discarded at execution re-check: ${recheck.failedSummary}`);
      return this.entityService.update<$.AlpacaAction>(action, (draft) => {
        draft.body.status = 'discarded';
        draft.header.status = 'discarded';
        draft.body.clearedLimits = recheck.checks;
        draft.body.errorMessage = `Execution re-check failed: ${recheck.failedSummary}`;
        draft.header.last_activity_at = discardedAt;
        draft.body.events.push({
          at: discardedAt,
          status: 'discarded',
          message: `Conditions changed since approval — execution re-check failed: ${recheck.failedSummary}`,
        });
      });
    }

    // Submit — idempotent by clientOrderId (design §4.5): a retry can never place the order twice.
    // H1: WHICH transport places it is a one-config swap (`ALPACA_EXECUTION_VIA`). `cli` shells out to
    // Alpaca's own CLI — a `--dry-run` receipt first, then the real `order submit` carrying the same
    // idempotency key — and applies only to the real paper broker; the simulated client never shells out.
    // Everything either side of this is identical: the safeguards above already ran, and reconciliation
    // below still reads the fill back over HTTP.
    const cli = this.createCliExecutor(client, environment);
    const execution: ActionExecution = { via: cli ? 'cli' : 'http', cliVersion: null, dryRun: null, submit: null };
    let orderResult: AlpacaOrderResult;
    try {
      if (cli) {
        execution.cliVersion = await cli.version();
        execution.dryRun = toDryRunReceipt(await cli.dryRun(orderRequest));
        const placed = await cli.submit(orderRequest);
        execution.submit = toSubmitReceipt(placed.receipt);
        orderResult = placed.result;
      } else {
        orderResult = await client.submitOrder(orderRequest);
      }
    } catch (error) {
      if (!(error instanceof AlpacaDuplicateOrderError)) {
        const failedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : 'Unknown submission error.';
        this.logger.error(`Alpaca action ${id} failed to submit: ${message}`);
        return this.entityService.update<$.AlpacaAction>(action, (draft) => {
          draft.body.status = 'failed';
          draft.header.status = 'failed';
          draft.body.errorMessage = message;
          // Keep the receipt even on failure — the dry-run body is exactly what the owner needs to see
          // when a submission is rejected, and dropping it would leave the audit trail silent.
          draft.body.execution = execution;
          draft.header.last_activity_at = failedAt;
          draft.body.events.push({ at: failedAt, status: 'failed', message: `Submission failed: ${message}` });
        });
      }
      // The idempotency guarantee fired — the order already exists from a prior attempt at this same
      // client_order_id. Look it up instead of treating the retry as a failure (design §4.5).
      const existingOrder = await client.getOrderByClientOrderId(orderRequest.clientOrderId);
      if (!existingOrder) {
        throw error;
      }
      orderResult = existingOrder;
    }

    const submittedAt = new Date().toISOString();
    const submitted = await this.entityService.update<$.AlpacaAction>(action, (draft) => {
      draft.body.status = 'submitted';
      draft.header.status = 'submitted';
      draft.body.alpacaOrderId = orderResult.id;
      draft.body.execution = execution;
      draft.header.last_activity_at = submittedAt;
      draft.body.events.push({
        at: submittedAt,
        status: 'submitted',
        message:
          // `cliVersion` is the string the CLI reports for itself, which already carries its own
          // leading "v" — don't add a second one.
          `Order submitted to broker via ${execution.via === 'cli' ? `the Alpaca CLI${execution.cliVersion ? ` ${execution.cliVersion}` : ''}` : 'the trading API'} ` +
          `(client_order_id=${orderRequest.clientOrderId}, order_id=${orderResult.id}).`,
      });
    });

    return this.reconcileAction(userId, submitted, client, orderResult);
  }

  /**
   * The CLI executor for this submission, or `null` to place the order over HTTP as before (H1). The
   * conditions live in `shouldExecuteViaCli` — see there for why each one matters.
   *
   * Falling back to HTTP is deliberate rather than an error: the CLI is a transport for the one
   * placement call, and a deployment without the binary must still be able to trade.
   */
  private createCliExecutor(client: AlpacaClient, environment: AlpacaEnvironment): AlpacaCliExecutor | null {
    if (!shouldExecuteViaCli(ALPACA_EXECUTION_VIA, client.kind, environment)) {
      return null;
    }
    return new AlpacaCliExecutor({
      binaryPath: ALPACA_CLI_PATH,
      credentials: { keyId: ALPACA_PAPER_API_KEY, secret: ALPACA_PAPER_SECRET_KEY },
      environment,
    });
  }

  /**
   * Re-check every action still sitting at `submitted` against the broker's own order status, and route
   * each through the same `reconcileAction` a fresh submission uses.
   *
   * Without this, a resting order is a one-way door. `reconcileAction` runs exactly once — immediately
   * after we submit — and its `else` branch leaves an accepted/new order `submitted`, noting that "a later
   * manual re-check or the B50 monitoring pass catches the eventual terminal outcome". No such re-check
   * existed: B50's pass settles *expirations of filled options*, not the fate of a resting order. So an
   * order that was later cancelled or expired at the broker — by the owner, by the exchange, by anything
   * that is not our own submit call — stayed `submitted` in our book forever.
   *
   * That is not cosmetic, because `submitted` counts as an open collateral commitment
   * (`OPEN_OPTION_STATUSES`) and `sumShortPutCollateral` therefore keeps pledging its strike against every
   * future proposal. Observed on prod 2026-09-03: one QQQ 701P the owner cancelled at the broker held
   * $70,100 of a $100,000 account hostage, so `defined_risk_floor` refused every subsequent cash-secured
   * put — the broker said $100,000 available while our own book said $29,900, and the tighter figure binds.
   * The desk had room for exactly one more trade before freezing again.
   *
   * Safety note: an order the broker cannot find is left alone rather than assumed dead. Releasing
   * collateral on a lookup failure would be the dangerous direction — it would let the desk over-commit
   * against an order that is, in fact, still working.
   */
  async reconcileRestingOrders(
    userId: string,
    environment: AlpacaEnvironment,
    client?: AlpacaClient,
  ): Promise<Required<$.AlpacaAction>[]> {
    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active' },
    });
    const resting = actions.filter((a) => a.body.environment === environment && a.body.status === 'submitted');
    if (resting.length === 0) return [];

    const brokerClient = client ?? (await this.createEnvironmentClient(userId, environment));
    const reconciled: Required<$.AlpacaAction>[] = [];
    for (const action of resting) {
      const clientOrderId = action.body.clientOrderId;
      if (!clientOrderId) continue;
      try {
        const orderResult = await brokerClient.getOrderByClientOrderId(clientOrderId);
        if (!orderResult) {
          this.logger.warn(
            `Resting order not found at the broker, leaving it submitted: action_id='${action.id}', client_order_id='${clientOrderId}'.`,
          );
          continue;
        }
        const next = await this.reconcileAction(userId, action as Required<$.AlpacaAction>, brokerClient, orderResult);
        if (next.body.status !== 'submitted') reconciled.push(next);
      } catch (error) {
        // One unreadable order must never abort the cycle it runs at the head of.
        this.logger.error(
          `Failed to reconcile a resting order: action_id='${action.id}', cause='${
            error instanceof Error ? error.message : String(error)
          }'`,
        );
      }
    }
    return reconciled;
  }

  /**
   * Fill readback + reconciliation pass (design §4.6, mechanical form): pulls the broker's account and
   * positions (from the SAME client instance that submitted the order, so a fill applied within this
   * request is visible) and persists them to `alpaca_account_snapshot`. Finalizes the action's terminal
   * status from the broker's own order-status readback rather than trusting the submit-time snapshot.
   */
  private async reconcileAction(
    userId: string,
    action: Required<$.AlpacaAction>,
    client: AlpacaClient,
    orderResult: AlpacaOrderResult,
  ): Promise<Required<$.AlpacaAction>> {
    const environment = action.body.environment as AlpacaEnvironment;
    const [account, positions, clock] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
      client.getClock(),
    ]);
    await this.upsertAccountSnapshot(userId, environment, account, positions, clock);

    const reconciledAt = new Date().toISOString();
    const fills =
      orderResult.filledQty > 0
        ? [{ qty: orderResult.filledQty, price: orderResult.filledAvgPrice ?? 0, filledAt: orderResult.submittedAt }]
        : [];

    return this.entityService.update<$.AlpacaAction>(action, (draft) => {
      draft.body.fills = fills;
      draft.header.last_activity_at = reconciledAt;
      if (orderResult.status === 'filled') {
        draft.body.status = 'reconciled';
        draft.header.status = 'reconciled';
        draft.body.events.push(
          {
            at: reconciledAt,
            status: 'filled',
            message: `Filled ${orderResult.filledQty} @ $${(orderResult.filledAvgPrice ?? 0).toFixed(2)}.`,
          },
          {
            at: reconciledAt,
            status: 'reconciled',
            message: 'Position and account snapshot reconciled against the broker.',
          },
        );
      } else if (orderResult.status === 'rejected' || orderResult.status === 'canceled') {
        const nextStatus = orderResult.status === 'rejected' ? 'failed' : 'canceled';
        draft.body.status = nextStatus;
        draft.header.status = nextStatus;
        draft.body.events.push({
          at: reconciledAt,
          status: nextStatus,
          message: `Broker reported the order ${orderResult.status}.`,
        });
      } else {
        // Still resting (accepted/new/pending_new/partially_filled) — stays submitted; a later manual
        // re-check or the B50 monitoring pass catches the eventual terminal outcome.
        draft.body.events.push({
          at: reconciledAt,
          status: 'submitted',
          message: `Still resting at the broker (${orderResult.status}) — account snapshot refreshed.`,
        });
      }
    });
  }

  /**
   * Upsert the per-environment `alpaca_account_snapshot` (keyed by a deterministic `external_id`, not
   * the generated entity id — see the repo coding guide's idempotent-upsert-by-external_id pattern).
   */
  private async upsertAccountSnapshot(
    userId: string,
    environment: AlpacaEnvironment,
    account: AlpacaAccountInfo,
    positions: AlpacaPositionInfo[],
    clock: AlpacaClockInfo,
  ): Promise<void> {
    const capturedAt = new Date().toISOString();
    const header = { owner_user_id: userId, environment, captured_at: capturedAt };
    const body: $.AlpacaAccountSnapshot['body'] = { environment, capturedAt, account, positions, clock };

    const existing = await this.findAccountSnapshot(userId, environment);
    if (existing) {
      await this.entityService.update<$.AlpacaAccountSnapshot>(existing, (draft) => {
        draft.body = body;
        draft.header = header;
      });
      return;
    }

    await this.entityService.upsert<$.AlpacaAccountSnapshot>(
      entity_alpaca_account_snapshot.new({
        owner_id: userId,
        external_id: accountSnapshotExternalId(environment),
        header,
        body,
      }),
    );
  }

  /** Load an `alpaca_action` the caller owns, or 404. Shared by the approve/reject/execute paths. */
  private async loadOwnedAction(userId: string, id: string): Promise<Required<$.AlpacaAction>> {
    const action = await this.entityService.findById<$.AlpacaAction>(id);
    if (!action || action.owner_id !== userId || action.type !== 'alpaca_action' || action.status !== 'active') {
      throw new NotFoundException('Alpaca action not found.');
    }
    return action;
  }

  /**
   * Recent `alpaca_action`s for the environment, newest first — powers the slice 1d proposed-trade
   * timeline. Read-only; never mutates. Sorted in memory by activity time (no index needed at this scale).
   */
  async listActions(
    userId: string,
    environment: AlpacaEnvironment = 'paper',
    limit = 25,
  ): Promise<Array<Required<$.AlpacaAction>>> {
    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active' },
    });
    return actions
      .filter((a) => a.body.environment === environment)
      .sort((a, b) => activityTime(b) - activityTime(a))
      .slice(0, limit) as Array<Required<$.AlpacaAction>>;
  }

  /** Count + total estimated notional of today's non-discarded actions, for the per-day rate ceilings. */
  private async loadTodaysActivity(
    userId: string,
    environment: AlpacaEnvironment,
  ): Promise<{ count: number; notional: number }> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startIso = startOfDay.toISOString();

    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active', created_at: { gte: startIso } },
    });

    // A discarded action never consumed any budget; count only those that count against the day.
    const counted = actions.filter(
      (a) => a.body.environment === environment && a.body.status !== 'discarded' && a.body.status !== 'rejected',
    );
    const notional = counted.reduce((sum, a) => sum + estimateStoredNotional(a.body), 0);
    return { count: counted.length, notional: round2(notional) };
  }

  /**
   * Every open option action in this environment — the book the collateral tallies below are computed
   * from. A proxy over `alpaca_action` history rather than the B50 broker position ledger, because a
   * `proposed`/`approved` action hasn't reached the broker yet — it wouldn't show up in `getPositions()`
   * even though its collateral is already spoken for. `excludeActionId` drops the action itself out of
   * the tally (needed at execute-time re-check — the action is already `approved`/counted as open, so it
   * would otherwise pledge against its own collateral). "Open" = not yet terminally closed/discarded.
   */
  private async loadOpenOptionActions(
    userId: string,
    environment: AlpacaEnvironment,
    excludeActionId?: string,
  ): Promise<Array<$.AlpacaAction>> {
    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active' },
    });
    return actions.filter(
      (a) =>
        a.body.instrument != null &&
        a.id !== excludeActionId &&
        a.body.environment === environment &&
        OPEN_OPTION_STATUSES.has(a.body.status),
    );
  }

  /**
   * Cash the whole open book has already reserved against short puts — **account-wide, across every
   * underlying** (H16). The broker secures every cash-secured put out of the same pool of options buying
   * power whatever the name is, so this is the number that decides whether one more put is affordable.
   * Public because the H0 candidate builder sizes against it too: sizing off the account's raw `cash`
   * builds contracts the broker refuses with `insufficient options buying power … available: 0`.
   */
  async cashPledgedToOpenCsps(
    userId: string,
    environment: AlpacaEnvironment,
    excludeActionId?: string,
  ): Promise<number> {
    return sumShortPutCollateral(await this.loadOpenOptionActions(userId, environment, excludeActionId));
  }

  /**
   * Contracts/collateral already committed to OTHER open option actions — feeds B47's
   * `sharesPledgedToOtherShortCalls` / `cashPledgedToOtherCsps` / `existingContractsOnUnderlying`, so two
   * simultaneous proposals can't double-pledge the same shares/cash.
   *
   * Note the deliberate asymmetry (H16): shares and the contract count are **per underlying** — only AAPL
   * shares can cover a short AAPL call, and the contract cap is a per-name ceiling by definition — while
   * pledged cash is **account-wide**, because short-put collateral is one shared pool at the broker.
   */
  private async computeOptionBookState(
    userId: string,
    environment: AlpacaEnvironment,
    underlying: string,
    excludeActionId?: string,
  ): Promise<{
    sharesPledgedToOtherShortCalls: number;
    cashPledgedToOtherCsps: number;
    existingContractsOnUnderlying: number;
  }> {
    const open = await this.loadOpenOptionActions(userId, environment, excludeActionId);

    let sharesPledged = 0;
    let contracts = 0;
    for (const a of open) {
      const instrument = a.body.instrument;
      if (!instrument || instrument.underlying !== underlying) {
        continue;
      }
      const qty = a.body.qty || 0;
      contracts += qty;
      if (instrument.positionIntent === 'sell_to_open' && instrument.right === 'call') {
        sharesPledged += qty * instrument.multiplier;
      }
    }
    return {
      sharesPledgedToOtherShortCalls: round2(sharesPledged),
      cashPledgedToOtherCsps: sumShortPutCollateral(open),
      existingContractsOnUnderlying: contracts,
    };
  }

  /**
   * Shared option-evaluation-context builder for the B47 safeguards (`OptionProposalContext`) — used by
   * both `proposeAction` and `executeAction`'s re-check, so the two evaluate an option leg identically.
   * `excludeActionId` is passed through to `computeOptionBookState` (set at execute-time only, to a
   * still-open action's own id, so it doesn't pledge against itself).
   */
  private async buildOptionContext(
    userId: string,
    environment: AlpacaEnvironment,
    underlying: string,
    instrument: AlpacaOptionInstrument,
    account: AlpacaAccountInfo,
    positions: AlpacaPositionInfo[],
    client: AlpacaClient,
    excludeActionId?: string,
  ): Promise<OptionProposalContext> {
    const held = positions.find((p) => p.symbol === underlying);
    const book = await this.computeOptionBookState(userId, environment, underlying, excludeActionId);
    // The underlying's own last print (H0) — so the OTM and cost-basis checks evaluate against the real
    // market on an underlying we don't hold, which is every cash-secured put on a fresh account. Falls
    // back to the held position's implied price if the feed has no print for it.
    const [quote, latestTrade] = await Promise.all([
      client.getOptionQuote(instrument.occSymbol),
      client.getLatestTrade(underlying),
    ]);
    const underlyingPrice = latestTrade?.price ?? (held && held.qty > 0 ? round2(held.marketValue / held.qty) : null);
    // Real delta: the feed's own greek when it supplied one, else solved from the contract's market mid
    // (Black–Scholes), else the labeled moneyness stub. The delta-ceiling safeguard (B47) runs on it.
    const deltaResult = computeOptionDelta({
      right: instrument.right,
      underlyingPrice,
      strike: instrument.strike,
      expiration: instrument.expiration,
      optionMidPrice: quote?.mid ?? null,
      feedGreeks: quote?.greeks ?? null,
      now: Date.now(),
    });
    const { delta } = deltaResult;
    return {
      underlyingSharesHeld: held?.qty ?? 0,
      underlyingCostBasis: held?.avgEntryPrice ?? null,
      underlyingPrice,
      sharesPledgedToOtherShortCalls: book.sharesPledgedToOtherShortCalls,
      cashPledgedToOtherCsps: book.cashPledgedToOtherCsps,
      existingContractsOnUnderlying: book.existingContractsOnUnderlying,
      cash: account.cash,
      optionsBuyingPower: account.optionsBuyingPower,
      daysToExpiry: daysUntilExpiration(instrument.expiration),
      delta,
      // Provenance for the owner-facing honest-estimates label (B52 slice 2c).
      deltaSource: deltaSourceOf(deltaResult),
      // No earnings calendar until Phase B (B52) — the safeguard treats an unknown date leniently.
      daysToEarnings: null,
    };
  }
}

// Statuses that still count as "open" collateral commitment for another proposal's book-state check —
// everything short of a terminal negative outcome (discarded/rejected/expired/canceled/failed).
const OPEN_OPTION_STATUSES = new Set(['proposed', 'approved', 'submitted', 'filled', 'reconciled']);

/**
 * Collateral every open short put in `actions` has reserved, summed **without regard to underlying** —
 * the broker's options buying power is one pool, so a $58k META put and a $21.7k NVDA put both draw on
 * the same cash an already-open QQQ put is holding. Summing this per-name is what let a $100k account
 * clear $180k of puts and get all of them refused (H16).
 */
function sumShortPutCollateral(actions: Array<$.AlpacaAction>): number {
  let cash = 0;
  for (const a of actions) {
    const instrument = a.body.instrument;
    if (instrument?.positionIntent === 'sell_to_open' && instrument.right === 'put') {
      cash += instrument.strike * (a.body.qty || 0) * instrument.multiplier;
    }
  }
  return round2(cash);
}

// Deterministic per-environment key for the cached account/positions mirror (design §9: "one per
// environment"). Keyed on external_id, not the generated entity id, so re-reconciling updates the same
// row instead of accumulating a duplicate every time (repo coding guide's upsert-by-external_id rule).
function accountSnapshotExternalId(environment: AlpacaEnvironment): string {
  return `alpaca-account-snapshot-${environment}`;
}

// Run the shared pre-broker validator and capture the outcome (the safeguards file stays non-throwing).
function checkOrderRequest(order: AlpacaOrderRequest): {
  orderRequestValid: boolean;
  orderRequestError: string | null;
} {
  try {
    validateOrderRequest(order);
    return { orderRequestValid: true, orderRequestError: null };
  } catch (error) {
    if (error instanceof AlpacaOrderValidationError) {
      return { orderRequestValid: false, orderRequestError: error.message };
    }
    throw error;
  }
}

// Best-effort dollar value of a stored action for the daily-notional running total (no quote lookup).
// Mirrors `estimateOrderNotional`: an option's premium is per share, so the traded dollars are
// premium × contracts × multiplier (H0).
function estimateStoredNotional(body: $.AlpacaAction['body']): number {
  if (body.notional && body.notional > 0) {
    return body.notional;
  }
  if (body.qty && body.qty > 0 && body.limitPrice && body.limitPrice > 0) {
    return body.qty * body.limitPrice * (body.instrument?.multiplier || 1);
  }
  return 0;
}

function validateOptionLeg(leg: ProposeOptionLegInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.expiration)) {
    throw new BadRequestException('optionLeg.expiration must be YYYY-MM-DD');
  }
  if (!Number.isFinite(leg.strike) || leg.strike <= 0) {
    throw new BadRequestException('optionLeg.strike must be a positive number');
  }
  if (leg.right !== 'call' && leg.right !== 'put') {
    throw new BadRequestException('optionLeg.right must be call or put');
  }
  const validIntents: AlpacaPositionIntent[] = ['buy_to_open', 'sell_to_open', 'buy_to_close', 'sell_to_close'];
  if (!validIntents.includes(leg.positionIntent)) {
    throw new BadRequestException('optionLeg.positionIntent is invalid');
  }
  if (leg.multiplier != null && (!Number.isFinite(leg.multiplier) || leg.multiplier <= 0)) {
    throw new BadRequestException('optionLeg.multiplier must be a positive number');
  }
}

// buy_to_open/buy_to_close route as a broker `buy`, sell_to_open/sell_to_close as a `sell` (design
// §13.1 Layer A) — `side` stays the routing axis every existing check already understands.
function deriveSideFromIntent(positionIntent: AlpacaPositionIntent): 'buy' | 'sell' {
  return positionIntent === 'buy_to_open' || positionIntent === 'buy_to_close' ? 'buy' : 'sell';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// CLI receipt → the shape the action schema persists. The two differ by one field name on purpose: a
// dry-run's payload is the request body the broker WOULD have received, while a submit's is the order the
// broker actually returned — calling both `payload` on the stored action would blur the one distinction
// that makes the pair worth keeping.
function toDryRunReceipt(receipt: AlpacaCliReceipt): NonNullable<ActionExecution['dryRun']> {
  return { at: receipt.at, command: receipt.command, requestBody: receipt.payload };
}

function toSubmitReceipt(receipt: AlpacaCliReceipt): NonNullable<ActionExecution['submit']> {
  return { at: receipt.at, command: receipt.command, response: receipt.payload };
}

// Sort key for the action timeline: most recent activity (heartbeat), falling back to creation time.
function activityTime(action: $.AlpacaAction): number {
  const stamp = action.header.last_activity_at || action.created_at;
  const ms = stamp ? Date.parse(stamp) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}
