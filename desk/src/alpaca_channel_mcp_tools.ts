/**
 * H13 — the followed-channel tools on the portfolio-manager MCP surface.
 *
 * These exist because following a creator is *data intake*, and intake is the MCP surface's job by charter
 * ("MCP is the primary input surface", root `AGENTS.md`): the owner says "follow Daniel Pronk" to an AI and
 * it is done. There is deliberately **no UI** for it — a form that takes one YouTube URL three times is not
 * a thing worth building, and the plan's two-screen budget is spent on the judge-facing views.
 *
 * Registered from this file, in the Alpaca module rather than beside the MCP service, for the same reason
 * `manager_prediction_tools.ts` is its own file: the whole desk — including the tools that feed it — is one
 * removable unit, and `src/server/src/api/alpaca/**` is what the hackathon's public repo ships.
 *
 * Every tool is a thin caller over `AlpacaChannelService`: the cap, the dedupe, the refresh window and the
 * ownership check live there. Like every tool on this surface there is no `ownerId` argument — the caller
 * always acts as the authenticated user.
 */

import { HttpException } from '@nestjs/common';
import type { AjvMcpServer } from '~/api/admin/mcp/lib/@modelcontextprotocol/sdk/ajv_mcp_server';
import { resolveMcpTokenOwnerId } from '~/api/admin/mcp/mcp_owner_identity';
import type { AlpacaChannelService } from './alpaca_channel.service';
import { MAX_FOLLOWED_CHANNELS, VIDEOS_PER_REFRESH } from './alpaca_channel.service';

/** How many of a channel's remembered videos a payload shows — enough to see what is new, not an archive. */
const CHANNEL_VIDEO_PREVIEW = 5;

function buildChannelToolResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function buildChannelErrorResponse(error: unknown) {
  const status = error instanceof HttpException ? error.getStatus() : null;
  const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PARAMS' : 'INTERNAL_ERROR';
  return buildChannelErrorPayload(code, error instanceof Error ? error.message : String(error));
}

function buildChannelErrorPayload(code: string, message: string) {
  return buildChannelToolResponse({ error: { code, message } });
}

function compactChannel(channel: Required<$.AlpacaChannel>) {
  const videos = channel.body.videos;
  return {
    id: channel.id,
    channelId: channel.body.channelId,
    title: channel.body.title,
    url: channel.body.url,
    lastRefreshedAt: channel.body.lastRefreshedAt,
    videoCount: videos.length,
    // `extracted` is the honesty field: false means nothing has read this video for signals yet, so its
    // absence from the signal list says nothing about whether the creator made a call in it.
    recentVideos: videos.slice(0, CHANNEL_VIDEO_PREVIEW).map((video) => ({
      videoId: video.videoId,
      title: video.title,
      publishedAt: video.publishedAt,
      extracted: Boolean(video.extractedAt),
    })),
  };
}

export function registerChannelTools(mcp: AjvMcpServer, channels: AlpacaChannelService) {
  mcp.tool(
    'follow_channel',
    `Follow a YouTube channel so the desk reads what its creator says. Takes the channel URL (or a bare channel id), resolves it, remembers it, and immediately records its ${VIDEOS_PER_REFRESH} most recent videos. Following is capped at ${MAX_FOLLOWED_CHANNELS} channels — a followed channel costs API credits on every refresh — and is idempotent: following one already followed returns it unchanged rather than duplicating it. This records WHERE to listen; it forms no opinion, acts on nothing, and places no order. Transcripts are never stored — only the video id and the timestamp of anything quoted from it.`,
    {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'YouTube channel URL (e.g. https://www.youtube.com/@danielpronk) or a bare UC… channel id.',
        },
      },
      additionalProperties: false,
    },
    async (args: { url: string }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const channel = await channels.followChannel(ownerId, args.url);
        return buildChannelToolResponse({ channel: compactChannel(channel) });
      } catch (error) {
        return buildChannelErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'list_channels',
    `List the YouTube channels you follow, oldest-followed first, with each one's most recent videos and when it was last refreshed. \`extracted: false\` on a video means no signal extraction has read it yet — so nothing has been concluded about it either way. Read-only.`,
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args: Record<string, never>, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const followed = await channels.listChannels(ownerId);
        return buildChannelToolResponse({
          count: followed.length,
          remaining: Math.max(0, MAX_FOLLOWED_CHANNELS - followed.length),
          channels: followed.map(compactChannel),
        });
      } catch (error) {
        return buildChannelErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'unfollow_channel',
    "Stop following a channel, freeing one of the three slots. A soft archive: signals already extracted from its videos keep their provenance and stay on the prediction ledger, so the creator's track record survives being unfollowed. Confirm with the operator before calling — which voices he listens to is his judgment, not yours.",
    {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Channel id from list_channels (ACH…).' } },
      additionalProperties: false,
    },
    async (args: { id: string }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const channel = await channels.unfollowChannel(ownerId, args.id);
        return buildChannelToolResponse({ unfollowed: { id: channel.id, title: channel.body.title } });
      } catch (error) {
        return buildChannelErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'refresh_channels',
    `Check every followed channel for videos published since the last refresh and record the new ones. Reports per channel, so one creator's outage does not hide the other two — a channel that failed carries its \`error\` and an empty \`newVideos\`, which is NOT the same as "nothing new". Records what is new; reads no transcript and forms no opinion.`,
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args: Record<string, never>, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        return buildChannelToolResponse(await channels.refreshChannels(ownerId));
      } catch (error) {
        return buildChannelErrorResponse(error);
      }
    },
  );
}
