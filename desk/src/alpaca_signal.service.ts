import { entity_alpaca_signal } from '#schema_registry';
import { Injectable, Logger } from '@nestjs/common';
import { EntityService } from '~/entity/entity.service';
import { ForumInferenceService } from '~/api/forum/forum_inference.service';
import type { ForumAgentSnapshot } from '~/api/forum/forum.types';
import { ManagerScorecard, PredictionLedgerService } from '~/api/user/prediction_ledger/prediction_ledger.service';
import { SourcePortfolioService } from '~/api/user/target_engine/source_portfolio.service';
import { SUPADATA_API_KEY } from '~/server_config';
import { AlpacaChannelService } from './alpaca_channel.service';
import { AlpacaLifecycleService } from './alpaca_lifecycle.service';
import { AlpacaEnvironment } from './alpaca.types';
import {
  buildFalsifiableCondition,
  buildSourceRef,
  claimTypeForTicker,
  ExtractedSignal,
  hedgeLevelForConfidence,
  MAX_HORIZON_DAYS,
  MAX_QUOTE_CHARS,
  MIN_HORIZON_DAYS,
  MIN_QUOTE_CHARS,
  parseExtractedSignals,
  resolveByFor,
} from './signal_extraction';
import { SupadataClient, TranscriptSource, VideoTranscript } from './transcript_source';

/**
 * Signal extraction (H14) — the middle third of the desk's edge, between "which creators does he listen
 * to" (H13) and "what did the desk do about it" (H15).
 *
 * One video in, one inference call out, and every surviving call lands as a **falsifiable claim on the
 * prediction ledger** against a source portfolio for that creator. That last part is the whole point: an
 * extracted opinion that is never graded is a summary, and the desk already has enough opinions. A claim
 * with a verbatim quote, a stated condition and a resolve-by date makes the creator gradable, which is
 * what lets H15 weigh his call by his record rather than by his subscriber count.
 *
 * Three rules this service will not bend:
 *
 *  1. **A quote that is not in the transcript is dropped.** See `signal_extraction.ts` — the stored quote
 *     is the transcript's own characters, recovered by matching, never the model's rendering.
 *  2. **`usedAi: false` is a hard failure, never an empty result.** With no provider key the inference
 *     service falls back to deterministic `local` output, which yields no text at all. Reported as
 *     "no calls in this video" that is a lie about a creator, so it throws and names the provider instead.
 *  3. **A video is marked extracted only when it was really read.** A missing transcript leaves
 *     `extractedAt` null so a later refresh retries it, because "deferred" must never read as "silent".
 */

/** How many un-extracted videos one call will read. Each is an inference call over a whole transcript. */
export const MAX_VIDEOS_PER_EXTRACTION = 3;
/** Guard against a three-hour livestream transcript blowing the context window and the budget. */
const MAX_TRANSCRIPT_CHARS = 120_000;
/**
 * Extraction is the one bulk workload here: whole transcripts, up to MAX_TRANSCRIPT_CHARS each, several per
 * run. It reads and summarises rather than deciding anything, so it runs on a cheap long-context model
 * instead of DEFAULT_OPENROUTER_MODEL — which is chosen for the reasoning path, where a wrong call costs
 * more than the tokens. Pinned rather than read from the workspace config so a model the owner picks in the
 * UI for the forum can never silently retarget it.
 */
const EXTRACTOR_MODEL = 'z-ai/glm-5.3-flash';
/** Cap what the model may return, so one video cannot produce a wall of low-conviction noise. */
const MAX_SIGNALS_PER_VIDEO = 6;
/** How much of the raw reply is logged when a video yields nothing — enough to see the shape it sent. */
const DROPPED_REPLY_SAMPLE_CHARS = 1_200;

/** How many open creator calls the desk agent is shown in one cycle — one per ticker, newest first. */
export const MAX_OPEN_SIGNAL_BRIEFS = 12;

/**
 * The creator's graded record on the ledger for the claim type this call belongs to (H15). Never blended
 * across claim types — a creator's index timing and his stock picking are scored apart (the ledger's own
 * rule) — and `percentage` stays `null` below the ledger's honesty threshold, which the desk agent is told
 * to read as "unproven", never as "average".
 */
export interface SignalCreatorRecord {
  claimType: 'market_timing' | 'stock_selection';
  /** Claims of this type that resolved gradable (right / wrong / right-but-late). */
  sampleSize: number;
  /** How many of those the creator got directionally right. */
  count: number;
  percentage: number | null;
}

/** One open creator call, as the desk agent reads it in the mandate dry-run (H15). */
export interface OpenSignalBrief {
  signalId: string;
  creator: string;
  creatorHitRate: SignalCreatorRecord;
  ticker: string;
  direction: $.AlpacaSignal['body']['direction'];
  thesis: string;
  quote: string;
  /** When the creator said it — a three-week-old call and this morning's are not the same input. */
  saidAt: string | null;
}

/**
 * Action statuses that mean nothing was ever expressed in the market, so the creator's call it cited is
 * given back to the desk (H16). `canceled` belongs here with `failed`/`discarded`: a canceled order left
 * no position behind either.
 */
const UNEXPRESSED_ACTION_STATUSES = new Set(['failed', 'discarded', 'canceled']);

/** One call handed back because the action that claimed it never reached the market (H16). */
export interface ReleasedSignal {
  signalId: string;
  ticker: string;
  actionId: string;
  actionStatus: string;
}

export type ExtractedVideoOutcome = 'extracted' | 'no_transcript' | 'no_calls' | 'error';

export interface ExtractedVideoReport {
  channelId: string;
  channelTitle: string;
  videoId: string;
  videoTitle: string;
  outcome: ExtractedVideoOutcome;
  signalIds: string[];
  /** Candidate calls the model proposed that failed validation, with the reason. Never silently swallowed. */
  droppedCount: number;
  droppedReasons: string[];
  error: string | null;
}

export interface ExtractSignalsResult {
  provider: string;
  model: string | null;
  videosRead: number;
  signalsCreated: number;
  videos: ExtractedVideoReport[];
}

/** Thrown when the inference provider is not really answering — loud by design (rule 2 above). */
export class SignalProviderUnavailableError extends Error {}

@Injectable()
export class AlpacaSignalService {
  private readonly logger = new Logger(AlpacaSignalService.name);

  constructor(
    private readonly entityService: EntityService,
    private readonly channels: AlpacaChannelService,
    private readonly forumInference: ForumInferenceService,
    private readonly predictions: PredictionLedgerService,
    private readonly sourcePortfolios: SourcePortfolioService,
    private readonly lifecycle: AlpacaLifecycleService,
  ) {}

  /** Overridden in tests with `LocalTranscriptSource`; production always talks to Supadata. */
  protected transcriptSource(): TranscriptSource {
    return new SupadataClient(SUPADATA_API_KEY);
  }

  /** This user's signals, newest first. `status` narrows to open / acted / resolved. */
  async listSignals(
    userId: string,
    filter: { environment?: AlpacaEnvironment; status?: $.AlpacaSignal['body']['status']; limit?: number } = {},
  ): Promise<Required<$.AlpacaSignal>[]> {
    const environment = filter.environment ?? 'paper';
    const found = await this.entityService.findMany<$.AlpacaSignal>({
      where: {
        type: 'alpaca_signal',
        owner_id: userId,
        status: 'active',
        ...(filter.status ? { header: { path: ['signal_status'], equals: filter.status } } : {}),
      },
    });
    return (found as Required<$.AlpacaSignal>[])
      .filter((signal) => signal.body.environment === environment)
      .sort((a, b) => b.body.extractedAt.localeCompare(a.body.extractedAt))
      .slice(0, Math.max(1, filter.limit ?? 50));
  }

  /**
   * Read the oldest un-extracted videos on the followed channels and turn what the creators actually said
   * into ledger claims. Bounded per call (`MAX_VIDEOS_PER_EXTRACTION`) so a backlog drains over several
   * cycles instead of one call spending an unbounded number of inference credits.
   */
  async extractSignals(
    userId: string,
    options: { environment?: AlpacaEnvironment; limit?: number; channelEntityId?: string } = {},
  ): Promise<ExtractSignalsResult> {
    const environment = options.environment ?? 'paper';
    const limit = Math.max(1, Math.min(MAX_VIDEOS_PER_EXTRACTION * 4, options.limit ?? MAX_VIDEOS_PER_EXTRACTION));
    const followed = await this.channels.listChannels(userId, environment);
    const scoped = options.channelEntityId
      ? followed.filter((channel) => channel.id === options.channelEntityId)
      : followed;

    const pending = this.pendingVideos(scoped).slice(0, limit);
    const result: ExtractSignalsResult = {
      provider: 'none',
      model: null,
      videosRead: 0,
      signalsCreated: 0,
      videos: [],
    };
    if (pending.length === 0) return result;

    const source = this.transcriptSource();
    // One broker client for the whole run — every reference price comes from the same instant, so two
    // signals extracted together are anchored consistently.
    const prices = new Map<string, number | null>();

    for (const { channel, video } of pending) {
      const report: ExtractedVideoReport = {
        channelId: channel.body.channelId,
        channelTitle: channel.body.title,
        videoId: video.videoId,
        videoTitle: video.title,
        outcome: 'error',
        signalIds: [],
        droppedCount: 0,
        droppedReasons: [],
        error: null,
      };
      result.videos.push(report);

      try {
        const transcript = await source.fetchTranscript(video.videoId);
        if (!transcript) {
          // Deliberately NOT marked extracted: the video was never read, so a later refresh must retry it.
          report.outcome = 'no_transcript';
          report.error = 'No transcript available yet.';
          continue;
        }

        const extraction = await this.extractFromTranscript(userId, channel, video, transcript);
        result.provider = extraction.provider;
        result.model = extraction.model;
        result.videosRead++;
        report.droppedCount = extraction.dropped.length;
        report.droppedReasons = [...new Set(extraction.dropped.map((drop) => drop.reason))];

        for (const signal of extraction.signals) {
          const saved = await this.persistSignal({
            userId,
            environment,
            channel,
            video,
            signal,
            provider: extraction.provider,
            model: extraction.model,
            prices,
          });
          if (saved) {
            report.signalIds.push(saved.id);
            result.signalsCreated++;
          }
        }
        report.outcome = report.signalIds.length ? 'extracted' : 'no_calls';
        await this.channels.markVideoExtracted(userId, channel.id, video.videoId);
      } catch (error) {
        if (error instanceof SignalProviderUnavailableError) throw error;
        report.error = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Signal extraction failed for ${video.videoId} (${channel.body.title}): ${report.error}`);
      }
    }

    this.logger.log(
      `Signal extraction (${result.provider}${result.model ? `/${result.model}` : ''}): ` +
        `${result.videosRead} video(s) read, ${result.signalsCreated} signal(s) logged.`,
    );
    return result;
  }

  /**
   * The open calls the desk agent should weigh this cycle (H15) — deduped to one per ticker (the newest,
   * because a creator's latest word on a ticker supersedes his last one), each carrying the creator's own
   * graded record so the agent can weigh a call by the caller's track record rather than by his delivery.
   *
   * A call whose horizon has already passed is excluded even while its row still reads `open`: the ledger
   * grades it on its own schedule, and a lapsed call is a claim to resolve, never a trade to place today.
   */
  async openSignalBriefs(
    userId: string,
    environment: AlpacaEnvironment = 'paper',
    limit: number = MAX_OPEN_SIGNAL_BRIEFS,
  ): Promise<OpenSignalBrief[]> {
    const open = await this.listSignals(userId, { environment, status: 'open', limit: 200 });
    const now = Date.now();

    const newestPerTicker = new Map<string, Required<$.AlpacaSignal>>();
    for (const signal of open) {
      // `listSignals` is newest-first, so the first row seen for a ticker is the creator's latest word.
      if (Date.parse(signal.body.resolveBy) <= now) continue;
      if (!newestPerTicker.has(signal.body.ticker)) newestPerTicker.set(signal.body.ticker, signal);
    }

    const chosen = [...newestPerTicker.values()].slice(0, Math.max(1, limit));
    if (chosen.length === 0) return [];

    // One name→id map for every creator source, then at most one scorecard per creator, memoized: a
    // dozen briefs from three channels must not be a dozen ledger scans.
    const sources = await this.sourcePortfolios.listSourcePortfolios(userId, 'tracked_manager');
    const sourceIdByName = new Map(sources.map((source) => [source.body.name, source.id]));
    const scorecards = new Map<string, ManagerScorecard>();

    const briefs: OpenSignalBrief[] = [];
    for (const signal of chosen) {
      const claimType = claimTypeForTicker(signal.body.ticker);
      briefs.push({
        signalId: signal.id,
        creator: signal.body.channelTitle,
        creatorHitRate: await this.creatorRecord(
          userId,
          sourceIdByName.get(channelSourceName(signal.body.channelTitle)),
          claimType,
          scorecards,
        ),
        ticker: signal.body.ticker,
        direction: signal.body.direction,
        thesis: signal.body.thesis,
        quote: signal.body.quote,
        saidAt: signal.body.publishedAt,
      });
    }
    return briefs;
  }

  /** The creator's hit rate for one claim type, memoized per source portfolio for the run. */
  private async creatorRecord(
    userId: string,
    sourcePortfolioId: string | undefined,
    claimType: SignalCreatorRecord['claimType'],
    memo: Map<string, ManagerScorecard>,
  ): Promise<SignalCreatorRecord> {
    // No ledger source yet means no graded claims yet — reported as an empty sample, never as a zero score.
    if (!sourcePortfolioId) return { claimType, sampleSize: 0, count: 0, percentage: null };

    let scorecard = memo.get(sourcePortfolioId);
    if (!scorecard) {
      scorecard = await this.predictions.getManagerScorecard(userId, sourcePortfolioId);
      memo.set(sourcePortfolioId, scorecard);
    }
    const row = scorecard.claimTypes.find((entry) => entry.claimType === claimType);
    return {
      claimType,
      sampleSize: row?.hitRate.sampleSize ?? 0,
      count: row?.hitRate.count ?? 0,
      percentage: row?.hitRate.percentage ?? null,
    };
  }

  /** Flip signals to `acted` and remember which action acted on them (H15's back-pointer). */
  async markSignalsActed(userId: string, signalIds: string[], actionId: string): Promise<number> {
    let updated = 0;
    for (const id of signalIds) {
      const signal = await this.entityService.findById<$.AlpacaSignal>(id);
      if (!signal || signal.owner_id !== userId || signal.type !== 'alpaca_signal' || signal.status !== 'active') {
        continue;
      }
      if (signal.body.status !== 'open') continue;
      await this.entityService.update<$.AlpacaSignal>(signal as Required<$.AlpacaSignal>, (draft) => {
        draft.header.signal_status = 'acted';
        draft.body.status = 'acted';
        draft.body.actedActionId = actionId;
        // An earlier cycle's decline is superseded the moment the desk acts on the call — leaving it would
        // show the judge two contradictory verdicts on one signal.
        draft.body.lastDeclinedAt = null;
        draft.body.lastDeclineReason = null;
      });
      updated++;
    }
    return updated;
  }

  /**
   * H7 — persist the agent's decline so the verdict outlives the cycle that reached it.
   *
   * H15 already made the agent say why it passed on a call, but the reason lived only in the dry-run
   * result: a minute later nothing in the system could tell "weighed and declined" apart from "never
   * looked at", which is precisely the distinction the desk page has to show. The signal stays **open** —
   * a decline is this cycle's judgment on a live call, not a disposal of it — so `status` is untouched and
   * the next cycle weighs the same call again, overwriting the reason with its newer one.
   */
  async markSignalsDeclined(userId: string, declines: Array<{ signalId: string; reason: string }>): Promise<number> {
    const at = new Date().toISOString();
    let updated = 0;
    for (const { signalId, reason } of declines) {
      const signal = await this.entityService.findById<$.AlpacaSignal>(signalId);
      if (!signal || signal.owner_id !== userId || signal.type !== 'alpaca_signal' || signal.status !== 'active') {
        continue;
      }
      // Only an open call can be declined. One already acted on has a stronger verdict on it already.
      if (signal.body.status !== 'open') continue;
      await this.entityService.update<$.AlpacaSignal>(signal as Required<$.AlpacaSignal>, (draft) => {
        draft.body.lastDeclinedAt = at;
        draft.body.lastDeclineReason = reason;
      });
      updated++;
    }
    return updated;
  }

  /**
   * Give back every call that was spent on an order the market never saw (H16).
   *
   * `markSignalsActed` fires the moment a proposal clears the ceilings, which is the right moment — but a
   * proposal is not a trade. An auto-approved action can still come back `failed` (the broker refused it)
   * or `discarded` (the execute-time re-check rejected it), and until this ran, the creator's call stayed
   * `acted` forever, pointing at a trade that was never expressed. The desk would then never weigh that
   * call again, which is a silent loss of exactly the input H13–H15 exist to capture.
   *
   * Deliberately NOT released: `rejected` and `expired`. The owner turning a proposal down — or letting it
   * lapse — is a decision about that call, and re-proposing it next cycle would argue with him. Only the
   * machine's own failures give a call back.
   */
  async releaseSignalsForUnexpressedActions(userId: string, environment: AlpacaEnvironment): Promise<ReleasedSignal[]> {
    const signals = await this.entityService.findMany<$.AlpacaSignal>({
      where: { type: 'alpaca_signal', owner_id: userId, status: 'active' },
    });
    const acted = signals.filter(
      (s) => s.body.environment === environment && s.body.status === 'acted' && s.body.actedActionId,
    );
    if (acted.length === 0) return [];

    const actions = await this.entityService.findMany<$.AlpacaAction>({
      where: { type: 'alpaca_action', owner_id: userId, status: 'active' },
    });
    const statusById = new Map(actions.map((a) => [a.id, a.body.status]));

    const released: ReleasedSignal[] = [];
    for (const signal of acted) {
      const actionId = signal.body.actedActionId as string;
      const actionStatus = statusById.get(actionId);
      // An action id we can't resolve is left alone — a missing row is a bookkeeping question, and
      // guessing "it must have failed" would hand a call back on no evidence at all.
      if (!actionStatus || !UNEXPRESSED_ACTION_STATUSES.has(actionStatus)) continue;

      await this.entityService.update<$.AlpacaSignal>(signal as Required<$.AlpacaSignal>, (draft) => {
        draft.header.signal_status = 'open';
        draft.body.status = 'open';
        draft.body.actedActionId = null;
      });
      released.push({ signalId: signal.id, ticker: signal.body.ticker, actionId, actionStatus });
    }

    if (released.length) {
      this.logger.log(
        `Alpaca signals (${environment}): released ${released.length} creator call(s) cited by orders that ` +
          `never reached the market — ${released.map((r) => `${r.ticker}/${r.actionStatus}`).join(', ')}.`,
      );
    }
    return released;
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────────────

  /** Every followed video nothing has read yet, oldest first so a backlog drains in publication order. */
  private pendingVideos(channels: Required<$.AlpacaChannel>[]) {
    const pending: Array<{ channel: Required<$.AlpacaChannel>; video: $.AlpacaChannel['body']['videos'][number] }> = [];
    for (const channel of channels) {
      for (const video of channel.body.videos) {
        if (!video.extractedAt) pending.push({ channel, video });
      }
    }
    return pending.sort((a, b) => (a.video.publishedAt ?? '').localeCompare(b.video.publishedAt ?? ''));
  }

  /** The one inference pass per video, plus the verbatim gate on what comes back. */
  private async extractFromTranscript(
    userId: string,
    channel: Required<$.AlpacaChannel>,
    video: $.AlpacaChannel['body']['videos'][number],
    transcript: VideoTranscript,
  ) {
    const agent: ForumAgentSnapshot = {
      id: `alpaca_signal_extractor:${channel.body.channelId}`,
      name: 'Signal extractor',
      slug: 'alpaca-signal-extractor',
      role: 'analyst',
      avatar_url: null,
      description: '',
      soul: EXTRACTOR_SOUL,
      // Blank provider = the workspace's configured default; the model is pinned (EXTRACTOR_MODEL) because
      // the default one stalls on whole-transcript prompts. A per-agent model overrides the workspace one
      // in `ForumInferenceService.complete`, so this is the intended seam for exactly this.
      provider: '',
      model: EXTRACTOR_MODEL,
      sort_order: 0,
    };
    const body = transcript.text.slice(0, MAX_TRANSCRIPT_CHARS);
    const header =
      `Channel: ${channel.body.title}\nVideo: ${video.title}\n` +
      `Published: ${video.publishedAt ?? 'unknown'}\nVideo id: ${video.videoId}`;

    const result = await this.forumInference.complete({
      userId,
      agent,
      task: EXTRACTOR_TASK,
      messages: [{ role: 'user', content: `${EXTRACTOR_TASK}\n\n${header}\n\nTranscript:\n${body}` }],
      responseFormat: 'json',
      systemFraming: EXTRACTOR_FRAMING,
    });

    // Rule 2: no live provider means no answer, not "no calls". Loud, named, and it stops the run.
    if (!result.usedAi) {
      throw new SignalProviderUnavailableError(
        `Signal extraction requires a live inference provider, but the completion fell back to ` +
          `"${result.provider}" and returned no text. Configure the provider and key on /agent-harness ` +
          `before extracting — otherwise an unread video would be recorded as a creator making no calls.`,
      );
    }

    const parsed = parseExtractedSignals(result.text, transcript);
    if (!parsed) {
      throw new Error(`Provider ${result.provider} returned an unparseable reply for video ${video.videoId}.`);
    }
    if (parsed.dropped.length) {
      this.logger.warn(
        `${video.videoId}: dropped ${parsed.dropped.length} candidate signal(s) — ` +
          parsed.dropped.map((drop) => `${drop.ticker ?? '?'}:${drop.reason}`).join(', '),
      );
    }
    // A video where the model proposed calls and NOT ONE survived is the case that needs the reply
    // itself, not a count: the reasons say which field was wrong, this says what the model actually
    // wrote. Without it "this video yielded nothing" is unanswerable after the fact — and the transcript
    // is gone by then, because we never store it.
    if (parsed.dropped.length && !parsed.signals.length) {
      this.logger.warn(
        `${video.videoId}: every candidate was dropped. Provider ${result.provider} replied: ` +
          result.text.trim().slice(0, DROPPED_REPLY_SAMPLE_CHARS),
      );
    }
    return {
      provider: result.provider,
      model: result.model,
      signals: parsed.signals.slice(0, MAX_SIGNALS_PER_VIDEO),
      dropped: parsed.dropped,
    };
  }

  /** One surviving call → a ledger claim → a signal row pointing at it. */
  private async persistSignal(params: {
    userId: string;
    environment: AlpacaEnvironment;
    channel: Required<$.AlpacaChannel>;
    video: $.AlpacaChannel['body']['videos'][number];
    signal: ExtractedSignal;
    provider: string;
    model: string | null;
    prices: Map<string, number | null>;
  }): Promise<Required<$.AlpacaSignal> | null> {
    const { userId, environment, channel, video, signal } = params;

    // A re-run after a partial failure must not double-log a creator's call.
    const existing = await this.findSignal(userId, video.videoId, signal.ticker);
    if (existing) return null;

    const now = new Date();
    const referencePrice = await this.referencePrice(userId, environment, signal.ticker, params.prices);
    const resolveBy = resolveByFor(video.publishedAt, signal.horizonDays, now);
    const sourceRef = buildSourceRef(video.videoId, signal.timestampSec);
    const falsifiableCondition = buildFalsifiableCondition({
      ticker: signal.ticker,
      direction: signal.direction,
      referencePrice,
      referenceAsOf: now.toISOString(),
      resolveBy,
      publishedAt: video.publishedAt,
    });

    const sourcePortfolioId = await this.ensureChannelSource(userId, channel);
    const { prediction } = await this.predictions.logPrediction(
      userId,
      {
        sourcePortfolioId,
        claimType: claimTypeForTicker(signal.ticker),
        claimVerbatim: signal.quote,
        verbatim: true,
        falsifiableCondition,
        conditionAuthor: 'consumer_proposed',
        hedgeLevel: hedgeLevelForConfidence(signal.confidence),
        claimSourceRef: sourceRef,
        claimMadeAt: video.publishedAt,
        statedHorizon: `${signal.horizonDays} days`,
        resolveBy,
        tickers: [signal.ticker],
      },
      'mcp',
    );

    const saved = await this.entityService.upsert<$.AlpacaSignal>(
      entity_alpaca_signal.new({
        owner_id: userId,
        header: {
          owner_user_id: userId,
          environment,
          channel_id: channel.body.channelId,
          video_id: video.videoId,
          ticker: signal.ticker,
          signal_status: 'open',
        },
        body: {
          environment,
          channelEntityId: channel.id,
          channelId: channel.body.channelId,
          channelTitle: channel.body.title,
          videoId: video.videoId,
          videoTitle: video.title,
          publishedAt: video.publishedAt,
          ticker: signal.ticker,
          direction: signal.direction,
          thesis: signal.thesis,
          horizonDays: signal.horizonDays,
          confidence: signal.confidence,
          quote: signal.quote,
          timestampSec: signal.timestampSec,
          sourceRef,
          referencePrice,
          falsifiableCondition,
          resolveBy,
          predictionId: prediction.id,
          status: 'open',
          actedActionId: null,
          extractedAt: now.toISOString(),
          provider: params.provider,
          model: params.model,
        },
      }),
    );
    return saved;
  }

  private async findSignal(userId: string, videoId: string, ticker: string) {
    const found = await this.entityService.findMany<$.AlpacaSignal>({
      where: { type: 'alpaca_signal', owner_id: userId, status: 'active' },
    });
    return (found as Required<$.AlpacaSignal>[]).find(
      (signal) => signal.body.videoId === videoId && signal.body.ticker === ticker,
    );
  }

  /**
   * The creator's ledger identity: one `tracked_manager` source portfolio per channel, found by name so a
   * re-run reuses it. The book is empty on purpose — what is tracked here is what the creator *claims*,
   * not what he holds, and inventing holdings from a video would be exactly the fabrication the ledger
   * exists to prevent.
   */
  private async ensureChannelSource(userId: string, channel: Required<$.AlpacaChannel>): Promise<string> {
    const name = channelSourceName(channel.body.title);
    const existing = await this.sourcePortfolios.listSourcePortfolios(userId, 'tracked_manager');
    const found = existing.find((source) => source.body.name === name);
    if (found) return found.id;

    const created = await this.sourcePortfolios.upsertSourcePortfolio(
      userId,
      {
        name,
        kind: 'tracked_manager',
        holdings: [],
        asOf: new Date().toISOString(),
        source: channel.body.url,
        metadata: { youtubeChannelId: channel.body.channelId, followedChannelId: channel.id },
      },
      'mcp',
    );
    this.logger.log(`Created ledger source “${name}” (${created.id}) for channel ${channel.body.channelId}.`);
    return created.id;
  }

  /**
   * The last printed trade for the ticker, memoized for the run. A price we cannot get is reported as
   * `null` and the condition anchors on the publish-day close instead — never on a guess.
   */
  private async referencePrice(
    userId: string,
    environment: AlpacaEnvironment,
    ticker: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    const cached = cache.get(ticker);
    if (cached !== undefined) return cached;

    let price: number | null = null;
    try {
      const client = await this.lifecycle.createEnvironmentClient(userId, environment);
      const trade = await client.getLatestTrade(ticker);
      price = trade && Number.isFinite(trade.price) && trade.price > 0 ? trade.price : null;
    } catch (error) {
      this.logger.warn(`Could not price ${ticker} for a signal: ${error instanceof Error ? error.message : error}`);
    }
    cache.set(ticker, price);
    return price;
  }
}

/** A creator's ledger identity is his channel, named so it is unmistakable next to a 13F filer. */
export function channelSourceName(channelTitle: string): string {
  return `${channelTitle} (YouTube)`;
}

const EXTRACTOR_FRAMING =
  'You read one video transcript and report only what its speaker actually claimed. You are an extractor, ' +
  'not an analyst: you never add a view of your own, never repair a weak argument, and never report a call ' +
  'the speaker did not make. Reporting nothing is a correct answer.';

const EXTRACTOR_SOUL =
  'You extract falsifiable investment calls from the transcript of a retail-investing video. You are ' +
  'sceptical by default: most of any such video is narration, disclosure, sponsorship and recap, and none ' +
  'of that is a call. You quote the speaker exactly, because a quote you altered is a claim you invented.';

const EXTRACTOR_TASK = [
  'Extract the falsifiable calls this speaker makes about specific, publicly traded tickers.',
  '',
  'A CALL is: the speaker states a forward-looking view on a named ticker AND gives a reason.',
  'NOT a call: news narration; recapping past performance; describing what someone else thinks; a general',
  'market mood with no ticker; disclosing a position without a forward view; "do your own research".',
  '',
  'For every call, report:',
  '  ticker        — the exchange symbol only, uppercase (AAPL, not "Apple").',
  '  direction     — "bullish", "bearish" or "neutral".',
  "  thesis        — the speaker's reason, in your words, one sentence, under 200 characters.",
  `  horizonDays   — the timeframe implied by the speaker, an integer between ${MIN_HORIZON_DAYS} and ${MAX_HORIZON_DAYS}.`,
  '  confidence    — 0 to 1: how firmly the speaker stated it, NOT how much you agree.',
  `  quote         — the speaker's own words, copied CHARACTER FOR CHARACTER from the transcript above,`,
  `                  between ${MIN_QUOTE_CHARS} and ${MAX_QUOTE_CHARS} characters, containing the call itself.`,
  '',
  'The quote is checked against the transcript. Do not paraphrase it, fix its grammar, join two separate',
  'sentences, or add ellipses — an altered quote is discarded and the call is lost.',
  '',
  `Report at most ${MAX_SIGNALS_PER_VIDEO} calls, the most clearly stated ones first.`,
  'Reply with ONLY JSON: {"signals":[{"ticker":"","direction":"","thesis":"","horizonDays":0,"confidence":0,"quote":""}]}',
  'If the speaker makes no calls at all, reply {"signals":[]} — that is a correct and expected answer.',
].join('\n');
