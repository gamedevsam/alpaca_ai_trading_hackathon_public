// Transcript sourcing for the desk's signal edge (H13) — how a followed YouTube channel turns into
// video metadata and a transcript the extractor can read.
//
// Two implementations behind one interface, per plan §2 H13:
//   - `SupadataClient`  — the real thing. Thin typed HTTP over api.supadata.ai; the three endpoints it
//     uses were proven against the live API before this shipped (and are the same ones
//     `src/shared/data/joseph_carlson/fetch.mjs` has used for the SOUL pipeline).
//   - `LocalTranscriptSource` — the 921 cached Joseph Carlson transcripts on disk, so extraction can be
//     developed and TESTED without spending Supadata credits or needing the network. Tests only.
//
// **Transcripts are never persisted.** A transcript is fetched, read once by the extractor, and dropped;
// the provenance that survives is the `videoId` plus the timestamp of the quote (H14).

import axios, { AxiosInstance } from 'axios';
import { Logger } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SUPADATA_BASE_URL = 'https://api.supadata.ai/v1';
const SUPADATA_REQUEST_TIMEOUT_MS = 30_000;

/** A resolved YouTube channel — the stable id plus its display name. */
export interface TranscriptChannel {
  channelId: string;
  title: string;
  url: string;
}

/** One video on a followed channel, as the desk stores it. */
export interface TranscriptVideo {
  videoId: string;
  title: string;
  publishedAt: string | null;
  durationSec: number | null;
}

/** One caption cue. `offsetSec` is where the cue starts, which is what a quote's `t=` link needs. */
export interface TranscriptSegment {
  text: string;
  offsetSec: number;
}

/** A whole transcript, in memory only. */
export interface VideoTranscript {
  videoId: string;
  lang: string;
  /** The full transcript as one string — what a verbatim-quote check is run against. */
  text: string;
  segments: TranscriptSegment[];
}

export interface TranscriptSource {
  readonly kind: 'supadata' | 'local';
  /** Resolve a channel URL (or bare channel id) to its stable id + title. */
  resolveChannel(urlOrId: string): Promise<TranscriptChannel>;
  /** The channel's most recent `limit` regular videos, newest first. Shorts and livestreams excluded. */
  listVideos(channelId: string, limit: number): Promise<string[]>;
  /** Metadata for one video. */
  getVideo(videoId: string): Promise<TranscriptVideo | null>;
  /** The video's transcript, or `null` when none is available right now. */
  fetchTranscript(videoId: string): Promise<VideoTranscript | null>;
}

/** Thrown when a channel URL resolves to nothing — a clean 400 for the caller, not a 500. */
export class TranscriptSourceError extends Error {}

// ---------------------------------------------------------------------------------------------
// Supadata
// ---------------------------------------------------------------------------------------------

interface SupadataChannelResponse {
  id?: string;
  name?: string;
}

interface SupadataChannelVideosResponse {
  videoIds?: string[];
}

interface SupadataVideoResponse {
  id?: string;
  title?: string;
  uploadDate?: string;
  duration?: number | string;
}

interface SupadataTranscriptResponse {
  lang?: string;
  content?: Array<{ text?: string; offset?: number }>;
  // Long videos with no published captions are transcribed asynchronously and answer with a job id
  // instead of content. We do not wait: see `fetchTranscript`.
  jobId?: string;
}

export class SupadataClient implements TranscriptSource {
  readonly kind = 'supadata' as const;
  private readonly logger = new Logger(SupadataClient.name);
  private readonly http: AxiosInstance;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new TranscriptSourceError('SUPADATA_API_KEY is not configured — cannot reach Supadata.');
    }
    this.http = axios.create({
      baseURL: SUPADATA_BASE_URL,
      timeout: SUPADATA_REQUEST_TIMEOUT_MS,
      headers: { 'x-api-key': apiKey },
    });
  }

  async resolveChannel(urlOrId: string): Promise<TranscriptChannel> {
    const { data } = await this.http.get<SupadataChannelResponse>('/youtube/channel', {
      params: { id: urlOrId },
    });
    if (!data?.id) {
      throw new TranscriptSourceError(`Supadata could not resolve a YouTube channel from "${urlOrId}".`);
    }
    return { channelId: data.id, title: data.name?.trim() || data.id, url: canonicalChannelUrl(urlOrId, data.id) };
  }

  async listVideos(channelId: string, limit: number): Promise<string[]> {
    // `type=video` deliberately excludes shorts and livestreams — a 45-second short carries no thesis,
    // and a 3-hour stream would burn the transcription budget for one throwaway signal.
    const { data } = await this.http.get<SupadataChannelVideosResponse>('/youtube/channel/videos', {
      params: { id: channelId, type: 'video', limit },
    });
    return (data?.videoIds ?? []).slice(0, limit);
  }

  async getVideo(videoId: string): Promise<TranscriptVideo | null> {
    const { data } = await this.http.get<SupadataVideoResponse>('/youtube/video', { params: { id: videoId } });
    if (!data?.id) return null;
    const durationSec = Number(data.duration);
    return {
      videoId: data.id,
      title: data.title?.trim() ?? '',
      publishedAt: data.uploadDate ?? null,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
    };
  }

  async fetchTranscript(videoId: string): Promise<VideoTranscript | null> {
    const { data } = await this.http.get<SupadataTranscriptResponse>('/youtube/transcript', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}` },
    });
    if (!data?.content?.length) {
      // Deliberately not polled. When a video has no published captions Supadata queues a transcription
      // job that can take minutes, and a trade cycle must not block on one — the video simply has no
      // transcript *this* refresh and is picked up on a later one, with the reason said out loud rather
      // than silently reading as "this video contained no calls".
      this.logger.warn(
        `No transcript content for ${videoId}` + (data?.jobId ? ` (Supadata deferred it as job ${data.jobId})` : ''),
      );
      return null;
    }
    return buildTranscript(
      videoId,
      data.lang ?? 'en',
      data.content.map((cue) => ({
        text: cue.text ?? '',
        // Supadata reports cue offsets in milliseconds.
        offsetSec: Math.max(0, Math.round((cue.offset ?? 0) / 1000)),
      })),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Local (tests / offline development)
// ---------------------------------------------------------------------------------------------

interface LocalManifestRow {
  videoId: string;
  channel: string;
  title: string;
  uploadDate: string;
  durationSec: number | null;
}

/**
 * The same interface over the cached transcript corpus committed in
 * `src/shared/data/joseph_carlson/` (`videos.json` + `transcripts/<videoId>.txt`).
 *
 * Test-only by design: it is never constructed by the running server, so the deploy image does not need
 * the corpus. The corpus has no cue timings, so every segment reports `offsetSec: 0` — a quote extracted
 * from it is still verbatim-checkable, which is what the extraction tests are about.
 *
 * `listVideos` returns only videos whose transcript is actually on disk. The manifest lists every video the
 * channel ever published, most of them deliberately never transcribed, so listing by manifest alone would
 * hand a caller ids that always answer `null` — the local source would then behave nothing like the real one.
 */
export class LocalTranscriptSource implements TranscriptSource {
  readonly kind = 'local' as const;
  private manifest: LocalManifestRow[] | null = null;
  private transcribed: Set<string> | null = null;

  constructor(private readonly root: string) {}

  async resolveChannel(urlOrId: string): Promise<TranscriptChannel> {
    const handle = channelHandle(urlOrId);
    const rows = await this.rows();
    const match = rows.find((row) => row.channel.toLowerCase() === handle.toLowerCase());
    if (!match) {
      throw new TranscriptSourceError(`No cached transcripts for "${urlOrId}".`);
    }
    return { channelId: match.channel, title: match.channel, url: `https://www.youtube.com/@${match.channel}` };
  }

  async listVideos(channelId: string, limit: number): Promise<string[]> {
    const [rows, transcribed] = await Promise.all([this.rows(), this.transcriptIds()]);
    return rows
      .filter((row) => row.channel === channelId && transcribed.has(row.videoId))
      .sort((a, b) => (b.uploadDate || '').localeCompare(a.uploadDate || ''))
      .slice(0, limit)
      .map((row) => row.videoId);
  }

  async getVideo(videoId: string): Promise<TranscriptVideo | null> {
    const row = (await this.rows()).find((candidate) => candidate.videoId === videoId);
    if (!row) return null;
    return {
      videoId: row.videoId,
      title: row.title,
      publishedAt: row.uploadDate || null,
      durationSec: row.durationSec ?? null,
    };
  }

  async fetchTranscript(videoId: string): Promise<VideoTranscript | null> {
    try {
      const text = await readFile(join(this.root, 'transcripts', `${videoId}.txt`), 'utf8');
      return buildTranscript(videoId, 'en', [{ text, offsetSec: 0 }]);
    } catch {
      return null;
    }
  }

  private async transcriptIds(): Promise<Set<string>> {
    if (!this.transcribed) {
      const files = await readdir(join(this.root, 'transcripts'));
      this.transcribed = new Set(files.filter((file) => file.endsWith('.txt')).map((file) => file.slice(0, -4)));
    }
    return this.transcribed;
  }

  private async rows(): Promise<LocalManifestRow[]> {
    if (!this.manifest) {
      this.manifest = JSON.parse(await readFile(join(this.root, 'videos.json'), 'utf8')) as LocalManifestRow[];
    }
    return this.manifest;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function buildTranscript(videoId: string, lang: string, segments: TranscriptSegment[]): VideoTranscript {
  const kept = segments.filter((segment) => segment.text.trim().length > 0);
  return { videoId, lang, text: kept.map((segment) => segment.text.trim()).join(' '), segments: kept };
}

/** `https://www.youtube.com/@handle` → `handle`; anything else is returned unchanged. */
function channelHandle(urlOrId: string): string {
  return urlOrId
    .trim()
    .replace(/^https?:\/\/(www\.)?youtube\.com\/@?/i, '')
    .replace(/\/.*$/, '');
}

/** Keep the owner's own URL when he gave one; fall back to the canonical channel-id URL. */
function canonicalChannelUrl(urlOrId: string, channelId: string): string {
  return /^https?:\/\//i.test(urlOrId.trim()) ? urlOrId.trim() : `https://www.youtube.com/channel/${channelId}`;
}
