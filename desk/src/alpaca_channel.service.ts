import { entity_alpaca_channel } from '#schema_registry';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityService } from '~/entity/entity.service';
import { SUPADATA_API_KEY } from '~/server_config';
import { AlpacaEnvironment } from './alpaca.types';
import { SupadataClient, TranscriptSource, TranscriptSourceError } from './transcript_source';

/**
 * Followed YouTube channels (H13) — the intake half of the desk's signal edge.
 *
 * The owner tells an AI "follow this channel"; this service resolves it, remembers it, and keeps a small
 * window of its most recent videos so H14's extractor knows what is new. It is deliberately *only* the
 * intake: nothing here reads a transcript, forms an opinion, or touches the broker.
 *
 * Three deliberate limits, all of them because this spends real API credits on someone else's content:
 *   - **Cap 3 channels per user per environment.** A followed channel is a standing cost on every
 *     refresh, and the hackathon desk follows exactly three (plan §0b).
 *   - **A refresh window, not an archive.** Only the most recent `VIDEOS_PER_REFRESH` videos are looked
 *     at, and only `MAX_STORED_VIDEOS` are remembered — the desk trades on what a creator said this
 *     week, not in 2019.
 *   - **Transcripts are never persisted.** They are not even fetched here; provenance is the `videoId`.
 */

/** How many channels one user may follow per environment (plan §2 H13). */
export const MAX_FOLLOWED_CHANNELS = 3;
/** How many of a channel's newest videos a refresh looks at. */
export const VIDEOS_PER_REFRESH = 5;
/** How many videos are remembered per channel — the window the extractor scans, oldest dropped. */
export const MAX_STORED_VIDEOS = 25;

export interface RefreshChannelsResult {
  channels: Array<{ id: string; channelId: string; title: string; newVideos: string[]; error: string | null }>;
  newVideoCount: number;
}

@Injectable()
export class AlpacaChannelService {
  private readonly logger = new Logger(AlpacaChannelService.name);

  constructor(private readonly entityService: EntityService) {}

  /**
   * The transcript backend. Overridden in tests with `LocalTranscriptSource` over the cached corpus so
   * nothing here needs the network or a Supadata credit; production always talks to Supadata.
   */
  protected transcriptSource(): TranscriptSource {
    return new SupadataClient(SUPADATA_API_KEY);
  }

  /** The channels this user follows, newest-followed last. */
  async listChannels(userId: string, environment: AlpacaEnvironment = 'paper') {
    const channels = await this.entityService.findMany<$.AlpacaChannel>({
      where: { type: 'alpaca_channel', owner_id: userId, status: 'active' },
    });
    return (channels as Array<Required<$.AlpacaChannel>>)
      .filter((channel) => channel.body.environment === environment)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }

  /**
   * Follow a channel by URL or channel id. Idempotent: following one already followed returns it
   * unchanged rather than erroring or duplicating, so a retry after a timeout is safe.
   */
  async followChannel(
    userId: string,
    url: string,
    environment: AlpacaEnvironment = 'paper',
  ): Promise<Required<$.AlpacaChannel>> {
    const target = url?.trim();
    if (!target) {
      throw new BadRequestException('url is required — a YouTube channel URL or channel id.');
    }

    const source = this.buildSource();
    const resolved = await this.resolve(source, target);

    const followed = await this.listChannels(userId, environment);
    const existing = followed.find((channel) => channel.body.channelId === resolved.channelId);
    if (existing) return existing;

    // Checked AFTER the dedupe above so re-following the third channel isn't rejected as a fourth.
    if (followed.length >= MAX_FOLLOWED_CHANNELS) {
      throw new BadRequestException(
        `You already follow ${followed.length} channels (the cap is ${MAX_FOLLOWED_CHANNELS}). ` +
          `Unfollow one first: ${followed.map((channel) => `${channel.body.title} (${channel.id})`).join(', ')}.`,
      );
    }

    const saved = await this.entityService.upsert<$.AlpacaChannel>(
      entity_alpaca_channel.new({
        owner_id: userId,
        header: { owner_user_id: userId, environment, status: 'active', channel_id: resolved.channelId },
        body: {
          environment,
          url: resolved.url,
          channelId: resolved.channelId,
          title: resolved.title,
          videos: [],
          lastRefreshedAt: null,
        },
      }),
    );
    this.logger.log(`Following YouTube channel ${resolved.title} (${resolved.channelId}) for ${userId}.`);

    // First refresh inline: a channel followed but empty until some later cycle looks like a broken tool.
    const refreshed = await this.refreshOne(source, saved);
    return refreshed.channel;
  }

  /** Stop following a channel. A soft archive — the videos already extracted keep their provenance. */
  async unfollowChannel(userId: string, id: string): Promise<Required<$.AlpacaChannel>> {
    const channel = await this.entityService.findById<$.AlpacaChannel>(id);
    if (!channel || channel.owner_id !== userId || channel.type !== 'alpaca_channel' || channel.status !== 'active') {
      throw new NotFoundException(`Channel ${id} not found.`);
    }
    const archived = await this.entityService.archive<$.AlpacaChannel>(channel);
    this.logger.log(`Unfollowed YouTube channel ${channel.body.title} (${channel.body.channelId}) for ${userId}.`);
    return archived;
  }

  /**
   * Pull each followed channel's newest videos and record the ones we haven't seen. Reports per channel
   * rather than throwing on the first failure — one creator's outage must not stop the other two.
   */
  async refreshChannels(userId: string, environment: AlpacaEnvironment = 'paper'): Promise<RefreshChannelsResult> {
    const followed = await this.listChannels(userId, environment);
    if (followed.length === 0) {
      return { channels: [], newVideoCount: 0 };
    }

    const source = this.buildSource();
    const results: RefreshChannelsResult['channels'] = [];
    for (const channel of followed) {
      try {
        const { channel: updated, newVideos } = await this.refreshOne(source, channel);
        results.push({
          id: updated.id,
          channelId: updated.body.channelId,
          title: updated.body.title,
          newVideos,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Refresh failed for channel ${channel.body.title} (${channel.id}): ${message}`);
        results.push({
          id: channel.id,
          channelId: channel.body.channelId,
          title: channel.body.title,
          newVideos: [],
          error: message,
        });
      }
    }
    return { channels: results, newVideoCount: results.reduce((sum, row) => sum + row.newVideos.length, 0) };
  }

  /**
   * Mark one video as read for signals (H14). The hand-off between intake and extraction: a null
   * `extractedAt` means nothing has looked at that video yet, which is emphatically NOT the same as
   * "the creator made no calls in it" — so this is set only after a transcript was really read.
   */
  async markVideoExtracted(userId: string, channelEntityId: string, videoId: string): Promise<void> {
    const channel = await this.entityService.findById<$.AlpacaChannel>(channelEntityId);
    if (!channel || channel.owner_id !== userId || channel.type !== 'alpaca_channel' || channel.status !== 'active') {
      throw new NotFoundException(`Channel ${channelEntityId} not found.`);
    }
    const at = new Date().toISOString();
    await this.entityService.update<$.AlpacaChannel>(channel as Required<$.AlpacaChannel>, (draft) => {
      for (const video of draft.body.videos) {
        if (video.videoId === videoId) video.extractedAt = at;
      }
    });
  }

  /** One channel's refresh: newest ids → metadata for the unseen ones → merged window. */
  private async refreshOne(source: TranscriptSource, channel: Required<$.AlpacaChannel>) {
    const videoIds = await source.listVideos(channel.body.channelId, VIDEOS_PER_REFRESH);
    const known = new Set(channel.body.videos.map((video) => video.videoId));
    const newVideos: $.AlpacaChannel['body']['videos'] = [];
    for (const videoId of videoIds) {
      if (known.has(videoId)) continue;
      // Metadata is fetched only for videos we have never seen — the expensive call, once per video ever.
      const video = await source.getVideo(videoId);
      if (!video) continue;
      newVideos.push({
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt,
        durationSec: video.durationSec,
        // Set by H14 once this video's transcript has been read for signals.
        extractedAt: null,
      });
    }

    const updated = await this.entityService.update<$.AlpacaChannel>(channel, (draft) => {
      draft.body.videos = [...newVideos, ...draft.body.videos]
        .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
        .slice(0, MAX_STORED_VIDEOS);
      draft.body.lastRefreshedAt = new Date().toISOString();
    });
    if (newVideos.length) {
      this.logger.log(
        `${channel.body.title}: ${newVideos.length} new video(s) — ${newVideos.map((v) => v.videoId).join(', ')}.`,
      );
    }
    return { channel: updated, newVideos: newVideos.map((video) => video.videoId) };
  }

  /** A missing key is a configuration problem, and the caller deserves to be told that in those words. */
  private buildSource(): TranscriptSource {
    try {
      return this.transcriptSource();
    } catch (error) {
      if (error instanceof TranscriptSourceError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async resolve(source: TranscriptSource, target: string) {
    try {
      return await source.resolveChannel(target);
    } catch (error) {
      if (error instanceof TranscriptSourceError) throw new BadRequestException(error.message);
      throw new BadRequestException(
        `Could not resolve "${target}" as a YouTube channel: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
