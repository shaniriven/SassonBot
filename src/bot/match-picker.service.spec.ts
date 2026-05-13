import { MatchPickerService } from './match-picker.service';
import type { RedisService } from '../redis/redis.service';
import type { TelegramAdapter } from './telegram.adapter';
import {
  AlbumPickerDay,
  BOT_STATE_KEY,
  PICKER_NAV_PREFIX,
  PICKER_TOGGLE_PREFIX,
} from './bot.const';

class RedisMock {
  private readonly values = new Map<string, string>();

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  del(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  setNx(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return Promise.resolve(false);
    this.values.set(key, value);
    return Promise.resolve(true);
  }

  delIfValue(key: string, value: string): Promise<void> {
    if (this.values.get(key) === value) this.values.delete(key);
    return Promise.resolve();
  }
}

function makeChannelMock() {
  return {
    sendMessageWithInlineButtons: jest.fn().mockResolvedValue(42),
    editMessageWithButtons: jest.fn().mockResolvedValue(undefined),
    editMessageText: jest.fn().mockResolvedValue(undefined),
    removeInlineButtons: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDay(date: string, ids: string[]): AlbumPickerDay {
  return {
    date,
    matches: ids.map((id, index) => ({
      id,
      homeTeam: `Home ${index + 1}`,
      awayTeam: `Away ${index + 1}`,
      kickoffTime: `2026-05-1${index}T18:00:00.000Z`,
      league: 'Premier League',
    })),
    selectedMatchIds: [],
    strongDay: false,
  };
}

describe('MatchPickerService headliners', () => {
  function setup() {
    const channel = makeChannelMock();
    const redis = new RedisMock();
    const service = new MatchPickerService(
      channel as unknown as TelegramAdapter,
      redis as unknown as RedisService,
    );
    return { channel, redis, service };
  }

  it('limits manual picks to 5 without a headliner and 4 supporting matches with one', async () => {
    const { redis, service } = setup();
    await service.startPicker(
      'user-1',
      [makeDay('2026-05-10', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])],
      {
        showStrongDay: true,
        completeLabel: 'Generate Album',
        source: 'album',
      },
    );

    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      await service.handleCallback(
        'user-1',
        `${PICKER_TOGGLE_PREFIX}${id}`,
        42,
        jest.fn().mockResolvedValue(undefined),
      );
    }

    const maxFiveCallback = jest.fn().mockResolvedValue(undefined);
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m6`,
      42,
      maxFiveCallback,
    );
    expect(maxFiveCallback).toHaveBeenCalledWith('Max 5 matches per day.');

    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}add_headliner`,
      42,
      jest.fn().mockResolvedValue(undefined),
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m1`,
      42,
      jest.fn().mockResolvedValue(undefined),
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}headliner_continue`,
      42,
      jest.fn().mockResolvedValue(undefined),
    );

    const state = JSON.parse(
      (await redis.get(BOT_STATE_KEY.pendingCommand('user-1')))!,
    ) as { days: AlbumPickerDay[] };
    expect(state.days[0].headlinerId).toBe('m1');
    expect(state.days[0].selectedMatchIds).toHaveLength(4);
    expect(state.days[0].selectedMatchIds).not.toContain('m1');

    const maxFourCallback = jest.fn().mockResolvedValue(undefined);
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m6`,
      42,
      maxFourCallback,
    );
    expect(maxFourCallback).toHaveBeenCalledWith('Max 4 supporting matches.');
  });

  it('preserves headliners independently while navigating between days', async () => {
    const { redis, service } = setup();
    await service.startPicker(
      'user-1',
      [
        makeDay('2026-05-10', ['d1m1', 'd1m2']),
        makeDay('2026-05-11', ['d2m1', 'd2m2']),
      ],
      {
        showStrongDay: true,
        completeLabel: 'Generate Album',
        source: 'album',
      },
    );

    const answer = jest.fn().mockResolvedValue(undefined);
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}add_headliner`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}d1m1`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}headliner_continue`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}next`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}add_headliner`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}d2m2`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}headliner_continue`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}prev`,
      42,
      answer,
    );

    const state = JSON.parse(
      (await redis.get(BOT_STATE_KEY.pendingCommand('user-1')))!,
    ) as { days: AlbumPickerDay[]; currentDayIndex: number };
    expect(state.currentDayIndex).toBe(0);
    expect(state.days[0].headlinerId).toBe('d1m1');
    expect(state.days[1].headlinerId).toBe('d2m2');
  });

  it('removes the headliner when the active headliner button is clicked again', async () => {
    const { redis, service } = setup();
    const answer = jest.fn().mockResolvedValue(undefined);

    await service.startPicker('user-1', [makeDay('2026-05-10', ['m1', 'm2'])], {
      showStrongDay: true,
      completeLabel: 'Generate Album',
      source: 'album',
    });
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}add_headliner`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m1`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}headliner_continue`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m1`,
      42,
      answer,
    );

    const state = JSON.parse(
      (await redis.get(BOT_STATE_KEY.pendingCommand('user-1')))!,
    ) as { days: AlbumPickerDay[] };
    expect(state.days[0].headlinerId).toBeUndefined();
  });

  it('removes the active headliner while choosing a headliner for a single post', async () => {
    const { redis, service } = setup();
    const answer = jest.fn().mockResolvedValue(undefined);

    await service.startPicker('user-1', [makeDay('2026-05-10', ['m1', 'm2'])], {
      showStrongDay: false,
      completeLabel: 'Generate Post',
      source: 'post',
    });
    await service.handleCallback(
      'user-1',
      `${PICKER_NAV_PREFIX}add_headliner`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m1`,
      42,
      answer,
    );
    await service.handleCallback(
      'user-1',
      `${PICKER_TOGGLE_PREFIX}m1`,
      42,
      answer,
    );

    const state = JSON.parse(
      (await redis.get(BOT_STATE_KEY.pendingCommand('user-1')))!,
    ) as { days: AlbumPickerDay[]; headlinerPickMode?: boolean };
    expect(state.headlinerPickMode).toBe(true);
    expect(state.days[0].headlinerId).toBeUndefined();
  });

  it('splits large match lists into multiple button rows', () => {
    const { service } = setup();
    const day = makeDay(
      '2026-05-10',
      Array.from({ length: 13 }, (_, index) => `m${index + 1}`),
    );

    const rows = service.buildPickerKeyboard([day], 0, {
      showStrongDay: true,
      completeLabel: 'Generate Album',
      source: 'album',
    });
    const matchRows = rows.slice(1, 5);

    expect(matchRows.map((row) => row.map((button) => button.text))).toEqual([
      ['1', '2', '3', '4'],
      ['5', '6', '7', '8'],
      ['9', '10', '11', '12'],
      ['13'],
    ]);
  });
});
