import { entity_alpaca_channel } from '#schema_registry';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { dirname, join } from 'node:path';
import { EntityService } from '~/entity/entity.service';
import { CUSTOM_SCHEMA_KEYWORDS } from '~/api/admin/schema/lib/ajv';
import {
  AlpacaChannelService,
  MAX_FOLLOWED_CHANNELS,
  MAX_STORED_VIDEOS,
  VIDEOS_PER_REFRESH,
} from '../alpaca_channel.service';
import { LocalTranscriptSource, TranscriptSource, TranscriptVideo } from '../transcript_source';

// The committed Joseph Carlson corpus: `videos.json` + 921 `transcripts/<videoId>.txt`. Tests read it
// through `LocalTranscriptSource` so nothing here needs the network or a Supadata credit.
const CARLSON_CORPUS = join(dirname(__dirname), '../../../../shared/data/joseph_carlson');

function compileValidator(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv, ['date-time']);
  for (const keyword of CUSTOM_SCHEMA_KEYWORDS) {
    ajv.addKeyword(keyword);
  }
  return ajv.compile(schema);
}

const validateChannel = compileValidator(entity_alpaca_channel as object);

/** Asserts against the generated registry schema, reporting WHY rather than just `false`. */
function expectValidChannel(entity: unknown) {
  validateChannel(entity);
  expect(validateChannel.errors ?? []).toEqual([]);
}

/** A scripted transcript source — the channel/video shapes the service reads, none of the network. */
function fakeSource(overrides: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    kind: 'local',
    resolveChannel: jest.fn(async (urlOrId: string) => ({
      channelId: 'UC_pronk',
      title: 'Daniel Pronk',
      url: urlOrId,
    })),
    listVideos: jest.fn(async () => ['vid_3', 'vid_2', 'vid_1']),
    getVideo: jest.fn(async (videoId: string): Promise<TranscriptVideo> => ({
      videoId,
      title: `Video ${videoId}`,
      publishedAt: `2026-09-0${videoId.slice(-1)}T00:00:00.000Z`,
      durationSec: 900,
    })),
    fetchTranscript: jest.fn(async () => null),
    ...overrides,
  };
}

/** In-memory EntityService covering exactly what the channel service calls. */
function makeEntityService(seed: Array<Record<string, any>> = []) {
  const store = new Map<string, any>(seed.map((entity) => [entity.id, structuredClone(entity)]));
  let counter = 0;

  const entityService = {
    findMany: jest.fn(async ({ where }: any) =>
      [...store.values()].filter((entity) =>
        Object.entries(where ?? {}).every(([key, value]) => entity[key] === value),
      ),
    ),
    findById: jest.fn(async (id: string) => store.get(id) ?? null),
    upsert: jest.fn(async (entity: any) => {
      const saved = {
        ...structuredClone(entity),
        id: entity.id ?? `ACH_generated000000${counter}yyyy`,
        created_at: new Date(Date.now() + counter).toISOString(),
      };
      store.set(saved.id, saved);
      return structuredClone(saved);
    }),
    update: jest.fn(async (entity: any, producer: (draft: any) => void) => {
      const draft = structuredClone(store.get(entity.id) ?? entity);
      producer(draft);
      store.set(draft.id, draft);
      return structuredClone(draft);
    }),
    archive: jest.fn(async (entity: any) => {
      const stored = store.get(entity.id) ?? entity;
      const archived = { ...structuredClone(stored), status: 'archived' };
      store.set(archived.id, archived);
      return archived;
    }),
  } as unknown as EntityService;

  return { entityService, store };
}

/** The service with its transcript backend swapped for a scripted one — production always uses Supadata. */
function makeService(source: TranscriptSource, seed: Array<Record<string, any>> = []) {
  const { entityService, store } = makeEntityService(seed);
  class TestChannelService extends AlpacaChannelService {
    protected transcriptSource(): TranscriptSource {
      return source;
    }
  }
  return { service: new TestChannelService(entityService), entityService, store };
}

function seedChannel(id: string, channelId: string, videos: any[] = [], owner = 'USR_hackathonowner0001ab') {
  return {
    id,
    type: 'alpaca_channel',
    owner_id: owner,
    status: 'active',
    created_at: '2026-09-01T00:00:00.000Z',
    header: { owner_user_id: owner, environment: 'paper', status: 'active', channel_id: channelId },
    body: {
      environment: 'paper',
      url: `https://www.youtube.com/channel/${channelId}`,
      channelId,
      title: channelId,
      videos,
      lastRefreshedAt: null,
    },
  };
}

describe('AlpacaChannelService', () => {
  describe('followChannel', () => {
    it('persists a schema-valid channel and records its newest videos in the same call', async () => {
      const source = fakeSource();
      const { service, store } = makeService(source);

      const channel = await service.followChannel('USR_hackathonowner0001ab', 'https://www.youtube.com/@danielpronk');

      expectValidChannel(store.get(channel.id));
      expect(channel.body.channelId).toBe('UC_pronk');
      expect(channel.body.title).toBe('Daniel Pronk');
      // A channel that is followed but empty until some later cycle reads as a broken tool.
      expect(channel.body.videos.map((video) => video.videoId)).toEqual(['vid_3', 'vid_2', 'vid_1']);
      expect(channel.body.videos.every((video) => video.extractedAt === null)).toBe(true);
      expect(channel.body.lastRefreshedAt).not.toBeNull();
      expect(source.listVideos).toHaveBeenCalledWith('UC_pronk', VIDEOS_PER_REFRESH);
    });

    it('is idempotent — following a channel already followed returns it instead of duplicating it', async () => {
      const source = fakeSource();
      const { service, store } = makeService(source, [seedChannel('ACH_existing000000001abc', 'UC_pronk')]);

      const channel = await service.followChannel('USR_hackathonowner0001ab', 'https://www.youtube.com/@danielpronk');

      expect(channel.id).toBe('ACH_existing000000001abc');
      expect(store.size).toBe(1);
    });

    it(`refuses channel ${MAX_FOLLOWED_CHANNELS + 1} and names the ones already followed`, async () => {
      const seeded = Array.from({ length: MAX_FOLLOWED_CHANNELS }, (_, index) =>
        seedChannel(`ACH_channel0000000${index}xxxxxxxx`, `UC_${index}`),
      );
      const { service } = makeService(fakeSource(), seeded);

      await expect(
        service.followChannel('USR_hackathonowner0001ab', 'https://www.youtube.com/@danielpronk'),
      ).rejects.toThrow(/cap is 3/);
    });

    it('lets the owner re-follow his third channel — the dedupe runs before the cap', async () => {
      const seeded = [
        seedChannel('ACH_channel00000000zzzzz', 'UC_0'),
        seedChannel('ACH_channel00000001aaaaz', 'UC_1'),
        seedChannel('ACH_channel00000002bbbbz', 'UC_pronk'),
      ];
      const { service } = makeService(fakeSource(), seeded);

      await expect(
        service.followChannel('USR_hackathonowner0001ab', 'https://www.youtube.com/@danielpronk'),
      ).resolves.toMatchObject({
        id: 'ACH_channel00000002bbbbz',
      });
    });

    it('turns an unresolvable channel into a 400, not a 500', async () => {
      const source = fakeSource({
        resolveChannel: jest.fn(async () => {
          throw new Error('HTTP 404');
        }),
      });
      const { service } = makeService(source);

      await expect(service.followChannel('USR_hackathonowner0001ab', 'not-a-channel')).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('refreshChannels', () => {
    it('records only unseen videos and never re-fetches metadata for one it already has', async () => {
      const source = fakeSource();
      const seeded = [
        seedChannel('ACH_channel00000001aaaaz', 'UC_pronk', [
          {
            videoId: 'vid_2',
            title: 'Video vid_2',
            publishedAt: '2026-09-02T00:00:00.000Z',
            extractedAt: '2026-09-02T12:00:00.000Z',
          },
        ]),
      ];
      const { service, store } = makeService(source, seeded);

      const result = await service.refreshChannels('USR_hackathonowner0001ab');

      expect(result.newVideoCount).toBe(2);
      expect(result.channels[0].newVideos.sort()).toEqual(['vid_1', 'vid_3']);
      expect(source.getVideo).toHaveBeenCalledTimes(2);
      // The already-extracted video keeps its mark — a refresh must never make H14 read a video twice.
      const stored = store.get('ACH_channel00000001aaaaz');
      expect(stored.body.videos.find((video: any) => video.videoId === 'vid_2').extractedAt).toBe(
        '2026-09-02T12:00:00.000Z',
      );
      expect(stored.body.videos.map((video: any) => video.videoId)).toEqual(['vid_3', 'vid_2', 'vid_1']);
      expectValidChannel(stored);
    });

    it('keeps the window bounded at the newest videos', async () => {
      const older = Array.from({ length: MAX_STORED_VIDEOS }, (_, index) => ({
        videoId: `old_${index}`,
        title: `old ${index}`,
        publishedAt: `2020-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        extractedAt: null,
      }));
      const { service, store } = makeService(fakeSource(), [
        seedChannel('ACH_channel00000001aaaaz', 'UC_pronk', older),
      ]);

      await service.refreshChannels('USR_hackathonowner0001ab');

      const stored = store.get('ACH_channel00000001aaaaz');
      expect(stored.body.videos).toHaveLength(MAX_STORED_VIDEOS);
      expect(stored.body.videos.slice(0, 3).map((video: any) => video.videoId)).toEqual(['vid_3', 'vid_2', 'vid_1']);
    });

    it("reports one creator's outage per channel instead of aborting the other two", async () => {
      const source = fakeSource({
        listVideos: jest.fn(async (channelId: string) => {
          if (channelId === 'UC_broken') throw new Error('HTTP 503');
          return ['vid_1'];
        }),
      });
      const { service } = makeService(source, [
        seedChannel('ACH_channel00000001aaaaz', 'UC_broken'),
        seedChannel('ACH_channel00000002bbbbz', 'UC_fine'),
      ]);

      const result = await service.refreshChannels('USR_hackathonowner0001ab');

      expect(result.channels.map((channel) => [channel.channelId, channel.error])).toEqual([
        ['UC_broken', 'HTTP 503'],
        ['UC_fine', null],
      ]);
      expect(result.newVideoCount).toBe(1);
    });

    it('does not touch the transcript backend when nothing is followed', async () => {
      const source = fakeSource();
      const { service } = makeService(source);

      expect(await service.refreshChannels('USR_hackathonowner0001ab')).toEqual({ channels: [], newVideoCount: 0 });
      expect(source.listVideos).not.toHaveBeenCalled();
    });
  });

  describe('unfollowChannel', () => {
    it('archives the channel rather than deleting it', async () => {
      const { service, store } = makeService(fakeSource(), [seedChannel('ACH_channel00000001aaaaz', 'UC_pronk')]);

      await service.unfollowChannel('USR_hackathonowner0001ab', 'ACH_channel00000001aaaaz');

      expect(store.get('ACH_channel00000001aaaaz').status).toBe('archived');
      expect(await service.listChannels('USR_hackathonowner0001ab')).toEqual([]);
    });

    it("refuses another user's channel with a 404 rather than confirming it exists", async () => {
      const { service } = makeService(fakeSource(), [
        seedChannel('ACH_channel00000001aaaaz', 'UC_pronk', [], 'USR_someoneelse0002efghz'),
      ]);

      await expect(
        service.unfollowChannel('USR_hackathonowner0001ab', 'ACH_channel00000001aaaaz'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('LocalTranscriptSource (the cached corpus)', () => {
  const source = new LocalTranscriptSource(CARLSON_CORPUS);

  it('resolves the cached channel from its handle', async () => {
    await expect(source.resolveChannel('https://www.youtube.com/@JosephCarlsonShow')).resolves.toMatchObject({
      channelId: 'JosephCarlsonShow',
    });
  });

  it('lists only videos whose transcript is actually on disk, and reads them verbatim', async () => {
    const videoIds = await source.listVideos('JosephCarlsonShow', 3);
    expect(videoIds).toHaveLength(3);

    for (const videoId of videoIds) {
      const transcript = await source.fetchTranscript(videoId);
      expect(transcript).not.toBeNull();
      expect(transcript!.text.length).toBeGreaterThan(500);
      // The verbatim check H14 runs is a substring test against exactly this text.
      expect(transcript!.text).toContain(transcript!.segments[0].text.slice(0, 40));
    }
  });

  it('returns null for a video it has no transcript for', async () => {
    await expect(source.fetchTranscript('not_a_cached_video')).resolves.toBeNull();
  });
});
