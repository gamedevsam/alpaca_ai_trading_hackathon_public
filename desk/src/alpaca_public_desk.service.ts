/**
 * H7 — the judge's read of the desk: one clamped projection, assembled server-side.
 *
 * The hackathon reviewer arrives with no account and thirty seconds of patience, so `/desk` gets exactly
 * four blocks (mandate + gate + P&L · proposals · signals · scorecards) and this file decides what those
 * blocks are allowed to contain. It is the ONLY read on the whole Alpaca surface with no session behind
 * it, which is why the projection is built by hand instead of reusing `AlpacaController.overview`:
 *
 *   - **Nothing is echoed that a judge does not need.** No `clientOrderId` / `alpacaOrderId` (broker
 *     handles), no per-position rows, no credentials, no user id, no mandate ids beyond the one the page
 *     renders. Account figures are the paper account's headline four; the book itself stays private.
 *   - **Read-only in the strictest sense.** There is no write path here at all — approving, rejecting and
 *     the autonomy toggle stay on the session-auth'd controller, so a public URL can never move the desk.
 *   - **Paper only**, clamped in code exactly as every other Alpaca surface clamps it.
 *
 * It is also unauthenticated and reads the live broker, so the assembled payload is memoized for
 * {@link DESK_CACHE_MS}: a page that polls (and a reviewer who reloads) must not turn into an
 * amplifier against Alpaca, and a judge reading numbers fifteen seconds stale is not misled by them —
 * `generatedAt` says when they were taken.
 */

import { Injectable, Logger } from '@nestjs/common';
import { resolveOwnerUserId } from '~/api/auth/guards/owner.guard';
import { ClaimTypeScorecard, PredictionLedgerService } from '~/api/user/prediction_ledger/prediction_ledger.service';
import { SourcePortfolioService } from '~/api/user/target_engine/source_portfolio.service';
import { EntityService } from '~/entity/entity.service';
import { EntityVersionService } from '~/entity_version/entity_version.service';
import type { AlpacaEnvironment } from './alpaca.types';
import { AlpacaChannelService } from './alpaca_channel.service';
import { deskSourceName } from './alpaca_desk_ledger.service';
import { AlpacaLifecycleService } from './alpaca_lifecycle.service';
import { AlpacaMandateService } from './alpaca_mandate.service';
import { AlpacaSignalService, channelSourceName } from './alpaca_signal.service';

/** The only environment this surface can ever describe. */
const DESK_ENVIRONMENT: AlpacaEnvironment = 'paper';

/** How long an assembled projection is served before the broker is read again. */
export const DESK_CACHE_MS = 15_000;

/** Proposals shown. Enough to prove a pattern, short enough to read on a phone. */
const DESK_ACTION_LIMIT = 12;

/** Creator calls shown per channel, newest first. */
const DESK_SIGNALS_PER_CHANNEL = 4;

export interface PublicDeskAction {
  id: string;
  status: $.AlpacaAction['body']['status'];
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  qty: number | null;
  limitPrice: number | null;
  rationale: string;
  errorMessage: string | null;
  clearedLimits: $.AlpacaAction['body']['clearedLimits'];
  events: $.AlpacaAction['body']['events'];
  instrument: $.AlpacaAction['body']['instrument'];
  optionOutcome: $.AlpacaAction['body']['optionOutcome'];
  /**
   * How the order reached the broker — the Alpaca CLI, or our typed HTTP client. The two commands are kept
   * apart on purpose: a proposal whose submit was refused has only a dry-run receipt, and calling that
   * "sent" would overstate what happened.
   */
  execution: {
    via: 'http' | 'cli';
    cliVersion: string | null;
    submitCommand: string | null;
    dryRunCommand: string | null;
  } | null;
  predictionId: string | null;
  citedSignalCount: number;
  lastActivityAt: string;
}

export interface PublicDeskSignal {
  id: string;
  ticker: string;
  direction: $.AlpacaSignal['body']['direction'];
  quote: string;
  thesis: string;
  saidAt: string | null;
  sourceRef: string;
  videoTitle: string;
  falsifiableCondition: string;
  resolveBy: string;
  onLedger: boolean;
  verdict:
    { kind: 'acted'; actionId: string } | { kind: 'declined'; reason: string; at: string | null } | { kind: 'open' };
}

export interface PublicDeskChannel {
  creator: string;
  url: string;
  signals: PublicDeskSignal[];
}

export interface PublicDeskScorecardRow extends Pick<
  ClaimTypeScorecard,
  'claimType' | 'openCount' | 'resolvedCount' | 'hitRate'
> {
  /**
   * Claims the claimant withdrew rather than stood behind. For the desk this is the H16 retraction: a
   * proposal whose order never reached the market takes its claim back, so the record is not padded with
   * predictions about trades that never happened. Shown, not hidden — a withdrawn claim is a fact about
   * the claimant.
   */
  retractedCount: number;
}

export interface PublicDeskScorecard {
  kind: 'desk' | 'creator';
  label: string;
  claimTypes: PublicDeskScorecardRow[];
  dueCount: number;
  totalCount: number;
}

export interface PublicDeskView {
  generatedAt: string;
  environment: AlpacaEnvironment;
  brokerKind: 'simulated' | 'paper';
  mandate: {
    name: string;
    text: string;
    status: $.AlpacaMandate['body']['status'];
    provider: string;
    model: string | null;
    versionCount: number;
    bounds: $.AlpacaMandate['body']['optionStrategy'];
  } | null;
  control: {
    executionGate: 'per_action' | 'fully_autonomous';
    killState: 'armed' | 'disarmed' | 'killed';
    mode: 'dry_run' | 'paper' | 'live';
  };
  account: {
    equity: number;
    cash: number;
    portfolioValue: number;
    unrealizedPl: number;
    openPositions: number;
    currency: string;
  };
  clock: { isOpen: boolean; nextOpen: string | null; nextClose: string | null };
  actions: PublicDeskAction[];
  channels: PublicDeskChannel[];
  scorecards: PublicDeskScorecard[];
}

@Injectable()
export class AlpacaPublicDeskService {
  private readonly logger = new Logger(AlpacaPublicDeskService.name);
  private ownerUserId: string | null = null;
  private cached: { at: number; view: PublicDeskView } | null = null;
  private inFlight: Promise<PublicDeskView> | null = null;

  constructor(
    private readonly entityService: EntityService,
    private readonly entityVersions: EntityVersionService,
    private readonly lifecycle: AlpacaLifecycleService,
    private readonly mandates: AlpacaMandateService,
    private readonly signals: AlpacaSignalService,
    private readonly channels: AlpacaChannelService,
    private readonly sourcePortfolios: SourcePortfolioService,
    private readonly predictions: PredictionLedgerService,
  ) {}

  /**
   * The page's one call. Served from the memo while it is fresh; concurrent misses share a single build
   * (`inFlight`) so a burst of reviewers loading at once is still one broker read.
   */
  async getDesk(): Promise<PublicDeskView> {
    if (this.cached && Date.now() - this.cached.at < DESK_CACHE_MS) {
      return this.cached.view;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.buildDesk()
      .then((view) => {
        this.cached = { at: Date.now(), view };
        return view;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async buildDesk(): Promise<PublicDeskView> {
    const userId = await this.resolveOwner();
    const [view, control, actions, mandates, followed] = await Promise.all([
      this.lifecycle.readAccount(userId, DESK_ENVIRONMENT),
      this.lifecycle.getControl(userId, DESK_ENVIRONMENT),
      this.lifecycle.listActions(userId, DESK_ENVIRONMENT, DESK_ACTION_LIMIT),
      this.mandates.list(userId),
      this.channels.listChannels(userId, DESK_ENVIRONMENT),
    ]);

    const mandate = pickDeskMandate(mandates);
    const [mandateBlock, channels, scorecards] = await Promise.all([
      this.describeMandate(mandate),
      this.describeChannels(userId, followed),
      this.buildScorecards(userId, mandate?.body.name ?? null, followed),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      environment: DESK_ENVIRONMENT,
      brokerKind: view.kind,
      mandate: mandateBlock,
      control: {
        executionGate: control.executionGate,
        killState: control.killState,
        mode: control.mode,
      },
      account: {
        equity: view.account.equity,
        cash: view.account.cash,
        portfolioValue: view.account.portfolioValue,
        unrealizedPl: round2(view.positions.reduce((sum, position) => sum + position.unrealizedPl, 0)),
        openPositions: view.positions.length,
        currency: view.account.currency,
      },
      clock: view.clock,
      actions: actions.map(projectAction),
      channels,
      scorecards,
    };
  }

  private async describeMandate(mandate: Required<$.AlpacaMandate> | null): Promise<PublicDeskView['mandate']> {
    if (!mandate) return null;
    return {
      name: mandate.body.name,
      text: mandate.body.mandate,
      status: mandate.body.status,
      provider: mandate.body.provider,
      model: mandate.body.model,
      // Every edit the owner made to the strategy is a stored version — the count is the honest measure of
      // "a human wrote this and kept writing it", which is the claim block 1 makes.
      versionCount: await this.countMandateVersions(mandate.id),
      bounds: mandate.body.optionStrategy,
    };
  }

  private async countMandateVersions(mandateId: string): Promise<number> {
    try {
      const versions = await this.entityVersions.getVersions(mandateId);
      return versions.length;
    } catch (error) {
      // Version history is context, never the point — a read failure must not take the page down.
      this.logger.warn(`Could not read mandate version history for ${mandateId}: ${describeError(error)}`);
      return 0;
    }
  }

  /** Block 3 — the creators, their words, and what the desk did about them. */
  private async describeChannels(
    userId: string,
    followed: Array<Required<$.AlpacaChannel>>,
  ): Promise<PublicDeskChannel[]> {
    if (followed.length === 0) return [];
    const signals = await this.signals.listSignals(userId, { environment: DESK_ENVIRONMENT, limit: 200 });

    return followed.map((channel) => ({
      creator: channel.body.title,
      url: channel.body.url,
      signals: signals
        .filter((signal) => signal.body.channelId === channel.body.channelId)
        .slice(0, DESK_SIGNALS_PER_CHANNEL)
        .map(projectSignal),
    }));
  }

  /**
   * Block 4 — the desk and the creators it listens to, graded by the same instrument. The desk's own card
   * is first: a page that scores its sources but not itself is marketing, not evidence.
   */
  private async buildScorecards(
    userId: string,
    mandateName: string | null,
    followed: Array<Required<$.AlpacaChannel>>,
  ): Promise<PublicDeskScorecard[]> {
    const wanted: Array<{ kind: 'desk' | 'creator'; label: string; sourceName: string }> = [];
    if (mandateName) {
      wanted.push({ kind: 'desk', label: 'MANDATE desk', sourceName: deskSourceName(mandateName) });
    }
    for (const channel of followed) {
      wanted.push({ kind: 'creator', label: channel.body.title, sourceName: channelSourceName(channel.body.title) });
    }
    if (wanted.length === 0) return [];

    const sources = await this.sourcePortfolios.listSourcePortfolios(userId);
    const idByName = new Map(sources.map((source) => [source.body.name, source.id]));

    const cards: PublicDeskScorecard[] = [];
    for (const entry of wanted) {
      const sourceId = idByName.get(entry.sourceName);
      // No ledger source yet means nothing has been claimed in this name — reported as an empty card, never
      // as a zero score (the scorecard's own honesty rule).
      if (!sourceId) {
        cards.push({ kind: entry.kind, label: entry.label, claimTypes: [], dueCount: 0, totalCount: 0 });
        continue;
      }
      const [scorecard, all] = await Promise.all([
        this.predictions.getManagerScorecard(userId, sourceId),
        this.predictions.listPredictions(userId, { sourcePortfolioId: sourceId }),
      ]);
      cards.push({
        kind: entry.kind,
        label: entry.label,
        claimTypes: scorecard.claimTypes
          .map(({ claimType, openCount, resolvedCount, hitRate, outcomeCounts }) => ({
            claimType,
            openCount,
            resolvedCount,
            hitRate,
            retractedCount: outcomeCounts.superseded ?? 0,
          }))
          // Only claim types this claimant has actually touched. A row must survive on a retraction alone,
          // or a source whose every claim was withdrawn would render as "nothing here" while its own
          // total says otherwise.
          .filter((row) => row.openCount > 0 || row.resolvedCount > 0 || row.retractedCount > 0),
        dueCount: all.filter((prediction) => prediction.status === 'due').length,
        totalCount: all.length,
      });
    }
    return cards;
  }

  private async resolveOwner(): Promise<string> {
    if (this.ownerUserId) return this.ownerUserId;
    this.ownerUserId = await resolveOwnerUserId(this.entityService);
    return this.ownerUserId;
  }
}

/**
 * Which mandate the page is about: the active paper one, most recently touched. A desk with no active
 * mandate reports none rather than describing a draft as if it were governing anything.
 */
function pickDeskMandate(mandates: Array<Required<$.AlpacaMandate>>): Required<$.AlpacaMandate> | null {
  const active = mandates.filter(
    (mandate) => mandate.body.status === 'active' && mandate.body.environment === DESK_ENVIRONMENT,
  );
  if (active.length === 0) return null;
  return active.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
}

function projectAction(action: Required<$.AlpacaAction>): PublicDeskAction {
  const { body } = action;
  return {
    id: action.id,
    status: body.status,
    symbol: body.symbol,
    side: body.side,
    orderType: body.orderType,
    qty: body.qty,
    limitPrice: body.limitPrice,
    rationale: body.rationale,
    errorMessage: body.errorMessage,
    clearedLimits: body.clearedLimits,
    events: body.events,
    instrument: body.instrument,
    optionOutcome: body.optionOutcome,
    execution: body.execution
      ? {
          via: body.execution.via,
          cliVersion: body.execution.cliVersion ?? null,
          submitCommand: body.execution.submit?.command ?? null,
          dryRunCommand: body.execution.dryRun?.command ?? null,
        }
      : null,
    predictionId: body.predictionId ?? null,
    // The ids themselves are internal; that the proposal cited N creator calls is the part a judge reads.
    citedSignalCount: body.signalIds?.length ?? 0,
    lastActivityAt: action.header.last_activity_at,
  };
}

function projectSignal(signal: Required<$.AlpacaSignal>): PublicDeskSignal {
  const { body } = signal;
  return {
    id: signal.id,
    ticker: body.ticker,
    direction: body.direction,
    quote: body.quote,
    thesis: body.thesis,
    saidAt: body.publishedAt,
    sourceRef: body.sourceRef,
    videoTitle: body.videoTitle,
    falsifiableCondition: body.falsifiableCondition,
    resolveBy: body.resolveBy,
    onLedger: Boolean(body.predictionId),
    verdict: describeVerdict(signal),
  };
}

/**
 * The agent's verdict on one call. `acted` outranks a decline (a call the desk traded is settled), and a
 * decline outranks silence — a reason recorded by H15's agent is the whole point of showing this block.
 */
function describeVerdict(signal: Required<$.AlpacaSignal>): PublicDeskSignal['verdict'] {
  const { body } = signal;
  if (body.status === 'acted' && body.actedActionId) {
    return { kind: 'acted', actionId: body.actedActionId };
  }
  if (body.lastDeclineReason) {
    return { kind: 'declined', reason: body.lastDeclineReason, at: body.lastDeclinedAt ?? null };
  }
  return { kind: 'open' };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
