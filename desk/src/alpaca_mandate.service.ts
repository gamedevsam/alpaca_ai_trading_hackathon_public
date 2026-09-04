// Options mandate model + simulated dry-run (B49).
//
// The STRATEGY lives in the mandate (free-text `soul` + numeric bounds), never in code (design §13.3,
// "preserve optionality"). This service owns mandate CRUD (versioned for free — every `EntityService`
// update already snapshots/diffs via `EntityVersionService`, see `entity_version.service.ts`) and the
// "dry-run on paper" that turns a mandate into today's covered-call/CSP candidates:
//
//   1. Code generates a small, bounds-eligible candidate grid from the REAL listed chain — the underlying's
//      last print, the contracts Alpaca actually lists at an expiry inside the bounds, their live bid/ask,
//      and their delta (feed-supplied where available). DTE/delta/OTM are already intersected against both
//      the mandate's own preferences AND the account-wide `alpaca_control` ceilings — the mandate can only
//      narrow, never loosen, the owner's ceilings. Nothing here is constructed arithmetically: a candidate
//      that isn't a real, quoted, sufficiently-liquid contract never reaches the persona (H0).
//   2. The persona (the mandate's provider/model, reusing the Forum's one real LLM call site) picks which
//      candidates to act on today and why. No live provider configured => a deterministic fallback (every
//      eligible candidate), so this is self-verifiable in Phase A with no keys.
//   3. Every selection is submitted through the EXISTING `proposeAction` (B47/B48) — the same deterministic
//      safeguards (defined-risk floor, contract caps, DTE/delta/OTM, book-state pledging) re-verify from
//      scratch, so a persona pick that doesn't actually hold up comes back `discarded`, never `proposed`.
//
// "The LLM proposes; deterministic code disposes" (alpaca_safeguards.ts) applies here unchanged — this
// service only ever produces `proposed`/`discarded` actions, exactly like a manual propose. Nothing here
// approves, submits, or executes.

import { entity_alpaca_mandate } from '#schema_registry';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityService } from '~/entity/entity.service';
import { ForumAgentSnapshot } from '~/api/forum/forum.types';
import { ForumInferenceService } from '~/api/forum/forum_inference.service';
import { AlpacaClient, AlpacaOptionQuote, AlpacaOptionRight } from './alpaca.types';
import { AlpacaDeskLedgerService } from './alpaca_desk_ledger.service';
import { AlpacaLifecycleService } from './alpaca_lifecycle.service';
import { AlpacaSignalService, OpenSignalBrief } from './alpaca_signal.service';
import { truncateOnWordBoundary } from './alpaca_text';
import {
  AlpacaControlLimits,
  OptionDeltaSource,
  computeOptionDelta,
  daysUntilExpiration,
  deltaSourceOf,
} from './alpaca_safeguards';

// Mandates are Phase A / dry-run only — every mandate lives in paper until B54's owner-armed promotion.
const MANDATE_ENVIRONMENT = 'paper' as const;
// Bound the underlyings a single dry-run evaluates so one mandate can't fan out into an unbounded scan.
const MAX_TARGET_UNDERLYINGS = 10;
// ---- Candidate selection constants (H0) -------------------------------------------------------------
// Selection is by DELTA BAND + PREMIUM FLOOR, not by a fixed OTM offset. Measured 2026-09-03 on the real
// chain: at 1 DTE a 5%-OTM SPY put bids $0.01 while a δ −0.09 put bids $0.34 — a fixed offset picks
// contracts nobody will pay for, and the further out it reaches the more worthless it gets.
//
// The floor a contract's BID must clear to be worth the collateral and the assignment risk.
const MIN_PREMIUM_PER_SHARE = 0.25;
// Deltas outside this band are excluded: below the floor is a lottery ticket paying nothing, above the
// ceiling is too likely to be assigned. The ceiling is the tightest of mandate/control, or this default.
const MIN_ABS_DELTA = 0.05;
const DEFAULT_MAX_ABS_DELTA = 0.35;
// How many contracts per underlying/strategy the persona gets to choose between. Small on purpose — the
// agent picks among real alternatives, it doesn't wade through a chain.
const MAX_CANDIDATES_PER_LEG = 3;
// Strike band pulled from the chain around the last print, as a fraction of it. Wide enough to contain
// the whole delta band at these DTEs, and — because it is read for ONE expiry at a time — narrow enough
// to stay inside one snapshot page.
const STRIKE_BAND_PCT = 0.1;
// The band used only to discover WHICH expiries are listed: a handful of near-the-money strikes across
// the whole window. Measured 2026-09-03: SPY lists ~74 strikes per expiry inside the selection band, so
// scanning a two-week window at full width overruns the snapshot pagination budget and can silently hide
// an expiry. A dollar floor keeps the band from collapsing to nothing on a cheap underlying.
const EXPIRY_SCAN_BAND_PCT = 0.005;
const EXPIRY_SCAN_BAND_MIN = 2.5;
// Expirations are discovered from the listed chain, but scanning the mandate's whole DTE window can span
// a dozen expiries; we look this many days past `minDte` first and only widen if nothing is listed.
const EXPIRY_SCAN_DAYS = 14;
const CHAIN_PAGE_LIMIT = 100;
const SHARES_PER_CONTRACT = 100;

// H15 — how the desk agent is told to read the creators' open calls. Two lines carry the whole discipline:
// a call is an INPUT to its judgment (never an instruction), and an unproven creator is unproven, not
// average — `percentage: null` means the ledger has too few graded claims to score him, and a model left
// to guess at that reads a null as a zero and quietly discounts a creator it has no evidence against.
const SIGNAL_TASK_SECTION = [
  '`openSignals` are calls made by the creators the owner follows, extracted verbatim from their videos and',
  'already logged on his prediction ledger as falsifiable claims. Some candidates below exist only because',
  'a creator named that underlying. A call is an input to your judgment, never an instruction:',
  '',
  '  · `creatorHitRate` is that creator’s OWN graded record for this kind of claim on this ledger.',
  '    `percentage: null` means too few of his claims have resolved to score him — read that as UNPROVEN,',
  '    not as bad, and weigh the call on its argument instead.',
  '  · `quote` is what he actually said, word for word. `thesis` is his reason, not ours.',
  '  · A `bearish` call is never traded here — the desk only sells cash-secured puts. Treat it as a reason',
  '    to be MORE reluctant to sell a put on that underlying, and decline it explicitly.',
  '',
  'For every candidate you select that answers a call, list that call’s `signalId` under `signals` and say in',
  'its `rationale` why the creator’s call survives your own judgment. For every call you pass on, give the',
  'reason under `declined`. Passing on a call is a correct answer; passing on it silently is not.',
  '',
  'Keep each `rationale` and each `declined` reason under 60 words — they are shown verbatim and are',
  'shortened if they run long.',
].join('\n');

// Free text the persona writes is shown to a reader as the desk's stated reasoning, so it is capped and
// cut on a word boundary (alpaca_text.ts) rather than sliced mid-word.
const RATIONALE_MAX_CHARS = 500;
const DECLINE_REASON_MAX_CHARS = 500;
const NARRATIVE_MAX_CHARS = 2000;

// One REAL listed contract the desk could sell today, priced and sized. `id` is the OCC symbol, so a
// persona selection names an actual contract and a hallucinated id can't resolve to anything.
export interface OptionMandateCandidate {
  id: string;
  underlying: string;
  strategy: 'covered_call' | 'cash_secured_put';
  right: AlpacaOptionRight;
  occSymbol: string;
  strike: number;
  expiration: string;
  contracts: number;
  underlyingPrice: number;
  daysToExpiry: number;
  delta: number | null;
  // How `delta` was obtained — the feed's own greek, our Black–Scholes solve, or the labelled stub.
  deltaSource: OptionDeltaSource | null;
  impliedVol: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  // What we would actually send: a limit sell at the bid, good for the day. Never a market order — an
  // option market order on a wide indicative spread is how a $1.85 credit becomes $0.40.
  limitPrice: number;
  // Credit received if filled at `limitPrice`, and the cash/shares it ties up until expiry.
  premium: number;
  collateral: number;
  // Premium as a percentage of the collateral it pledges — the comparable number across contracts.
  yieldPct: number;
  note: string;
}

export interface MandateDryRunResult {
  mandateId: string;
  candidates: OptionMandateCandidate[];
  selected: string[];
  usedAi: boolean;
  provider: string;
  narrative: string | null;
  actions: Array<Required<$.AlpacaAction>>;
  /** The creator calls the agent was shown this cycle (H15) — what it decided is on each action. */
  openSignals: OpenSignalBrief[];
  /** Calls the agent looked at and passed on, in its own words. A decline is a verdict, not a silence. */
  declinedSignals: Array<{ signalId: string; ticker: string; creator: string; reason: string }>;
  /**
   * Candidates the agent selected that produced NO action, and why. A selection that yields neither a
   * proposed nor a discarded action is the silent drop the ledger exists to prevent, so the gap between
   * `selected` and `actions` is always accounted for here rather than left for a reader to notice.
   */
  skipped: Array<{ candidateId: string; reason: string }>;
}

export interface MandateOptionStrategyInput {
  targetUnderlyings?: string[];
  minDaysToExpiry?: number | null;
  maxDaysToExpiry?: number | null;
  requireOtm?: boolean;
  maxAbsDelta?: number | null;
}

export interface CreateMandateInput {
  name: string;
  mandate: string;
  provider?: $.AlpacaMandate['body']['provider'];
  model?: string | null;
  notes?: string | null;
  optionStrategy?: MandateOptionStrategyInput;
}

export type UpdateMandateInput = Partial<CreateMandateInput> & {
  status?: $.AlpacaMandate['body']['status'];
};

@Injectable()
export class AlpacaMandateService {
  private readonly logger = new Logger(AlpacaMandateService.name);

  constructor(
    private readonly entityService: EntityService,
    private readonly lifecycle: AlpacaLifecycleService,
    private readonly forumInference: ForumInferenceService,
    private readonly signals: AlpacaSignalService,
    private readonly deskLedger: AlpacaDeskLedgerService,
  ) {}

  async list(userId: string): Promise<Array<Required<$.AlpacaMandate>>> {
    const mandates = await this.entityService.findMany<$.AlpacaMandate>({
      where: { type: 'alpaca_mandate', owner_id: userId, status: 'active' },
    });
    return (mandates as Array<Required<$.AlpacaMandate>>).sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  }

  async create(userId: string, input: CreateMandateInput): Promise<Required<$.AlpacaMandate>> {
    const name = input.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const mandateText = input.mandate?.trim();
    if (!mandateText) {
      throw new BadRequestException('mandate is required');
    }
    const now = new Date().toISOString();
    const entity = entity_alpaca_mandate.new({
      owner_id: userId,
      header: {
        owner_user_id: userId,
        environment: MANDATE_ENVIRONMENT,
        status: 'draft',
        promotion_state: 'sandbox',
      },
      body: {
        environment: MANDATE_ENVIRONMENT,
        name,
        mandate: mandateText,
        provider: input.provider ?? 'local',
        model: input.model?.trim() || null,
        status: 'draft',
        promotionState: 'sandbox',
        promotedFromMandateId: null,
        notes: input.notes?.trim() || null,
        optionStrategy: normalizeOptionStrategy(input.optionStrategy),
      },
    });
    const saved = await this.entityService.upsert<$.AlpacaMandate>(entity);
    this.logger.log(`Alpaca mandate ${saved.id} '${name}' created for ${userId}.`);
    return saved;
  }

  async update(userId: string, id: string, input: UpdateMandateInput): Promise<Required<$.AlpacaMandate>> {
    const mandate = await this.loadOwnedMandate(userId, id);
    return this.entityService.update<$.AlpacaMandate>(mandate, (draft) => {
      if (typeof input.name === 'string' && input.name.trim()) {
        draft.body.name = input.name.trim();
      }
      if (typeof input.mandate === 'string' && input.mandate.trim()) {
        draft.body.mandate = input.mandate.trim();
      }
      if (typeof input.provider === 'string') {
        draft.body.provider = input.provider;
      }
      if (input.model !== undefined) {
        draft.body.model = input.model?.trim() || null;
      }
      if (input.notes !== undefined) {
        draft.body.notes = input.notes?.trim() || null;
      }
      if (input.status === 'draft' || input.status === 'active' || input.status === 'archived') {
        draft.body.status = input.status;
        draft.header.status = input.status;
      }
      if (input.optionStrategy) {
        draft.body.optionStrategy = normalizeOptionStrategy(input.optionStrategy, draft.body.optionStrategy);
      }
    });
  }

  /**
   * The dry-run: given the mandate + today's simulated positions/quotes, generate the eligible
   * covered-call/CSP candidate grid, let the persona pick, and propose its picks through the unchanged
   * `proposeAction` pipeline. Always paper, always stops at `proposed`/`discarded` — never executes.
   */
  async dryRun(userId: string, mandateId: string): Promise<MandateDryRunResult> {
    const mandate = await this.loadOwnedMandate(userId, mandateId);
    if (mandate.body.status === 'archived') {
      throw new BadRequestException('Cannot dry-run an archived mandate.');
    }

    const [account, control] = await Promise.all([
      this.lifecycle.readAccount(userId, MANDATE_ENVIRONMENT),
      this.lifecycle.getControl(userId, MANDATE_ENVIRONMENT),
    ]);

    if (!control.limits.optionsEnabled) {
      return {
        mandateId: mandate.id,
        candidates: [],
        selected: [],
        usedAi: false,
        provider: 'local',
        narrative: 'Options trading is disabled in the Alpaca control limits — enable it before running a dry-run.',
        actions: [],
        skipped: [],
        openSignals: [],
        declinedSignals: [],
      };
    }

    const bounds = intersectBounds(mandate.body.optionStrategy, control.limits);
    const client = await this.lifecycle.createEnvironmentClient(userId, MANDATE_ENVIRONMENT);

    // H15 — the creators the owner follows get a say in what the desk even looks at today. Their open
    // calls are read here, clamped to the owner's allow/deny list first: the control list is a ceiling on
    // attention as well as on trading, so a call on a ticker the owner excluded is never shown at all.
    const briefs = await this.signals.openSignalBriefs(userId, MANDATE_ENVIRONMENT);
    const allowedSignalTickers = new Set(
      allowedUnderlyings(
        briefs.map((brief) => brief.ticker),
        control.limits,
      ),
    );
    const openSignals = briefs.filter((brief) => allowedSignalTickers.has(brief.ticker));

    // The owner's allow/deny lists are a ceiling on the universe, never widened by a mandate or by a
    // signal: a target the control forbids is dropped before any market data is fetched. The mandate's own
    // targets come first, so a burst of creator calls can never crowd them out of the per-run cap.
    // Only a bullish or neutral call widens the universe — the desk sells cash-secured puts, so a bearish
    // call is logged and graded but never traded (plan H0); it stays in `openSignals` as the reason to
    // NOT sell a put on that underlying.
    const underlyings = allowedUnderlyings(
      dedupeUnderlyings([
        ...mandate.body.optionStrategy.targetUnderlyings,
        ...openSignals.filter((brief) => brief.direction !== 'bearish').map((brief) => brief.ticker),
      ]),
      control.limits,
    ).slice(0, MAX_TARGET_UNDERLYINGS);

    // H16 — what is actually free to pledge today. The account's `cash` still shows collateral that open
    // short puts have already reserved (the broker holds it as options buying power, not as a cash debit),
    // so sizing candidates off `cash` alone builds contracts the broker refuses outright. Account-wide by
    // design: every CSP draws on the same pool, whatever the underlying.
    const cashPledgedToOpenCsps = await this.lifecycle.cashPledgedToOpenCsps(userId, MANDATE_ENVIRONMENT);
    const uncommittedCash = round2(Math.max(0, account.account.cash - cashPledgedToOpenCsps));

    const candidates: OptionMandateCandidate[] = [];
    for (const underlying of underlyings) {
      const asset = await client.getAsset(underlying);
      if (!asset?.tradable) {
        continue;
      }
      const held = account.positions.find((p) => p.symbol === underlying);
      // The underlying's real last print. No print, no candidates — we never price a contract off a
      // guessed underlying (H0: this used to fall back to a hash of the ticker).
      const trade = await client.getLatestTrade(underlying);
      const price = trade?.price ?? (held && held.qty > 0 ? round2(held.marketValue / held.qty) : null);
      if (price == null || price <= 0) {
        this.logger.warn(`Alpaca mandate ${mandate.id} dry-run: no price for ${underlying} — skipped.`);
        continue;
      }

      // Covered calls only against shares actually held; cash-secured puts against cash on hand.
      const heldShares = held?.qty ?? 0;
      if (heldShares >= SHARES_PER_CONTRACT) {
        candidates.push(
          ...(await buildLegCandidates(client, {
            underlying,
            right: 'call',
            strategy: 'covered_call',
            price,
            bounds,
            maxContractsPerOrder: control.limits.maxContractsPerOrder,
            capacityContracts: Math.floor(heldShares / SHARES_PER_CONTRACT),
          })),
        );
      }
      candidates.push(
        ...(await buildLegCandidates(client, {
          underlying,
          right: 'put',
          strategy: 'cash_secured_put',
          price,
          bounds,
          maxContractsPerOrder: control.limits.maxContractsPerOrder,
          cash: uncommittedCash,
        })),
      );
    }

    if (candidates.length === 0) {
      return {
        mandateId: mandate.id,
        candidates: [],
        selected: [],
        usedAi: false,
        provider: 'local',
        narrative:
          'No eligible covered-call/CSP candidates on the listed chain today — no contract inside the DTE ' +
          'and delta bounds bid at least $' +
          MIN_PREMIUM_PER_SHARE.toFixed(2) +
          ' with the cash/shares on hand. Check the target underlyings, the bounds, and whether the market is open.',
        actions: [],
        skipped: [],
        openSignals,
        declinedSignals: [],
      };
    }

    const {
      selected,
      unknownSelections,
      usedAi,
      provider,
      narrative,
      rationaleById,
      signalIdsByCandidate,
      declinedSignals,
    } = await this.choosePersonaCandidates(
      userId,
      mandate,
      candidates,
      openSignals,
      uncommittedCash,
      account.account.equity,
    );

    // Collateral is committed as we go: two selected CSPs can't both pledge the same cash, and two covered
    // calls can't both pledge the same shares. Starting from `uncommittedCash` extends that across cycles
    // too — yesterday's still-open put holds its collateral just as firmly as this cycle's first pick.
    // `proposeAction`'s deterministic defined-risk floor is still the authority (it re-reads the whole open
    // book) — sizing down here just means the proposal arrives at a size that can actually clear it.
    let cashRemaining = uncommittedCash;
    const sharesRemaining = new Map<string, number>();
    for (const position of account.positions) {
      sharesRemaining.set(position.symbol, position.qty);
    }

    const actions: Array<Required<$.AlpacaAction>> = [];
    const skipped: MandateDryRunResult['skipped'] = unknownSelections.map((candidateId) => ({
      candidateId,
      reason: 'Not a contract the agent was shown — the id matched no candidate on today\u2019s chain.',
    }));
    for (const candidateId of selected) {
      const candidate = candidates.find((c) => c.id === candidateId);
      if (!candidate) {
        // Unreachable: `selected` is already filtered to real candidate ids, and an invented id is
        // recorded in `skipped` above. Kept so a future change to that filter cannot start proposing
        // against a contract that does not exist.
        skipped.push({ candidateId, reason: 'No candidate on today\u2019s chain matched this id.' });
        continue;
      }
      const contracts = affordableContracts(candidate, cashRemaining, sharesRemaining);
      if (contracts < 1) {
        const reason = 'Collateral was already committed to an earlier proposal in this cycle.';
        this.logger.log(`Alpaca mandate ${mandate.id} dry-run: ${candidate.occSymbol} skipped \u2014 ${reason}`);
        skipped.push({ candidateId, reason });
        continue;
      }
      if (candidate.strategy === 'cash_secured_put') {
        cashRemaining = round2(cashRemaining - candidate.strike * contracts * SHARES_PER_CONTRACT);
      } else {
        sharesRemaining.set(
          candidate.underlying,
          (sharesRemaining.get(candidate.underlying) ?? 0) - contracts * SHARES_PER_CONTRACT,
        );
      }

      // Which creator calls the agent said this contract answers — validated against the calls it was
      // actually shown, so a cited id is always a real open signal on this very underlying.
      const signalIds = signalIdsByCandidate.get(candidateId) ?? [];
      const action = await this.lifecycle.proposeAction(userId, {
        environment: MANDATE_ENVIRONMENT,
        mandateId: mandate.id,
        signalIds,
        symbol: candidate.underlying,
        side: 'sell',
        // A limit at the bid, day-only: the credit is the whole point of the trade, so we never hand it to
        // a market order on an indicative spread, and we never leave a resting order out overnight.
        orderType: 'limit',
        limitPrice: candidate.limitPrice,
        timeInForce: 'day',
        qty: contracts,
        rationale: rationaleById.get(candidateId) ?? candidate.note,
        optionLeg: {
          expiration: candidate.expiration,
          strike: candidate.strike,
          right: candidate.right,
          positionIntent: 'sell_to_open',
        },
      });
      // H8 — a proposal the desk stands behind is a falsifiable claim, so it goes on the same ledger that
      // grades the creators it listens to. Returns the action stamped with its `predictionId` (unchanged if
      // the proposal was discarded, or if the ledger write failed — the record never gates the trade).
      const claimed = await this.deskLedger.recordProposalClaim(userId, mandate.body.name, action);
      actions.push(claimed);

      // A call is only spent when a proposal actually cleared the ceilings on it. A discarded proposal
      // acted on nothing, so its signals stay open for the next cycle to weigh again.
      if (signalIds.length && action.body.status === 'proposed') {
        await this.signals.markSignalsActed(userId, signalIds, action.id);
      }
    }

    // H7 — a decline is a verdict, so it is written down. The call stays open; only the reason is stored,
    // so the judge page can show "weighed and passed, because …" instead of an unexplained silence.
    if (declinedSignals.length) {
      await this.signals.markSignalsDeclined(
        userId,
        declinedSignals.map(({ signalId, reason }) => ({ signalId, reason })),
      );
    }

    this.logger.log(
      `Alpaca mandate ${mandate.id} dry-run: ${candidates.length} candidate(s), ${selected.length} selected, ` +
        `${actions.length} action(s) proposed/discarded, ${skipped.length} selection(s) skipped, ` +
        `${openSignals.length} open creator call(s) weighed (${declinedSignals.length} declined).`,
    );

    return {
      mandateId: mandate.id,
      candidates,
      selected,
      usedAi,
      provider,
      narrative,
      actions,
      skipped,
      openSignals,
      declinedSignals,
    };
  }

  /**
   * Ask the persona (mandate's provider/model, via the Forum's one real LLM call site) which candidates
   * to act on. Falls back to "propose every bounds-eligible candidate" when no live provider is configured
   * or the response can't be parsed into valid candidate ids — mirrors the Forum's local-provider fallback,
   * and keeps Phase A self-verifiable with zero keys.
   */
  private async choosePersonaCandidates(
    userId: string,
    mandate: Required<$.AlpacaMandate>,
    candidates: OptionMandateCandidate[],
    openSignals: OpenSignalBrief[],
    // Cash NET of collateral already reserved by open short puts (H16) — the agent must reason from what
    // it can actually pledge, not from a balance the broker is already holding against yesterday's put.
    uncommittedCash: number,
    equity: number,
  ): Promise<{
    selected: string[];
    unknownSelections: string[];
    usedAi: boolean;
    provider: string;
    narrative: string | null;
    rationaleById: Map<string, string>;
    signalIdsByCandidate: Map<string, string[]>;
    declinedSignals: MandateDryRunResult['declinedSignals'];
  }> {
    const agent: ForumAgentSnapshot = {
      id: mandate.id,
      name: mandate.body.name,
      slug: mandate.id,
      role: 'analyst',
      avatar_url: null,
      description: '',
      soul: mandate.body.mandate,
      provider: mandate.body.provider,
      model: mandate.body.model,
      sort_order: 0,
    };
    const task = [
      'Options income dry-run. Every candidate below is a REAL listed contract with a live quote, already ' +
        'inside the account and mandate risk bounds; `yieldPct` is the credit as a percentage of the ' +
        'collateral it ties up until expiry. `cash` is what is actually free to pledge today — collateral ' +
        'already reserved by open short puts has been deducted. Decide which — if any — to sell today.',
      SIGNAL_TASK_SECTION,
      'Reply with ONLY JSON: {"narrative": "<summary>", "select": ["<candidateId>", ...], ' +
        '"rationale": {"<candidateId>": "<why>"}, ' +
        '"signals": {"<candidateId>": ["<signalId>", ...]}, "declined": {"<signalId>": "<why not>"}}. ' +
        '`narrative` is two or three sentences of plain prose summarising today\u2019s decision for a human ' +
        'reader \u2014 no JSON, no markdown, no bullet list. ' +
        "The candidateId is the contract's OCC symbol; only use ids from the lists above, never invent one.",
    ].join('\n\n');
    const payload = JSON.stringify({ cash: round2(uncommittedCash), equity: round2(equity), openSignals, candidates });

    const result = await this.forumInference.complete({
      userId,
      agent,
      task,
      messages: [{ role: 'user', content: `${task}\n\nCandidates:\n${payload}` }],
      responseFormat: 'json',
    });

    if (result.usedAi) {
      const parsed = parsePersonaSelection(result.text, candidates, openSignals);
      if (parsed) {
        // A citation we could not tie to a call the agent was shown, on that same underlying, is dropped
        // rather than recorded — and said out loud, because a silently-dropped citation is a proposal whose
        // stated reason is missing from its own record.
        if (parsed.droppedCitations) {
          this.logger.warn(
            `Alpaca mandate ${mandate.id} dry-run: dropped ${parsed.droppedCitations} signal citation(s) ` +
              'that named no open call on the cited contract’s underlying.',
          );
        }
        return {
          selected: parsed.selected,
          unknownSelections: parsed.unknownSelections,
          usedAi: true,
          provider: result.provider,
          narrative: parsed.narrative,
          rationaleById: parsed.rationaleById,
          signalIdsByCandidate: parsed.signalIdsByCandidate,
          declinedSignals: parsed.declinedSignals,
        };
      }
      this.logger.warn(
        `Alpaca mandate ${mandate.id} dry-run: persona reply unparseable — falling back deterministically.`,
      );
    }

    return {
      selected: candidates.map((c) => c.id),
      // The fallback only ever names contracts it just built, so it can invent nothing.
      unknownSelections: [],
      usedAi: false,
      provider: 'local',
      narrative:
        'Deterministic fallback (no live inference provider configured for this mandate) — proposing every candidate that already cleared the DTE/delta/OTM bounds.',
      rationaleById: new Map(),
      // The fallback weighed no creator's call, so it cites none. An action that claimed a signal it never
      // read would be the exact fabrication the ledger exists to prevent.
      signalIdsByCandidate: new Map(),
      declinedSignals: [],
    };
  }

  private async loadOwnedMandate(userId: string, id: string): Promise<Required<$.AlpacaMandate>> {
    const mandate = await this.entityService.findById<$.AlpacaMandate>(id);
    if (!mandate || mandate.owner_id !== userId || mandate.type !== 'alpaca_mandate' || mandate.status !== 'active') {
      throw new NotFoundException('Alpaca mandate not found.');
    }
    return mandate as Required<$.AlpacaMandate>;
  }
}

function normalizeOptionStrategy(
  input: MandateOptionStrategyInput | undefined,
  existing?: $.AlpacaMandate['body']['optionStrategy'],
): $.AlpacaMandate['body']['optionStrategy'] {
  return {
    targetUnderlyings: input?.targetUnderlyings
      ? dedupeUnderlyings(input.targetUnderlyings)
      : (existing?.targetUnderlyings ?? []),
    minDaysToExpiry: input?.minDaysToExpiry !== undefined ? input.minDaysToExpiry : (existing?.minDaysToExpiry ?? null),
    maxDaysToExpiry: input?.maxDaysToExpiry !== undefined ? input.maxDaysToExpiry : (existing?.maxDaysToExpiry ?? null),
    requireOtm: input?.requireOtm !== undefined ? input.requireOtm : (existing?.requireOtm ?? true),
    maxAbsDelta: input?.maxAbsDelta !== undefined ? input.maxAbsDelta : (existing?.maxAbsDelta ?? null),
  };
}

function dedupeUnderlyings(symbols: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    if (symbol) {
      seen.add(symbol);
    }
  }
  return [...seen];
}

interface EffectiveBounds {
  minDte: number;
  maxDte: number;
  requireOtm: boolean;
  maxAbsDelta: number | null;
}

// The mandate can only NARROW the account-wide ceiling, never loosen it — tightest of the two wins.
function intersectBounds(
  mandateStrategy: $.AlpacaMandate['body']['optionStrategy'],
  controlLimits: {
    minDaysToExpiry: number | null;
    maxDaysToExpiry: number | null;
    requireOtm: boolean;
    maxAbsDelta: number | null;
  },
): EffectiveBounds {
  const minDte = Math.max(mandateStrategy.minDaysToExpiry ?? 0, controlLimits.minDaysToExpiry ?? 0) || 7;
  const rawMaxDte = minOfNullable(mandateStrategy.maxDaysToExpiry, controlLimits.maxDaysToExpiry) ?? 45;
  const maxDte = Math.max(minDte, rawMaxDte);
  const maxAbsDelta = minOfNullable(mandateStrategy.maxAbsDelta, controlLimits.maxAbsDelta);
  return {
    minDte,
    maxDte,
    requireOtm: mandateStrategy.requireOtm || controlLimits.requireOtm,
    maxAbsDelta,
  };
}

function minOfNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

// Today + `days`, as a YYYY-MM-DD date — used to bound a chain query's expiration window.
function isoDatePlusDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isFriday(expiration: string): boolean {
  return new Date(`${expiration}T00:00:00.000Z`).getUTCDay() === 5;
}

interface LegRequest {
  underlying: string;
  right: AlpacaOptionRight;
  strategy: OptionMandateCandidate['strategy'];
  price: number;
  bounds: EffectiveBounds;
  maxContractsPerOrder: number | null;
  // Exactly one of these, by strategy: shares-derived contract capacity for a covered call, cash on hand
  // for a cash-secured put (its capacity depends on each contract's own strike).
  capacityContracts?: number;
  cash?: number;
}

// Read the real listed chain around the last print and return the best few sellable contracts. Every
// candidate that comes out of here is a contract Alpaca lists, with a live two-sided quote, a premium
// worth collecting and a delta inside the bounds.
async function buildLegCandidates(client: AlpacaClient, request: LegRequest): Promise<OptionMandateCandidate[]> {
  const expiration = await discoverExpiration(client, request);
  if (!expiration) {
    return [];
  }
  const quotes = await fetchExpiryChain(client, request, expiration);
  const daysToExpiry = daysUntilExpiration(expiration);
  const maxAbsDelta = request.bounds.maxAbsDelta ?? DEFAULT_MAX_ABS_DELTA;

  const candidates: OptionMandateCandidate[] = [];
  for (const quote of quotes) {
    if (quote.expiration !== expiration || quote.bid == null || quote.bid < MIN_PREMIUM_PER_SHARE) {
      continue;
    }
    if (request.bounds.requireOtm && !isOtm(request.right, quote.strike, request.price)) {
      continue;
    }
    const deltaResult = computeOptionDelta({
      right: request.right,
      underlyingPrice: request.price,
      strike: quote.strike,
      expiration,
      optionMidPrice: quote.mid,
      feedGreeks: quote.greeks,
      now: Date.now(),
    });
    // An unverifiable delta is a dropped candidate, not a passed one — the same "options cannot limp"
    // rule the safeguards enforce (they would fail this proposal closed anyway).
    const absDelta = deltaResult.delta == null ? null : Math.abs(deltaResult.delta);
    if (absDelta == null || absDelta < MIN_ABS_DELTA || absDelta > maxAbsDelta) {
      continue;
    }
    const contracts = contractsFor(request, quote.strike);
    if (contracts < 1) {
      continue;
    }

    const collateral = round2(
      request.strategy === 'cash_secured_put'
        ? quote.strike * contracts * SHARES_PER_CONTRACT
        : request.price * contracts * SHARES_PER_CONTRACT,
    );
    const premium = round2(quote.bid * contracts * SHARES_PER_CONTRACT);
    const yieldPct = collateral > 0 ? round2((premium / collateral) * 100) : 0;
    const otmPct = round2((Math.abs(quote.strike - request.price) / request.price) * 100);
    const label = request.strategy === 'cash_secured_put' ? 'Cash-secured put' : 'Covered call';
    candidates.push({
      id: quote.occSymbol,
      underlying: request.underlying,
      strategy: request.strategy,
      right: request.right,
      occSymbol: quote.occSymbol,
      strike: quote.strike,
      expiration,
      contracts,
      underlyingPrice: request.price,
      daysToExpiry,
      delta: deltaResult.delta,
      deltaSource: deltaSourceOf(deltaResult),
      impliedVol: deltaResult.greeks?.impliedVol ?? null,
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      limitPrice: quote.bid,
      premium,
      collateral,
      yieldPct,
      note:
        `${label}: sell ${contracts} × ${request.underlying} ${quote.strike}${request.right === 'call' ? 'C' : 'P'} ` +
        `${expiration} (${daysToExpiry} DTE) at the ${quote.bid} bid — $${premium} credit on $${collateral} ` +
        `collateral (${yieldPct}%), delta ${deltaResult.delta}, ${otmPct}% OTM vs ${request.price}.`,
    });
  }

  // Best yield on the collateral it ties up, which is the comparison that matters across strikes.
  return candidates.sort((a, b) => b.yieldPct - a.yieldPct).slice(0, MAX_CANDIDATES_PER_LEG);
}

// Which expiry to trade, read from the chain itself: a few near-the-money strikes across the DTE window
// is enough to see every expiry the underlying lists, and cheap enough to stay in one page. If the near
// window lists nothing (an underlying with monthly-only expiries), widen once to the full window rather
// than reporting "no candidates" for a chain that has them.
async function discoverExpiration(client: AlpacaClient, request: LegRequest): Promise<string | null> {
  const { price, right, bounds } = request;
  const halfBand = Math.max(price * EXPIRY_SCAN_BAND_PCT, EXPIRY_SCAN_BAND_MIN);
  const band = { strikeGte: round2(price - halfBand), strikeLte: round2(price + halfBand) };
  const scanMaxDte = Math.min(bounds.maxDte, bounds.minDte + EXPIRY_SCAN_DAYS);
  const near = await client.getOptionChain(request.underlying, {
    ...band,
    right,
    expirationGte: isoDatePlusDays(bounds.minDte),
    expirationLte: isoDatePlusDays(scanMaxDte),
    limit: CHAIN_PAGE_LIMIT,
  });
  const nearest = pickExpiration(near, bounds);
  if (nearest || scanMaxDte >= bounds.maxDte) {
    return nearest;
  }
  const wide = await client.getOptionChain(request.underlying, {
    ...band,
    right,
    expirationGte: isoDatePlusDays(bounds.minDte),
    expirationLte: isoDatePlusDays(bounds.maxDte),
    limit: CHAIN_PAGE_LIMIT,
  });
  return pickExpiration(wide, bounds);
}

// Every listed strike at the chosen expiry inside the selection band — one expiry, so one page.
function fetchExpiryChain(client: AlpacaClient, request: LegRequest, expiration: string): Promise<AlpacaOptionQuote[]> {
  const { price, right, bounds } = request;
  return client.getOptionChain(request.underlying, {
    expiration,
    right,
    strikeGte: round2(bounds.requireOtm && right === 'call' ? price : price * (1 - STRIKE_BAND_PCT)),
    strikeLte: round2(bounds.requireOtm && right === 'put' ? price : price * (1 + STRIKE_BAND_PCT)),
    limit: CHAIN_PAGE_LIMIT,
  });
}

// The expiry to trade: the nearest LISTED one whose DTE sits inside the bounds, preferring the standard
// weekly Friday when the chain lists both (Friday expiries carry the liquidity).
function pickExpiration(quotes: AlpacaOptionQuote[], bounds: EffectiveBounds): string | null {
  const eligible = new Set<string>();
  for (const quote of quotes) {
    const dte = daysUntilExpiration(quote.expiration);
    if (dte >= bounds.minDte && dte <= bounds.maxDte) {
      eligible.add(quote.expiration);
    }
  }
  const listed = [...eligible].sort();
  const fridays = listed.filter(isFriday);
  return (fridays.length > 0 ? fridays : listed)[0] ?? null;
}

function isOtm(right: AlpacaOptionRight, strike: number, underlyingPrice: number): boolean {
  return right === 'call' ? strike > underlyingPrice : strike < underlyingPrice;
}

// How many contracts the account can actually back for this contract, before the per-order cap.
function contractsFor(request: LegRequest, strike: number): number {
  const capacity =
    request.strategy === 'cash_secured_put'
      ? Math.floor((request.cash ?? 0) / (strike * SHARES_PER_CONTRACT))
      : (request.capacityContracts ?? 0);
  return Math.min(capacity, request.maxContractsPerOrder ?? capacity);
}

// The same sizing question asked again at propose time, against the collateral this cycle has already
// committed to earlier proposals.
function affordableContracts(
  candidate: OptionMandateCandidate,
  cashRemaining: number,
  sharesRemaining: Map<string, number>,
): number {
  if (candidate.strategy === 'cash_secured_put') {
    const affordable = Math.floor(cashRemaining / (candidate.strike * SHARES_PER_CONTRACT));
    return Math.min(candidate.contracts, affordable);
  }
  const shares = sharesRemaining.get(candidate.underlying) ?? 0;
  return Math.min(candidate.contracts, Math.floor(shares / SHARES_PER_CONTRACT));
}

// The owner's allow/deny lists are a hard ceiling on what may be traded — a mandate target that isn't on
// the allow-list (or is on the deny-list) never becomes a candidate.
function allowedUnderlyings(symbols: string[], limits: AlpacaControlLimits): string[] {
  return symbols.filter(
    (symbol) =>
      !limits.symbolDenyList.includes(symbol) &&
      (limits.symbolAllowList.length === 0 || limits.symbolAllowList.includes(symbol)),
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Parse the persona's JSON reply, keeping only candidate ids that are actually in the offered list — a
// hallucinated id is dropped, never proposed (the LLM proposes, deterministic code disposes). The same
// rule governs its signal citations (H15): a cited call must be one the agent was actually shown AND be a
// call on that very contract's underlying, so a proposal can never carry a creator's name it did not read
// or attach a call about one ticker to a trade on another.
function parsePersonaSelection(
  text: string,
  candidates: OptionMandateCandidate[],
  openSignals: OpenSignalBrief[],
): {
  narrative: string | null;
  selected: string[];
  unknownSelections: string[];
  rationaleById: Map<string, string>;
  signalIdsByCandidate: Map<string, string[]>;
  declinedSignals: MandateDryRunResult['declinedSignals'];
  droppedCitations: number;
} | null {
  const validIds = new Set(candidates.map((c) => c.id));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const signalById = new Map(openSignals.map((brief) => [brief.signalId, brief]));
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      narrative?: unknown;
      select?: unknown;
      rationale?: Record<string, unknown>;
      signals?: Record<string, unknown>;
      declined?: Record<string, unknown>;
    };
    if (!Array.isArray(parsed.select)) {
      return null;
    }
    const named = parsed.select.filter((id): id is string => typeof id === 'string');
    const selected = named.filter((id) => validIds.has(id));
    // An id the agent named that is not a contract it was shown. It is never proposed — but it is
    // handed back rather than quietly filtered, because an invented pick is exactly what a reader
    // needs to see, and nothing else in the result would reveal it.
    const unknownSelections = named.filter((id) => !validIds.has(id));
    const rationaleById = new Map<string, string>();
    if (parsed.rationale && typeof parsed.rationale === 'object') {
      for (const [id, value] of Object.entries(parsed.rationale)) {
        if (validIds.has(id) && typeof value === 'string') {
          rationaleById.set(id, truncateOnWordBoundary(value, RATIONALE_MAX_CHARS));
        }
      }
    }

    let droppedCitations = 0;
    const signalIdsByCandidate = new Map<string, string[]>();
    if (parsed.signals && typeof parsed.signals === 'object') {
      for (const [candidateId, value] of Object.entries(parsed.signals)) {
        const candidate = candidateById.get(candidateId);
        const cited = Array.isArray(value) ? value : [];
        if (!candidate) {
          droppedCitations += cited.length;
          continue;
        }
        const kept = [
          ...new Set(
            cited.filter(
              (id): id is string => typeof id === 'string' && signalById.get(id)?.ticker === candidate.underlying,
            ),
          ),
        ];
        droppedCitations += cited.length - kept.length;
        if (kept.length) {
          signalIdsByCandidate.set(candidateId, kept);
        }
      }
    }

    const declinedSignals: MandateDryRunResult['declinedSignals'] = [];
    if (parsed.declined && typeof parsed.declined === 'object') {
      for (const [signalId, reason] of Object.entries(parsed.declined)) {
        const brief = signalById.get(signalId);
        if (brief && typeof reason === 'string' && reason.trim()) {
          declinedSignals.push({
            signalId,
            ticker: brief.ticker,
            creator: brief.creator,
            reason: truncateOnWordBoundary(reason, DECLINE_REASON_MAX_CHARS),
          });
        }
      }
    }

    // Prose for a human, asked for in the same reply rather than a second call. Absent or blank leaves
    // the field null: showing nothing beats showing the model\u2019s raw JSON as if it were a summary.
    const narrative =
      typeof parsed.narrative === 'string' && parsed.narrative.trim()
        ? truncateOnWordBoundary(parsed.narrative, NARRATIVE_MAX_CHARS)
        : null;

    return {
      narrative,
      selected,
      unknownSelections,
      rationaleById,
      signalIdsByCandidate,
      declinedSignals,
      droppedCitations,
    };
  } catch {
    return null;
  }
}
