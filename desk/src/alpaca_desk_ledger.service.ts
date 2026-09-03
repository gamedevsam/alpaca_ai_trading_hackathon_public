/**
 * H8 — the desk on the prediction ledger.
 *
 * Every proposal the desk stands behind is a falsifiable claim about where an underlying settles, so it is
 * written into the same append-only ledger that grades the creators the owner follows (H14). That is the
 * whole point: the desk and the people it listens to are scored by one instrument, on one honesty standard,
 * and neither gets a private scoreboard. `get_manager_scorecard` on the desk's own source portfolio reads
 * exactly like it does on a creator's.
 *
 * Three moments, and nothing else touches the ledger:
 *   1. **Proposed** → {@link recordProposalClaim} logs the claim and stamps `predictionId` on the action.
 *      Only a `proposed` action gets one: a discarded proposal is a contract the ceilings refused, not a
 *      claim the desk made — the same line `markSignalsActed` already draws for creators' calls.
 *   2. **Settled** → {@link resolveExpiredClaim}. A short option that expires worthless means the market
 *      did what the desk said (`right`); assignment means it did not (`wrong`). Both are read off the
 *      broker's own settlement, never off our opinion of it.
 *   3. **Never expressed** → {@link retractUnexpressedClaims}. An order the market never saw put nothing at
 *      risk, so its claim is withdrawn as `superseded` — the ledger's one non-judgment outcome. Grading it
 *      `unfalsifiable` would be a lie (the condition was crisp) and grading it `wrong` would punish the desk
 *      for an order the broker refused; leaving it open would nag in the due queue forever.
 *
 * The edge to the ledger is one-way, as the experiment's boundary requires: this file depends on
 * `PredictionLedgerService`, nothing in the ledger knows the desk exists.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PredictionLedgerService } from '~/api/user/prediction_ledger/prediction_ledger.service';
import { SourcePortfolioService } from '~/api/user/target_engine/source_portfolio.service';
import { EntityService } from '~/entity/entity.service';
import { AlpacaEnvironment } from './alpaca.types';

/**
 * Action statuses that mean the order never reached the market, so the desk's claim is withdrawn. Wider
 * than H16's signal-release set on purpose: a creator's call is only given back when the *machine* failed
 * (re-proposing one the owner rejected would argue with him), but the desk's own claim is about a position
 * it never took — and it never took it whether the broker refused, the owner declined, or the TTL lapsed.
 */
const UNEXPRESSED_ACTION_STATUSES = new Set(['failed', 'discarded', 'canceled', 'rejected', 'expired']);

/** One claim withdrawn because the action carrying it never reached the market. */
export interface RetractedClaim {
  actionId: string;
  predictionId: string;
  symbol: string;
  actionStatus: string;
}

@Injectable()
export class AlpacaDeskLedgerService {
  private readonly logger = new Logger(AlpacaDeskLedgerService.name);

  constructor(
    private readonly entityService: EntityService,
    private readonly predictions: PredictionLedgerService,
    private readonly sourcePortfolios: SourcePortfolioService,
  ) {}

  /**
   * Log the claim a freshly proposed action stands on and stamp its id onto the action. Returns the action
   * — updated when a claim was logged, unchanged otherwise.
   *
   * Best-effort by design: the ledger is the desk's record of itself, not a gate on trading. A ledger write
   * that fails must never cost a proposal that already cleared all fourteen ceilings, so the failure is
   * logged and the action stands without a `predictionId`.
   */
  async recordProposalClaim(
    userId: string,
    mandateName: string,
    action: Required<$.AlpacaAction>,
  ): Promise<Required<$.AlpacaAction>> {
    const instrument = action.body.instrument;
    if (action.body.status !== 'proposed' || !instrument || action.body.predictionId) {
      return action;
    }

    try {
      const sourcePortfolioId = await this.ensureDeskSource(userId, mandateName, action.body.environment);
      const { prediction } = await this.predictions.logPrediction(
        userId,
        {
          sourcePortfolioId,
          claimType: 'market_timing',
          // The desk's own words for why it wants this contract — its claim, stored exactly as written.
          claimVerbatim: action.body.rationale,
          verbatim: true,
          falsifiableCondition: buildDeskCondition(instrument),
          // The condition is not drafted by the model: it follows mechanically from the contract the
          // human-approved mandate authorised, which is the operator's rule speaking, not the AI's reading.
          conditionAuthor: 'operator',
          // A short option at a named strike and date is as unhedged as a claim gets.
          hedgeLevel: 'low',
          claimSourceRef: `alpaca_action:${action.id}`,
          claimMadeAt: action.header.last_activity_at,
          statedHorizon: `to the ${instrument.expiration} expiration`,
          // The claim is settled by the contract's own expiration, so that is when it comes due.
          resolveBy: `${instrument.expiration}T21:00:00.000Z`,
          tickers: [instrument.underlying],
        },
        'mcp',
      );

      return await this.entityService.update<$.AlpacaAction>(action, (draft) => {
        draft.body.predictionId = prediction.id;
      });
    } catch (error) {
      this.logger.error(
        `Alpaca desk ledger: could not log a claim for action ${action.id} — ${(error as Error).message}`,
      );
      return action;
    }
  }

  /**
   * Grade the claim an expired option carried. `expired_worthless` means the underlying stayed on the side
   * of the strike the desk said it would (`right`); `assigned` means it did not (`wrong`).
   *
   * Idempotent through the ledger itself: the trade cycle only calls this for a settlement it has not
   * reconciled before, and a re-log of the identical resolution dedupes rather than appending a twin.
   */
  async resolveExpiredClaim(
    userId: string,
    action: Required<$.AlpacaAction>,
    outcome: 'assigned' | 'expired_worthless',
    resolvedAt: string,
    detail: string,
  ): Promise<void> {
    const predictionId = action.body.predictionId;
    if (!predictionId) return;

    try {
      await this.predictions.logResolution(
        userId,
        {
          predictionId,
          outcome: outcome === 'expired_worthless' ? 'right' : 'wrong',
          resolvedAt,
          narration: `${detail} Settled by the broker on the contract's expiration; graded off that settlement, not off a re-read of the market.`,
        },
        'mcp',
      );
    } catch (error) {
      this.logger.error(
        `Alpaca desk ledger: could not resolve prediction ${predictionId} for action ${action.id} — ${(error as Error).message}`,
      );
    }
  }

  /**
   * Withdraw every claim whose action never reached the market. Sweeps the whole book rather than only this
   * cycle's actions, so a claim stranded by an earlier cycle (or by a manual rejection outside one) is
   * closed too instead of nagging in the due queue until its expiration.
   */
  async retractUnexpressedClaims(userId: string, environment: AlpacaEnvironment): Promise<RetractedClaim[]> {
    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active' },
    });
    const stranded = actions.filter(
      (a) =>
        a.body.environment === environment &&
        Boolean(a.body.predictionId) &&
        UNEXPRESSED_ACTION_STATUSES.has(a.body.status),
    );
    if (stranded.length === 0) return [];

    // Which of those claims is still unresolved, read once. A stranded action stays stranded forever, so a
    // per-action lookup would re-ask the ledger about every claim it already closed, on every cycle.
    const unresolved = new Set(
      (await this.predictions.listPredictions(userId, {}))
        .filter((view) => view.liveResolution === null)
        .map((view) => view.id),
    );

    const retracted: RetractedClaim[] = [];
    for (const action of stranded) {
      const predictionId = action.body.predictionId as string;
      // Already closed on an earlier sweep — asking again would 409 on the live resolution, which is a
      // conflict about nothing.
      if (!unresolved.has(predictionId)) continue;

      try {
        await this.predictions.logResolution(
          userId,
          {
            predictionId,
            outcome: 'superseded',
            resolvedAt: new Date().toISOString(),
            narration:
              `Withdrawn: the order carrying this claim ended ${action.body.status}, so the desk never took the ` +
              `position and nothing was ever at risk. Neither right nor wrong — it was never tested.`,
          },
          'mcp',
        );
      } catch (error) {
        this.logger.error(
          `Alpaca desk ledger: could not withdraw prediction ${predictionId} for action ${action.id} — ${(error as Error).message}`,
        );
        continue;
      }
      retracted.push({
        actionId: action.id,
        predictionId,
        symbol: action.body.symbol,
        actionStatus: action.body.status,
      });
    }

    if (retracted.length) {
      this.logger.log(
        `Alpaca desk ledger (${environment}): withdrew ${retracted.length} claim(s) on orders the market never saw — ` +
          `${retracted.map((r) => `${r.symbol}/${r.actionStatus}`).join(', ')}.`,
      );
    }
    return retracted;
  }

  /**
   * The desk's ledger identity: one `ai_sleeve` source portfolio per mandate, found by name so a re-run
   * reuses it. The book stays empty — what is tracked here is what the desk *claims*, and its actual
   * positions live at the broker, which is the only place that can be trusted about them.
   */
  async ensureDeskSource(userId: string, mandateName: string, environment: AlpacaEnvironment): Promise<string> {
    const name = deskSourceName(mandateName);
    const existing = await this.sourcePortfolios.listSourcePortfolios(userId, 'ai_sleeve');
    const found = existing.find((source) => source.body.name === name);
    if (found) return found.id;

    const created = await this.sourcePortfolios.upsertSourcePortfolio(
      userId,
      {
        name,
        kind: 'ai_sleeve',
        holdings: [],
        asOf: new Date().toISOString(),
        source: 'MANDATE desk',
        metadata: { alpacaEnvironment: environment },
      },
      'mcp',
    );
    this.logger.log(`Created ledger source “${name}” (${created.id}) for the desk.`);
    return created.id;
  }
}

/** The desk's ledger name, one per mandate. Exported so a reader can find the source without guessing. */
export function deskSourceName(mandateName: string): string {
  return `MANDATE desk · ${mandateName.trim() || 'unnamed mandate'}`;
}

/**
 * What the desk is actually claiming when it sells a contract to open: that the underlying finishes on the
 * harmless side of the strike. A short call wants a close below it; a short put wants a close above it.
 * Stated as a settlement condition rather than a price target, because expiration — not our re-reading of
 * the tape — is what grades it.
 */
export function buildDeskCondition(instrument: NonNullable<$.AlpacaAction['body']['instrument']>): string {
  const side = instrument.right === 'call' ? 'below' : 'above';
  return `${instrument.underlying} settles ${side} $${instrument.strike} at the ${instrument.expiration} close, so the short ${instrument.right} (${instrument.occSymbol}) expires worthless.`;
}
