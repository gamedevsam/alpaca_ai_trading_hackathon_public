// Trade-cycle service (B50, Layer D) — the callable evaluate → propose → reconcile cycle.
//
// TRIGGER-AGNOSTIC BY DESIGN (owner directive 2026-07-05): this service is a plain callable method, not a
// timer. Nothing in this file schedules itself — B55 is what wires a manual in-app control and a secure
// external webhook onto `runCycle`, and either of those (never an in-app `@Cron`) is the only thing that
// may invoke it.
//
// A cycle does three things, all already-approved primitives composed together:
//   1. Evaluate → propose: run the B49 mandate dry-run for every active mandate in the environment. The
//      "analyze" step is inference (the mandate's persona), bounded by the B47 safeguards; it stops at
//      proposed/discarded.
//   1b. Apply the autonomy gate (H4): iff the owner set `alpaca_control.executionGate` to
//      `fully_autonomous`, the environment is paper AND the kill switch is armed, each fresh proposal is
//      approved on the owner's behalf through the SAME `decideAction('approved')` a click would call —
//      every safeguard is still re-run against fresh broker state. Default `per_action` → nothing moves.
//   2. Options-aware monitoring/reconciliation: settle any open option position whose contract has
//      reached expiration (the B50 addition) — derive assigned vs. expired-worthless per position via the
//      broker's `processExpirations()`, persist the resulting cash/share move as a fresh account snapshot,
//      and reflect the outcome onto the `alpaca_action` that opened it. The simulated broker settles its
//      own in-memory ledger; the real paper broker (B53) reports settlements it already booked, read back
//      from its account-activities feed. That feed is append-only, so we dedupe here (an action already
//      carrying an `optionOutcome` was reconciled on a prior cycle — skip it) to reconcile exactly once.

import { Injectable, Logger } from '@nestjs/common';
import { resolveOwnerUserId } from '~/api/auth/guards/owner.guard';
import { EntityService } from '~/entity/entity.service';
import { AlpacaEnvironment, AlpacaOptionExpirationOutcome } from './alpaca.types';
import { AlpacaDeskLedgerService, RetractedClaim } from './alpaca_desk_ledger.service';
import { AlpacaLifecycleService } from './alpaca_lifecycle.service';
import { AlpacaMandateService, MandateDryRunResult } from './alpaca_mandate.service';
import { AlpacaSignalService, ReleasedSignal } from './alpaca_signal.service';

export interface OptionExpirationCycleOutcome {
  occSymbol: string;
  underlying: string;
  // The `alpaca_action` this outcome was applied to, or null if none matched (still applied to the
  // broker ledger regardless — the position settles either way, only the audit trail is best-effort).
  actionId: string | null;
  outcome: 'assigned' | 'expired_worthless';
  contracts: number;
  detail: string;
}

/**
 * One proposal the cycle approved on the owner's behalf (H4). `status` is where the action actually
 * ENDED — approval hands off to the same guarded execute a human approval does, which re-checks every
 * safeguard against fresh broker state, so an auto-approved action can still come back `discarded`.
 */
export interface TradeCycleAutoApproval {
  actionId: string;
  symbol: string;
  status: string;
  detail: string;
}

export interface TradeCycleResult {
  environment: AlpacaEnvironment;
  mandateResults: MandateDryRunResult[];
  expirationOutcomes: OptionExpirationCycleOutcome[];
  // Empty whenever the gate is `per_action` (the default) — then every proposal waits for the owner.
  autoApprovals: TradeCycleAutoApproval[];
  // Creator calls handed back because the action that cited them never reached the market (H16).
  releasedSignals: ReleasedSignal[];
  // The desk's own claims withdrawn for the same reason — the position was never taken (H8).
  retractedClaims: RetractedClaim[];
  // Resting orders that reached a terminal state at the broker since the last cycle saw them. Reported
  // because a silently-released collateral pledge is exactly the kind of change a reader should see.
  reconciledRestingOrders: Array<{ actionId: string; status: string; occSymbol: string | null }>;
}

// Statuses an option action can be in while its position is still open at the broker (mirrors
// `alpaca_lifecycle.service.ts`'s OPEN_OPTION_STATUSES, narrowed to "actually filled" — a merely
// proposed/approved action never reached the broker ledger, so it can't be the one that expired).
const FILLED_OPTION_STATUSES = new Set(['filled', 'reconciled']);

@Injectable()
export class AlpacaTradeCycleService {
  private readonly logger = new Logger(AlpacaTradeCycleService.name);
  // Single-user app (see AGENTS.md Charter) — the owner's user id never changes at runtime, so caching
  // it for the process lifetime avoids a lookup on every webhook-triggered cycle. Other long-lived
  // services in this codebase cache it the same way.
  private ownerUserId: string | null = null;

  constructor(
    private readonly entityService: EntityService,
    private readonly lifecycle: AlpacaLifecycleService,
    private readonly mandateService: AlpacaMandateService,
    private readonly signals: AlpacaSignalService,
    private readonly deskLedger: AlpacaDeskLedgerService,
  ) {}

  /**
   * B55's trigger entrypoint: the webhook (and, in principle, any caller without a session) has no
   * `userId` to hand in, so resolve the single owner user before running the cycle. Throws if ownership
   * is ambiguous (see `resolveOwnerUserId`) — no cycle at all beats a cycle run against a guessed user.
   */
  async runCycleForOwner(environment: AlpacaEnvironment): Promise<TradeCycleResult> {
    return this.runCycle(await this.resolveOwnerUserId(), environment);
  }

  private async resolveOwnerUserId(): Promise<string> {
    if (this.ownerUserId) {
      return this.ownerUserId;
    }
    this.ownerUserId = await resolveOwnerUserId(this.entityService);
    return this.ownerUserId;
  }

  /**
   * Run one trade cycle for the owner's environment: evaluate every active mandate (dry-run → propose),
   * then settle any option position whose contract has reached expiration. Callable directly (as this
   * slice's tests do) or from B55's manual/webhook trigger surface — never from an in-app timer.
   */
  async runCycle(userId: string, environment: AlpacaEnvironment = 'paper'): Promise<TradeCycleResult> {
    // FIRST, before anything reads the book: catch up any order that reached a terminal state at the
    // broker since our last cycle. A `submitted` action counts as an open collateral commitment, so a
    // stale one silently shrinks what every proposal below believes it can pledge — and nothing else in
    // the system ever re-checks a resting order (see reconcileRestingOrders for the prod evidence).
    const restingReconciled = await this.lifecycle.reconcileRestingOrders(userId, environment);
    const reconciledRestingOrders = restingReconciled.map((a) => ({
      actionId: a.id,
      status: a.body.status,
      occSymbol: a.body.instrument?.occSymbol ?? null,
    }));

    const mandates = await this.mandateService.list(userId);
    const activeMandates = mandates.filter((m) => m.body.status === 'active' && m.body.environment === environment);

    const mandateResults: MandateDryRunResult[] = [];
    const autoApprovals: TradeCycleAutoApproval[] = [];
    for (const mandate of activeMandates) {
      const result = await this.mandateService.dryRun(userId, mandate.id);
      mandateResults.push(result);
      autoApprovals.push(...(await this.autoApprove(userId, environment, result)));
    }

    const expirationOutcomes = await this.processExpirations(userId, environment);

    // H16 — the last thing a cycle does is give back the creators' calls that were spent on nothing. It
    // runs AFTER the approvals above, so an order the broker refused this very cycle is already `failed`
    // by the time we look; and it sweeps the whole book, so a call stranded by an earlier cycle (or by a
    // manual approval that failed outside one) is recovered too rather than staying lost.
    const releasedSignals = await this.signals.releaseSignalsForUnexpressedActions(userId, environment);

    // H8 — and the desk's own claims on those same orders are withdrawn, for the same reason: a position it
    // never took was never tested. Runs last, beside the signal release, so the whole book is settled by the
    // time anything reads the scorecard.
    const retractedClaims = await this.deskLedger.retractUnexpressedClaims(userId, environment);

    this.logger.log(
      `Alpaca trade cycle (${environment}) for ${userId}: ${activeMandates.length} mandate(s) evaluated, ` +
        `${autoApprovals.length} proposal(s) auto-approved, ${expirationOutcomes.length} option expiration(s) settled, ` +
        `${releasedSignals.length} creator call(s) released, ${retractedClaims.length} desk claim(s) withdrawn, ` +
        `${reconciledRestingOrders.length} resting order(s) caught up.`,
    );
    return {
      environment,
      mandateResults,
      expirationOutcomes,
      autoApprovals,
      releasedSignals,
      retractedClaims,
      reconciledRestingOrders,
    };
  }

  /**
   * H4 — the autonomy gate. Every proposal a dry-run just staged is approved on the owner's behalf, but
   * ONLY when all three of the following hold, re-read from the control on every cycle:
   *
   *   1. `control.executionGate === 'fully_autonomous'` — the owner explicitly turned autonomy on;
   *   2. `environment === 'paper'` — autonomy is a paper-only capability, never live (a live desk needs
   *      the owner's own hand on every order, and `liveArmed` is a separate gate besides);
   *   3. `control.killState === 'armed'` — a disarmed or killed desk moves nothing, gate or no gate.
   *
   * This is not a bypass: an auto-approval calls the identical `decideAction('approved')`, so every
   * safeguard is re-run against fresh broker state and the action can still end `discarded`. The gate
   * decides WHO grants permission to execute, not WHETHER the checks run.
   *
   * Failure of one approval never aborts the cycle — the rest of the proposals (and the expiration pass)
   * still run, and the failure is logged against the action it belongs to.
   */
  private async autoApprove(
    userId: string,
    environment: AlpacaEnvironment,
    result: MandateDryRunResult,
  ): Promise<TradeCycleAutoApproval[]> {
    const proposed = result.actions.filter((a) => a.body.status === 'proposed');
    if (proposed.length === 0) {
      return [];
    }

    const control = await this.lifecycle.getControl(userId, environment);
    if (control.executionGate !== 'fully_autonomous' || environment !== 'paper' || control.killState !== 'armed') {
      return [];
    }

    const message = `Auto-approved: control.executionGate=fully_autonomous (paper, kill switch armed) — no human click.`;
    const approvals: TradeCycleAutoApproval[] = [];
    for (const action of proposed) {
      try {
        const decided = await this.lifecycle.decideAction(userId, action.id, 'approved', { message });
        approvals.push({
          actionId: decided.id,
          symbol: decided.body.symbol,
          status: decided.body.status,
          detail: decided.body.errorMessage || message,
        });
      } catch (error) {
        this.logger.error(
          `Alpaca trade cycle: auto-approval of action ${action.id} failed — ${(error as Error).message}`,
        );
      }
    }
    return approvals;
  }

  /**
   * Settle expired option positions against the broker and reflect each outcome onto the `alpaca_action`
   * that opened it (best-effort match by OCC symbol among this environment's filled option actions — the
   * position settles at the broker regardless of whether a match is found).
   *
   * Idempotent across cycles: the real broker's account-activities feed re-reports every historical
   * settlement, so an outcome whose matched action already carries an `optionOutcome` was reconciled on a
   * prior cycle and is skipped. (The simulated broker settles-and-forgets, so it never re-reports and this
   * guard is a no-op there.) If nothing is newly reconcilable we take no snapshot and return [].
   */
  private async processExpirations(
    userId: string,
    environment: AlpacaEnvironment,
  ): Promise<OptionExpirationCycleOutcome[]> {
    const client = await this.lifecycle.createEnvironmentClient(userId, environment);
    const brokerOutcomes = await client.processExpirations();
    if (brokerOutcomes.length === 0) {
      return [];
    }

    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active' },
    });
    const openOptionActions = actions.filter(
      (a) =>
        a.body.environment === environment && a.body.instrument != null && FILLED_OPTION_STATUSES.has(a.body.status),
    );

    // Match each settlement to an open filled option action, then drop those already reconciled (their
    // matched action carries an `optionOutcome`) — that's the dedupe against the append-only feed.
    const pending = brokerOutcomes
      .map((outcome) => ({
        outcome,
        match: openOptionActions.find((a) => a.body.instrument?.occSymbol === outcome.instrument.occSymbol) ?? null,
      }))
      .filter(({ match }) => !(match && match.body.optionOutcome));

    if (pending.length === 0) {
      return [];
    }

    // Persist the ledger mutation (shares called away/bought, cash moved at the strike) the same way a
    // fill is reconciled — otherwise the next fresh client resumes from a stale, pre-settlement snapshot.
    await this.lifecycle.captureAccountSnapshot(userId, environment, client);

    const results: OptionExpirationCycleOutcome[] = [];
    for (const { outcome, match } of pending) {
      const detail = describeExpirationOutcome(outcome);

      if (match) {
        const now = new Date().toISOString();
        await this.entityService.update<$.AlpacaAction>(match, (draft) => {
          draft.body.optionOutcome = { kind: outcome.outcome, occurredAt: now, detail };
          draft.header.last_activity_at = now;
          draft.body.events.push({ at: now, status: draft.body.status, message: detail });
        });
        // H8 — expiration is what grades the claim this contract carried: worthless means the underlying
        // finished where the desk said it would, assignment means it did not. Guarded by the same
        // already-reconciled filter above, so a re-reported settlement never re-grades anything.
        await this.deskLedger.resolveExpiredClaim(userId, match, outcome.outcome, now, detail);
      } else {
        this.logger.warn(
          `Alpaca trade cycle: no open action matched expiring option ${outcome.instrument.occSymbol} — settled at the broker only.`,
        );
      }

      results.push({
        occSymbol: outcome.instrument.occSymbol,
        underlying: outcome.instrument.underlying,
        actionId: match?.id ?? null,
        outcome: outcome.outcome,
        contracts: outcome.contracts,
        detail,
      });
    }
    return results;
  }
}

function describeExpirationOutcome(outcome: AlpacaOptionExpirationOutcome): string {
  const { instrument, contracts } = outcome;
  if (outcome.outcome === 'expired_worthless') {
    return `Expired worthless at expiration (${contracts} ct, strike ${instrument.strike}) — no shares/cash movement.`;
  }
  const action = instrument.right === 'call' ? 'shares called away' : 'shares purchased';
  return `Assigned at expiration: ${action} at strike ${instrument.strike} (${contracts} ct).`;
}
