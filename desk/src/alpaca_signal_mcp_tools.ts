/**
 * H14 — the signal-extraction tools on the portfolio-manager MCP surface.
 *
 * Same reasoning as `alpaca_channel_mcp_tools.ts`: reading what a creator said is *data intake*, and intake
 * is the MCP surface's job by charter. The owner says "read the new videos" to an AI and the desk's view of
 * what its creators are claiming is up to date, with every call landing on the prediction ledger so the
 * creator becomes gradable. No UI by design — the plan's two-screen budget is spent on the judge-facing
 * views, and `/desk` will read these signals rather than edit them.
 *
 * Registered from this file, in the Alpaca module, so the whole desk stays one removable directory.
 */

import { HttpException } from '@nestjs/common';
import type { AjvMcpServer } from '~/api/admin/mcp/lib/@modelcontextprotocol/sdk/ajv_mcp_server';
import { resolveMcpTokenOwnerId } from '~/api/admin/mcp/mcp_owner_identity';
import type { AlpacaSignalService } from './alpaca_signal.service';
import { MAX_VIDEOS_PER_EXTRACTION, SignalProviderUnavailableError } from './alpaca_signal.service';

/** How many signals one `list_signals` call returns by default. */
const SIGNAL_PAGE_SIZE = 25;

function buildSignalToolResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function buildSignalErrorResponse(error: unknown) {
  // A misconfigured provider is a configuration fault the caller must see as such — not a 500, and never
  // a quiet empty result (an unread video reported as "no calls" would libel the creator).
  if (error instanceof SignalProviderUnavailableError) {
    return buildSignalToolResponse({ error: { code: 'PROVIDER_UNAVAILABLE', message: error.message } });
  }
  const status = error instanceof HttpException ? error.getStatus() : null;
  const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PARAMS' : 'INTERNAL_ERROR';
  return buildSignalToolResponse({ error: { code, message: error instanceof Error ? error.message : String(error) } });
}

function compactSignal(signal: Required<$.AlpacaSignal>) {
  return {
    id: signal.id,
    status: signal.body.status,
    creator: signal.body.channelTitle,
    ticker: signal.body.ticker,
    direction: signal.body.direction,
    thesis: signal.body.thesis,
    quote: signal.body.quote,
    confidence: signal.body.confidence,
    horizonDays: signal.body.horizonDays,
    // The claim as it will be graded — the sentence a resolver checks against a price history.
    falsifiableCondition: signal.body.falsifiableCondition,
    resolveBy: signal.body.resolveBy,
    // The ledger record this signal became. Null would mean an ungraded opinion; it never is.
    predictionId: signal.body.predictionId,
    sourceRef: signal.body.sourceRef,
    video: { id: signal.body.videoId, title: signal.body.videoTitle, publishedAt: signal.body.publishedAt },
    // Honesty fields: WHICH model read the transcript, and what the claim is anchored to.
    extractedBy: { provider: signal.body.provider, model: signal.body.model, at: signal.body.extractedAt },
    referencePrice: signal.body.referencePrice,
    actedActionId: signal.body.actedActionId,
  };
}

export function registerSignalTools(mcp: AjvMcpServer, signals: AlpacaSignalService) {
  mcp.tool(
    'extract_signals',
    `Read the followed channels' unread videos and record the falsifiable calls their creators made. Per video: one pass over the transcript, then every call that survives validation is logged on the prediction ledger against a source portfolio for that creator — so the creator's track record accumulates and can be scored later. Reads up to ${MAX_VIDEOS_PER_EXTRACTION} videos per call, oldest first, and marks a video read ONLY if its transcript was really fetched; a video whose transcript is not published yet stays unread and is retried, because "not read yet" must never be recorded as "made no calls". A quote that is not verbatim in the transcript is DROPPED, not stored — the reply reports how many and why. Transcripts are never persisted. This records what the creator claimed; it forms no view of its own, acts on nothing, and places no order.`,
    {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_VIDEOS_PER_EXTRACTION * 4,
          description: `How many unread videos to read this call (default ${MAX_VIDEOS_PER_EXTRACTION}). Each one is a full transcript pass, so raise it deliberately.`,
        },
        channelId: {
          type: 'string',
          description: 'Restrict to one followed channel, by its ACH… id from list_channels. Omit for all of them.',
        },
      },
      additionalProperties: false,
    },
    async (args: { limit?: number; channelId?: string }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const result = await signals.extractSignals(ownerId, {
          limit: args.limit,
          channelEntityId: args.channelId,
        });
        return buildSignalToolResponse(result);
      } catch (error) {
        return buildSignalErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'list_signals',
    `List the calls extracted from the followed creators, newest first. \`open\` means nothing has acted on it, \`acted\` means a desk proposal cited it (\`actedActionId\` says which), \`resolved\` means its ledger claim has been graded. Every signal carries the creator's verbatim quote, a timestamped link to the moment he said it, and the \`predictionId\` of the falsifiable claim it became — read that claim's outcome through get_prediction / get_manager_scorecard rather than judging the creator from the quote alone. Read-only.`,
    {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'acted', 'resolved'],
          description: 'Narrow to one lifecycle state. Omit for all of them.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: `Default ${SIGNAL_PAGE_SIZE}.` },
      },
      additionalProperties: false,
    },
    async (args: { status?: $.AlpacaSignal['body']['status']; limit?: number }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const found = await signals.listSignals(ownerId, {
          status: args.status,
          limit: args.limit ?? SIGNAL_PAGE_SIZE,
        });
        return buildSignalToolResponse({ count: found.length, signals: found.map(compactSignal) });
      } catch (error) {
        return buildSignalErrorResponse(error);
      }
    },
  );
}
