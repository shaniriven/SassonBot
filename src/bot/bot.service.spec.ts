import { Match } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { FootballService } from '../football/football.service';
import type { AlbumItem } from '../common/interfaces/channel-adapter.interface';
import type { PostService } from '../post/post.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { MatchPickerService } from './match-picker.service';
import { BotService } from './bot.service';
import type { TelegramAdapter } from './telegram.adapter';

function makeMatch(id: string): Match {
  return {
    id,
    apiId: Number(id.replace(/\D/g, '') || 1),
    homeTeam: `Home ${id}`,
    awayTeam: `Away ${id}`,
    homeLogo: null,
    awayLogo: null,
    league: 'Premier League',
    kickoffTime: new Date('2026-05-10T18:00:00.000Z'),
    matchDate: '2026-05-10',
    status: 'NS',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  };
}

describe('BotService album delivery', () => {
  it('passes a headliner only for days that define one', async () => {
    type DeliverAlbum = (
      favoritesByDate: {
        date: string;
        matches: Match[];
        strongDay: boolean;
        reason?: string;
        headlinerId?: string;
      }[],
      sendText: (msg: string) => Promise<void>,
      sendAlbum: (items: AlbumItem[]) => Promise<unknown>,
      strongDayLabel?: string,
    ) => Promise<void>;

    const generatePosterBuffer = jest
      .fn<Promise<Buffer>, [matches: Match[], headlinerId?: string]>()
      .mockResolvedValueOnce(Buffer.from('day-one'))
      .mockResolvedValueOnce(Buffer.from('day-two'));
    const post: Pick<PostService, 'generatePosterBuffer'> = {
      generatePosterBuffer,
    };
    const service = new BotService(
      {} as unknown as TelegramAdapter,
      {} as unknown as PrismaService,
      {} as unknown as FootballService,
      {} as unknown as RedisService,
      {} as unknown as ConfigService,
      post as unknown as PostService,
      {} as unknown as MatchPickerService,
    );
    const sendText = jest
      .fn<Promise<void>, [msg: string]>()
      .mockResolvedValue(undefined);
    const sentAlbum = { items: undefined as AlbumItem[] | undefined };
    const sendAlbum = jest
      .fn<Promise<unknown>, [items: AlbumItem[]]>()
      .mockImplementation((items: AlbumItem[]) => {
        sentAlbum.items = items;
        return Promise.resolve(undefined);
      });
    const dayOneMatches = [makeMatch('m1')];
    const dayTwoMatches = [makeMatch('m2'), makeMatch('m3')];

    await (service as unknown as { deliverAlbum: DeliverAlbum }).deliverAlbum(
      [
        {
          date: '2026-05-10',
          matches: dayOneMatches,
          strongDay: false,
        },
        {
          date: '2026-05-11',
          matches: dayTwoMatches,
          strongDay: false,
          headlinerId: 'm2',
        },
      ],
      sendText,
      sendAlbum,
    );

    expect(generatePosterBuffer).toHaveBeenNthCalledWith(
      1,
      dayOneMatches,
      undefined,
    );
    expect(generatePosterBuffer).toHaveBeenNthCalledWith(
      2,
      dayTwoMatches,
      'm2',
    );
    const sentItems = sentAlbum.items;
    expect(sentItems).toBeDefined();
    if (!sentItems) throw new Error('Expected album items to be sent');
    expect(sentItems[0].source).toEqual(Buffer.from('day-one'));
    expect(typeof sentItems[0].caption).toBe('string');
    expect(sentItems[1].source).toEqual(Buffer.from('day-two'));
    expect(typeof sentItems[1].caption).toBe('string');
  });
});
