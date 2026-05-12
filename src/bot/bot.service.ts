import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { TelegramAdapter } from './telegram.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { FootballService } from '../football/football.service';
import { RedisService } from '../redis/redis.service';
import type { Match } from '@prisma/client';
import { PostService } from '../post/post.service';
import {
  AlbumItem,
  InlineButton,
} from '../common/interfaces/channel-adapter.interface';
import {
  formatMatches,
  formatMatchesForPosts,
  formatWeekMatches,
  orderMatchesForPostSelection,
} from '../common/utils/format-matches.util';
import { todayLabel, matchDateToDay, getIsraeliTimeMinutes } from '../common/utils/date.util';
import { CMD } from './commands.const';
import {
  GENERATE_POST_DATE_CALLBACK_PREFIX,
  ALBUM_MODE_PREFIX,
  ALBUM_PICKER_TOGGLE_PREFIX,
  ALBUM_PICKER_NAV_PREFIX,
  ALBUM_PICKER_STRONG_PREFIX,
  BOT_STATE_KEY,
  BOT_STATE_TTL,
  PendingCommand,
  AlbumModeSource,
  AlbumPickerDay,
  UPCOMING_POST_DATE_LIMIT,
} from './bot.const';
import { LEAGUE_FLAGS } from '../football/const/leagues.const';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly channel: TelegramAdapter,
    private readonly prisma: PrismaService,
    private readonly football: FootballService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly post: PostService,
  ) {}

  onModuleInit() {
    void this.refreshKnownUserCommands().catch((err) => {
      this.logger.warn(`Failed to refresh Telegram commands: ${err}`);
    });

    this.channel.useGuard(async (userId, command) => {
      if (!command || command === CMD.start.command) return null;
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user) return 'Please send /start first to register.';
      return null;
    });

    this.channel.onCommand(CMD.start.command, async (userId) => {
      const existing = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (existing) {
        await this.channel.sendMessage(
          userId,
          'You are already registered. Use any command from the menu to get started.',
        );
        return;
      }
      await this.prisma.user.create({ data: { telegramId: userId } });
      await this.redis.set(
        BOT_STATE_KEY.onboarding(userId),
        'awaiting_admin_code',
        BOT_STATE_TTL.onboarding,
      );
      await this.channel.sendMessage(
        userId,
        'Welcome to Sasson Sport Bar!\n\nDo you have an admin code? Enter it now, or send "skip" to continue as a regular user.',
      );
    });

    this.channel.onCommand(CMD.gamesToday.command, async (userId) => {
      await this.cancelPendingCommand(userId);
      const matches = await this.football.getTodayMatches();
      await this.channel.sendMessage(
        userId,
        formatMatches(matches, `Games Today - ${todayLabel()}`),
      );
    });

    this.channel.onCommand(CMD.gamesWeek.command, async (userId) => {
      await this.cancelPendingCommand(userId);
      const matches = await this.football.getWeekMatches();
      await this.channel.sendMessage(
        userId,
        formatWeekMatches(matches, 'Games This Week'),
      );
    });

    this.channel.onCommand(CMD.gamesNextWeek.command, async (userId) => {
      await this.cancelPendingCommand(userId);
      const matches = await this.football.getWeekMatchesForCron();
      await this.channel.sendMessage(
        userId,
        formatWeekMatches(matches, 'Games Next Week'),
      );
    });

    this.channel.onCommand(CMD.adminSyncMatches.command, async (userId) => {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user?.isAdmin) {
        await this.channel.sendMessage(userId, 'Not authorized.');
        return;
      }
      await this.cancelPendingCommand(userId);
      await this.channel.sendMessage(userId, 'Syncing fixtures from API...');
      try {
        const { synced } = await this.football.manualSync();
        await this.channel.sendMessage(
          userId,
          `Sync complete - ${synced} total matches in DB`,
        );
      } catch (err) {
        await this.channel.sendMessage(userId, `Sync failed: ${err}`);
      }
    });

    this.channel.onCommand(
      CMD.adminLoadFavoriteLeagues.command,
      async (userId) => {
        const user = await this.prisma.user.findUnique({
          where: { telegramId: userId },
        });
        if (!user?.isAdmin) {
          await this.channel.sendMessage(userId, 'Not authorized.');
          return;
        }
        await this.cancelPendingCommand(userId);
        try {
          const { loaded } = await this.football.syncLeagues();
          if (loaded === 0) {
            await this.channel.sendMessage(
              userId,
              'No leagues loaded - add IDs to leagues.const.ts first',
            );
            return;
          }
          await this.channel.sendMessage(
            userId,
            `Loaded ${loaded} leagues into DB`,
          );
        } catch (err) {
          await this.channel.sendMessage(userId, `Failed: ${err}`);
        }
      },
    );

    this.channel.onCommand(CMD.generatePost.command, async (userId) => {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user?.isAdmin) {
        await this.channel.sendMessage(userId, 'Not authorized.');
        return;
      }
      await this.cancelPendingCommand(userId);

      const matchDates = await this.football.getUpcomingMatchDates(
        UPCOMING_POST_DATE_LIMIT,
      );
      if (matchDates.length === 0) {
        await this.channel.sendMessage(userId, 'No upcoming matches found.');
        return;
      }

      const messageId = await this.channel.sendMessageWithInlineButtons(
        userId,
        'For what day do you want to create the post?',
        this.buildDateButtons(matchDates),
      );
      await this.setPendingCommand(userId, {
        type: CMD.generatePost.command,
        step: 'awaiting_date',
        messageId,
      });
    });

    this.channel.onCommand(CMD.generateAlbum.command, async (userId) => {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user?.isAdmin) {
        await this.channel.sendMessage(userId, 'Not authorized.');
        return;
      }
      await this.cancelPendingCommand(userId);

      const matches = await this.football.getWeekMatches();
      await this.channel.sendMessage(userId, formatWeekMatches(matches, 'Games This Week'));

      await this.sendAlbumModeChoice(userId, 'cmd');
    });

    this.channel.onCallbackQuery(
      async (userId, callbackData, messageId, answerCallback) => {
        await this.handleCallbackQuery(
          userId,
          callbackData,
          messageId,
          answerCallback,
        );
      },
    );

    this.channel.onMessage(async (userId, text) => {
      const onboardingState = await this.redis.get(
        BOT_STATE_KEY.onboarding(userId),
      );
      if (onboardingState === 'awaiting_admin_code') {
        await this.redis.del(BOT_STATE_KEY.onboarding(userId));
        const adminCode = this.config.get<string>('ADMIN_CODE');
        if (text.trim() === adminCode) {
          await this.prisma.user.update({
            where: { telegramId: userId },
            data: { isAdmin: true },
          });
          await this.channel.setUserCommands(userId, true);
          await this.channel.sendMessage(
            userId,
            'Admin access granted. Welcome!',
          );
        } else if (text.trim().toLowerCase() === 'skip') {
          await this.channel.setUserCommands(userId, false);
          await this.channel.sendMessage(
            userId,
            'Registered as a regular user. Enjoy the matches!',
          );
        } else {
          await this.channel.setUserCommands(userId, false);
          await this.channel.sendMessage(
            userId,
            'Incorrect code. Registered as a regular user.',
          );
        }
        return;
      }

      const pendingCommand = await this.getPendingCommand(userId);
      if (pendingCommand?.type === CMD.generatePost.command) {
        if (pendingCommand.step === 'awaiting_date') {
          await this.handlePendingPostDateText(userId);
          return;
        }

        await this.handlePendingPostCommand(userId, text);
        return;
      }

      await this.channel.sendMessage(
        userId,
        'This bot does not support regular messaging. Please use the commands menu to interact.',
      );
    });
  }

  private async refreshKnownUserCommands(): Promise<void> {
    const users = await this.prisma.user.findMany();
    const results = await Promise.allSettled(
      users.map(async (user) => {
        try {
          await this.channel.setUserCommands(user.telegramId, user.isAdmin);
        } catch (err) {
          this.logger.warn(
            `Failed to refresh Telegram commands for ${user.telegramId}: ${err}`,
          );
          throw err;
        }
      }),
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      this.logger.warn(
        `Failed to refresh Telegram commands for ${failed.length} user(s)`,
      );
    }
    this.logger.log(`Refreshed Telegram commands for ${users.length} user(s)`);
  }

  private async setPendingCommand(
    userId: string,
    pendingCommand: PendingCommand,
    ttlSeconds: number = BOT_STATE_TTL.pendingCommand,
  ): Promise<void> {
    await this.redis.set(
      BOT_STATE_KEY.pendingCommand(userId),
      JSON.stringify(pendingCommand),
      ttlSeconds,
    );
  }

  private async cancelPendingCommand(
    userId: string,
    silent = false,
  ): Promise<void> {
    const lockToken = await this.acquirePendingCommandLock(userId);

    if (!lockToken) {
      await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
      return;
    }

    try {
      const existing = await this.getPendingCommand(userId);
      if (!existing) return;

      await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
      if (
        existing.type === CMD.generatePost.command &&
        existing.step === 'awaiting_date'
      ) {
        await this.removeInlineButtonsSafely(userId, existing.messageId);
      }
      if (existing.type === CMD.generateAlbum.command) {
        await this.removeInlineButtonsSafely(userId, existing.messageId);
      }
      if (!silent) {
        await this.channel.sendMessage(userId, 'Previous command cancelled.');
      }
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }
  }

  private async getPendingCommand(
    userId: string,
  ): Promise<PendingCommand | null> {
    const raw = await this.redis.get(BOT_STATE_KEY.pendingCommand(userId));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as PendingCommand;
    } catch {
      await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
      return null;
    }
  }

  private async handlePendingPostCommand(
    userId: string,
    text: string,
  ): Promise<void> {
    const lockToken = await this.acquirePendingCommandLock(userId);
    if (!lockToken) {
      await this.channel.sendMessage(
        userId,
        'Post generation is already being handled.',
      );
      return;
    }

    try {
      const pendingCommand = await this.getPendingCommand(userId);
      if (
        pendingCommand?.type !== CMD.generatePost.command ||
        pendingCommand.step !== 'awaiting_matches'
      ) {
        await this.channel.sendMessage(
          userId,
          'Post generation already handled or expired.',
        );
        return;
      }

      const parts = text
        .split(/[\s,]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
      const invalid = parts.some(
        (n) => n < 1 || n > pendingCommand.matchIds.length,
      );

      if (parts.length === 0 || parts.length > 5 || invalid) {
        await this.channel.sendMessage(
          userId,
          `Send numbers between 1 and ${pendingCommand.matchIds.length}, separated by commas (max 5). Example: 1,3`,
        );
        return;
      }

      const selected = [...new Set(parts)].map(
        (n) => pendingCommand.matchIds[n - 1],
      );
      await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
      await this.channel.sendMessage(
        userId,
        'Generating poster... This may take a few seconds.',
      );
      await this.channel.sendAction(userId, 'uploading_photo');
      await this.post.enqueuePost(selected, userId);
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }
  }

  private async handlePendingPostDateText(userId: string): Promise<void> {
    await this.channel.sendMessage(
      userId,
      'Please click one of the date buttons above. To cancel, run the command again.',
    );
  }

  private async handleCallbackQuery(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<void> {
    if (callbackData.startsWith(ALBUM_MODE_PREFIX)) {
      return this.handleAlbumModeChoice(userId, callbackData, messageId, answerCallback);
    }
    if (callbackData.startsWith(ALBUM_PICKER_TOGGLE_PREFIX)) {
      return this.handleAlbumPickerToggle(userId, callbackData, messageId, answerCallback);
    }
    if (callbackData.startsWith(ALBUM_PICKER_STRONG_PREFIX)) {
      return this.handleAlbumPickerStrong(userId, callbackData, messageId, answerCallback);
    }
    if (callbackData.startsWith(ALBUM_PICKER_NAV_PREFIX)) {
      return this.handleAlbumPickerNav(userId, callbackData, messageId, answerCallback);
    }
    if (!callbackData.startsWith(GENERATE_POST_DATE_CALLBACK_PREFIX)) {
      await answerCallback();
      return;
    }

    const matchDate = callbackData.slice(
      GENERATE_POST_DATE_CALLBACK_PREFIX.length,
    );
    if (!/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) {
      await answerCallback('Invalid selection.');
      return;
    }

    const lockToken = await this.acquirePendingCommandLock(userId);
    if (!lockToken) {
      await answerCallback('Selection already handled or expired.');
      return;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user?.isAdmin) {
        await answerCallback('Not authorized.');
        return;
      }

      const pendingCommand = await this.getPendingCommand(userId);
      if (
        pendingCommand?.type !== CMD.generatePost.command ||
        pendingCommand.step !== 'awaiting_date'
      ) {
        await answerCallback('Selection already handled or expired.');
        return;
      }

      if (messageId !== null && messageId !== pendingCommand.messageId) {
        await answerCallback('Selection already handled or expired.');
        return;
      }

      const matches = await this.football.getMatchesByDate(matchDate);
      if (matches.length === 0) {
        await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
        await this.editMessageTextSafely(
          userId,
          pendingCommand.messageId,
          `For what day do you want to create the post?\n→ No matches found for ${this.formatMatchDateConfirmation(matchDate)}.`,
        );
        await answerCallback('No matches found for this date.');
        await this.channel.sendMessage(
          userId,
          'No matches found for this date. Post generation cancelled.',
        );
        return;
      }

      const stillPending = await this.getPendingCommand(userId);
      if (
        stillPending?.type !== CMD.generatePost.command ||
        stillPending.step !== 'awaiting_date'
      ) {
        await answerCallback('Selection already handled or expired.');
        return;
      }

      const postSelectionMatches = orderMatchesForPostSelection(matches);

      await this.setPendingCommand(userId, {
        type: CMD.generatePost.command,
        step: 'awaiting_matches',
        matchDate,
        matchIds: postSelectionMatches.map((m) => m.id),
      });
      await this.editMessageTextSafely(
        userId,
        pendingCommand.messageId,
        `For what day do you want to create the post?\n→ ${this.formatMatchDateConfirmation(matchDate)}`,
      );
      await answerCallback('Date selected.');
      await this.channel.sendMessage(
        userId,
        formatMatchesForPosts(
          postSelectionMatches,
          `Post for - ${this.formatMatchDateLabel(matchDate)}`,
        ),
      );
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }
  }

  private buildDateButtons(matchDates: string[]): InlineButton[][] {
    const buttons = matchDates.map((matchDate) => {
      const callbackData = `${GENERATE_POST_DATE_CALLBACK_PREFIX}${matchDate}`;
      if (callbackData.length > 64) {
        this.logger.warn(
          `callback_data exceeds Telegram 64-byte limit: ${callbackData.length} bytes`,
        );
      }
      return { text: this.formatMatchDateButton(matchDate), callbackData };
    });

    const rows: InlineButton[][] = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    return rows;
  }

  private formatMatchDateButton(matchDate: string): string {
    const date = new Date(`${matchDate}T12:00:00Z`);
    return date.toLocaleDateString('en-GB', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });
  }

  private formatMatchDateLabel(matchDate: string): string {
    const date = new Date(`${matchDate}T12:00:00Z`);
    return date.toLocaleDateString('en-GB', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit',
    });
  }

  private formatMatchDateConfirmation(matchDate: string): string {
    const date = new Date(`${matchDate}T12:00:00Z`);
    return date.toLocaleDateString('en-GB', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
  }

  private async acquirePendingCommandLock(
    userId: string,
  ): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.setNx(
      BOT_STATE_KEY.pendingCommandLock(userId),
      token,
      BOT_STATE_TTL.pendingCommandLock,
    );
    return acquired ? token : null;
  }

  private async releasePendingCommandLock(
    userId: string,
    token: string,
  ): Promise<void> {
    await this.redis.delIfValue(
      BOT_STATE_KEY.pendingCommandLock(userId),
      token,
    );
  }

  private async removeInlineButtonsSafely(
    userId: string,
    messageId: number,
  ): Promise<void> {
    try {
      await this.channel.removeInlineButtons(userId, messageId);
    } catch (err) {
      this.logger.warn(`Failed to remove inline buttons: ${err}`);
    }
  }

  private async editMessageTextSafely(
    userId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.channel.editMessageText(userId, messageId, text);
    } catch (err) {
      this.logger.warn(`Failed to edit message text: ${err}`);
    }
  }

  private async editMessageWithButtonsSafely(
    userId: string,
    messageId: number,
    text: string,
    buttons: InlineButton[][],
  ): Promise<void> {
    try {
      await this.channel.editMessageWithButtons(userId, messageId, text, buttons);
    } catch (err) {
      this.logger.warn(`Failed to edit message with buttons: ${err}`);
    }
  }

  private async deliverAlbum(
    favoritesByDate: { date: string; matches: Match[]; strongDay: boolean; reason?: string }[],
    sendText: (msg: string) => Promise<void>,
    sendAlbum: (items: AlbumItem[]) => Promise<unknown>,
  ): Promise<void> {
    const items: AlbumItem[] = [];
    for (const { date, matches } of favoritesByDate) {
      const buffer = await this.post.generatePosterBuffer(matches);
      items.push({ source: buffer, caption: matchDateToDay(date) });
    }
    await sendAlbum(items);

    const strongDays = favoritesByDate.filter(({ strongDay }) => strongDay);
    if (strongDays.length > 0) {
      const dayNames = strongDays.map(({ date }) => matchDateToDay(date));
      await sendText(`Suggested strong game days: ${dayNames.join(', ')}`);
    }
  }

  private async sendAlbumModeChoice(
    userId: string,
    source: AlbumModeSource,
  ): Promise<void> {
    const messageId = await this.channel.sendMessageWithInlineButtons(
      userId,
      "How do you want to generate this week's album?",
      [
        [{ text: 'Manual Selection', callbackData: `${ALBUM_MODE_PREFIX}user:${source}` }],
        [{ text: 'AI Choice', callbackData: `${ALBUM_MODE_PREFIX}ai:${source}` }],
        [{ text: 'Auto Generated', callbackData: `${ALBUM_MODE_PREFIX}auto:${source}` }],
        [{ text: 'Cancel', callbackData: `${ALBUM_MODE_PREFIX}cancel:${source}` }],
      ],
    );
    await this.setPendingCommand(
      userId,
      { type: CMD.generateAlbum.command, step: 'awaiting_album_mode', messageId, source },
      BOT_STATE_TTL.albumMode,
    );
  }

  private async handleAlbumModeChoice(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<void> {
    type Outcome =
      | { action: 'noop'; callbackText?: string }
      | { action: 'cancel'; msgId: number }
      | { action: 'generate'; mode: 'ai' | 'auto' | 'user'; msgId: number; source: AlbumModeSource };

    let outcome: Outcome = { action: 'noop' };

    const lockToken = await this.acquirePendingCommandLock(userId);
    if (!lockToken) {
      outcome = { action: 'noop', callbackText: 'Already being handled.' };
    } else {
      try {
        const pending = await this.getPendingCommand(userId);
        if (
          !pending ||
          pending.type !== CMD.generateAlbum.command ||
          pending.step !== 'awaiting_album_mode'
        ) {
          outcome = { action: 'noop', callbackText: 'Expired.' };
        } else if (messageId !== null && messageId !== pending.messageId) {
          outcome = { action: 'noop' };
        } else {
          const mode = callbackData.slice(ALBUM_MODE_PREFIX.length).split(':')[0];
          if (mode !== 'ai' && mode !== 'auto' && mode !== 'user' && mode !== 'cancel') {
            outcome = { action: 'noop' };
          } else {
            const msgId = pending.messageId;
            const source = pending.source;
            await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
            outcome = mode === 'cancel'
              ? { action: 'cancel', msgId }
              : { action: 'generate', mode, msgId, source };
          }
        }
      } finally {
        await this.releasePendingCommandLock(userId, lockToken);
      }
    }

    if (outcome.action === 'noop') {
      await answerCallback(outcome.callbackText);
      return;
    }
    await answerCallback();

    if (outcome.action === 'cancel') {
      await this.editMessageWithButtonsSafely(
        userId,
        outcome.msgId,
        "How do you want to generate this week's album?\n→ Cancelled",
        [],
      );
      await this.channel.sendMessage(userId, 'Album generation cancelled.');
      return;
    }

    const { mode, msgId, source } = outcome;
    const modeLabel =
      mode === 'ai' ? 'AI Choice' : mode === 'auto' ? 'Auto Generated' : 'Manual Selection';
    await this.editMessageTextSafely(
      userId,
      msgId,
      `How do you want to generate this week's album?\n→ ${modeLabel}`,
    );

    if (mode === 'ai') {
      await this.channel.sendMessage(userId, 'Generating album, might take a few moments');
      const favoritesByDate = source === 'cron'
        ? await this.football.getWeekFavoriteTeamMatchesForCron()
        : await this.football.getWeekFavoriteTeamMatches();
      if (favoritesByDate.length === 0) {
        await this.channel.sendMessage(userId, 'No matches found for album generation.');
        return;
      }
      await this.deliverAlbum(
        favoritesByDate,
        (msg) => this.channel.sendMessage(userId, msg),
        (items) =>
          items.length === 1
            ? this.channel.sendPhoto(userId, items[0].source, items[0].caption)
            : this.channel.sendAlbum(userId, items),
      );
      return;
    }

    if (mode === 'auto') {
      await this.channel.sendMessage(userId, 'Generating album, might take a few moments');
      const favoritesByDate = source === 'cron'
        ? await this.football.getWeekAutoMatchesForCron()
        : await this.football.getWeekAutoMatches();
      if (favoritesByDate.length === 0) {
        await this.channel.sendMessage(userId, 'No matches found for album generation.');
        return;
      }
      await this.deliverAlbum(
        favoritesByDate,
        (msg) => this.channel.sendMessage(userId, msg),
        (items) =>
          items.length === 1
            ? this.channel.sendPhoto(userId, items[0].source, items[0].caption)
            : this.channel.sendAlbum(userId, items),
      );
      return;
    }

    const grouped = await this.football.getWeekMatchesGroupedByDate(source === 'cron');
    const days = this.buildAlbumPickerDays(grouped);
    if (days.length === 0) {
      await this.channel.sendMessage(userId, 'No evening matches found for album generation.');
      return;
    }
    await this.startAlbumPicker(userId, days);
  }

  private async startAlbumPicker(
    userId: string,
    days: AlbumPickerDay[],
  ): Promise<void> {
    const messageId = await this.channel.sendMessageWithInlineButtons(
      userId,
      this.buildAlbumPickerText(days, 0),
      this.buildAlbumPickerKeyboard(days, 0),
    );
    await this.setPendingCommand(
      userId,
      { type: CMD.generateAlbum.command, step: 'awaiting_picks', messageId, days, currentDayIndex: 0 },
      BOT_STATE_TTL.albumPicker,
    );
  }

  private buildAlbumPickerDays(
    grouped: { date: string; matches: Match[] }[],
  ): AlbumPickerDay[] {
    return grouped.map(({ date, matches }) => ({
      date,
      matches: matches.map((m) => ({
        id: m.id,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        kickoffTime: m.kickoffTime.toISOString(),
        league: m.league,
      })),
      selectedMatchIds: [],
      strongDay: false,
    }));
  }

  private buildAlbumPickerSummary(days: AlbumPickerDay[]): string {
    const lines: string[] = ['Manual Selection\n'];
    for (const d of days) {
      if (d.selectedMatchIds.length === 0) continue;
      const dayName = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-GB', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'long',
      });
      const matchNames = d.selectedMatchIds
        .map((id) => d.matches.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => `${m!.homeTeam} | ${m!.awayTeam}`)
        .join(', ');
      const strong = d.strongDay ? '  ☑ Strong' : '';
      lines.push(`${dayName}: ${matchNames}${strong}`);
    }
    return lines.join('\n');
  }

  private buildAlbumPickerText(days: AlbumPickerDay[], index: number): string {
    const lines: string[] = [this.buildAlbumPickerSummary(days), ''];

    const day = days[index];
    const dayLabel = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
    });
    lines.push(`📅 ${dayLabel} (day ${index + 1} of ${days.length})\n`);

    const matchIndices = new Map(day.matches.map((m, i) => [m.id, i + 1]));
    const byLeague = new Map<string, typeof day.matches>();
    for (const m of day.matches) {
      if (!byLeague.has(m.league)) byLeague.set(m.league, []);
      byLeague.get(m.league)!.push(m);
    }

    for (const [league, matches] of byLeague) {
      const flag = LEAGUE_FLAGS[league] ?? '🏆';
      lines.push(`${flag} ${league} ${flag}`);
      for (const m of matches) {
        const minutes = getIsraeliTimeMinutes(new Date(m.kickoffTime));
        const h = Math.floor(minutes / 60).toString().padStart(2, '0');
        const min = (minutes % 60).toString().padStart(2, '0');
        lines.push(`${matchIndices.get(m.id)!}. ${m.homeTeam} | ${m.awayTeam} | ${h}:${min}`);
      }
      lines.push('');
    }

    lines.push('Select matches and mark as strong day:');
    return lines.join('\n');
  }

  private buildAlbumPickerKeyboard(
    days: AlbumPickerDay[],
    index: number,
  ): InlineButton[][] {
    const day = days[index];

    const strongRow: InlineButton[] = [
      {
        text: `${day.strongDay ? '☑' : '☐'} Strong Day`,
        callbackData: `${ALBUM_PICKER_STRONG_PREFIX}toggle`,
      },
    ];

    const matchRows: InlineButton[][] = day.matches.map((m) => {
      const selected = day.selectedMatchIds.includes(m.id);
      const minutes = getIsraeliTimeMinutes(new Date(m.kickoffTime));
      const h = Math.floor(minutes / 60).toString().padStart(2, '0');
      const min = (minutes % 60).toString().padStart(2, '0');
      const label = `${selected ? '☑' : '☐'} ${m.homeTeam} vs ${m.awayTeam} ${h}:${min}`;
      return [{ text: label, callbackData: `${ALBUM_PICKER_TOGGLE_PREFIX}${m.id}` }];
    });

    const navRow: InlineButton[] = [
      { text: 'Cancel', callbackData: `${ALBUM_PICKER_NAV_PREFIX}cancel` },
    ];
    if (index > 0) {
      navRow.push({ text: '← Back', callbackData: `${ALBUM_PICKER_NAV_PREFIX}prev` });
    }
    if (index < days.length - 1) {
      navRow.push({ text: 'Next →', callbackData: `${ALBUM_PICKER_NAV_PREFIX}next` });
    } else {
      navRow.push({ text: 'Generate Album', callbackData: `${ALBUM_PICKER_NAV_PREFIX}gen` });
    }

    return [strongRow, ...matchRows, navRow];
  }

  private async handleAlbumPickerToggle(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<void> {
    type Outcome =
      | { action: 'expired'; staleMessageId: number | null }
      | { action: 'mismatch' }
      | { action: 'limit' }
      | { action: 'toggled'; msgId: number; text: string; keyboard: InlineButton[][] };

    let outcome: Outcome = { action: 'mismatch' };

    const lockToken = await this.acquirePendingCommandLock(userId);
    if (!lockToken) {
      await answerCallback();
      return;
    }
    try {
      const pending = await this.getPendingCommand(userId);
      if (
        !pending ||
        pending.type !== CMD.generateAlbum.command ||
        pending.step !== 'awaiting_picks'
      ) {
        outcome = { action: 'expired', staleMessageId: messageId };
      } else if (messageId !== null && messageId !== pending.messageId) {
        outcome = { action: 'mismatch' };
      } else {
        const matchId = callbackData.slice(ALBUM_PICKER_TOGGLE_PREFIX.length);
        const day = pending.days[pending.currentDayIndex];
        const idx = day.selectedMatchIds.indexOf(matchId);
        if (idx === -1 && day.selectedMatchIds.length >= 5) {
          outcome = { action: 'limit' };
        } else {
          if (idx === -1) {
            day.selectedMatchIds.push(matchId);
          } else {
            day.selectedMatchIds.splice(idx, 1);
          }
          const msgId = pending.messageId;
          await this.setPendingCommand(userId, pending, BOT_STATE_TTL.albumPicker);
          outcome = {
            action: 'toggled',
            msgId,
            text: this.buildAlbumPickerText(pending.days, pending.currentDayIndex),
            keyboard: this.buildAlbumPickerKeyboard(pending.days, pending.currentDayIndex),
          };
        }
      }
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }

    switch (outcome.action) {
      case 'expired':
        if (outcome.staleMessageId !== null) {
          await this.removeInlineButtonsSafely(userId, outcome.staleMessageId);
        }
        await answerCallback('Session expired.');
        break;
      case 'mismatch':
        await answerCallback();
        break;
      case 'limit':
        await answerCallback('Max 5 matches per day.');
        break;
      case 'toggled':
        await this.editMessageWithButtonsSafely(userId, outcome.msgId, outcome.text, outcome.keyboard);
        await answerCallback();
        break;
    }
  }

  private async handleAlbumPickerStrong(
    userId: string,
    _callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<void> {
    type Outcome =
      | { action: 'expired'; staleMessageId: number | null }
      | { action: 'mismatch' }
      | { action: 'toggled'; msgId: number; text: string; keyboard: InlineButton[][] };

    let outcome: Outcome = { action: 'mismatch' };

    const lockToken = await this.acquirePendingCommandLock(userId);
    if (!lockToken) {
      await answerCallback();
      return;
    }
    try {
      const pending = await this.getPendingCommand(userId);
      if (
        !pending ||
        pending.type !== CMD.generateAlbum.command ||
        pending.step !== 'awaiting_picks'
      ) {
        outcome = { action: 'expired', staleMessageId: messageId };
      } else if (messageId !== null && messageId !== pending.messageId) {
        outcome = { action: 'mismatch' };
      } else {
        const day = pending.days[pending.currentDayIndex];
        day.strongDay = !day.strongDay;
        const msgId = pending.messageId;
        await this.setPendingCommand(userId, pending, BOT_STATE_TTL.albumPicker);
        outcome = {
          action: 'toggled',
          msgId,
          text: this.buildAlbumPickerText(pending.days, pending.currentDayIndex),
          keyboard: this.buildAlbumPickerKeyboard(pending.days, pending.currentDayIndex),
        };
      }
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }

    switch (outcome.action) {
      case 'expired':
        if (outcome.staleMessageId !== null) {
          await this.removeInlineButtonsSafely(userId, outcome.staleMessageId);
        }
        await answerCallback('Session expired.');
        break;
      case 'mismatch':
        await answerCallback();
        break;
      case 'toggled':
        await this.editMessageWithButtonsSafely(userId, outcome.msgId, outcome.text, outcome.keyboard);
        await answerCallback();
        break;
    }
  }

  private async handleAlbumPickerNav(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<void> {
    type Outcome =
      | { action: 'noop'; callbackText?: string }
      | { action: 'expired'; staleMessageId: number | null }
      | { action: 'cancel'; msgId: number }
      | { action: 'navigate'; msgId: number; text: string; keyboard: InlineButton[][] }
      | { action: 'gen'; msgId: number; allSelectedIds: string[]; daysSnapshot: AlbumPickerDay[] };

    let outcome: Outcome = { action: 'noop' };

    const lockToken = await this.acquirePendingCommandLock(userId);
    if (!lockToken) {
      await answerCallback();
      return;
    }
    try {
      const pending = await this.getPendingCommand(userId);
      if (
        !pending ||
        pending.type !== CMD.generateAlbum.command ||
        pending.step !== 'awaiting_picks'
      ) {
        outcome = { action: 'expired', staleMessageId: messageId };
      } else if (messageId !== null && messageId !== pending.messageId) {
        outcome = { action: 'noop' };
      } else {
        const navType = callbackData.slice(ALBUM_PICKER_NAV_PREFIX.length);
        const msgId = pending.messageId;
        const { days } = pending;
        const idx = pending.currentDayIndex;

        switch (navType) {
          case 'cancel':
            await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
            outcome = { action: 'cancel', msgId };
            break;
          case 'prev':
            if (idx === 0) {
              outcome = { action: 'noop' };
            } else {
              pending.currentDayIndex = idx - 1;
              await this.setPendingCommand(userId, pending, BOT_STATE_TTL.albumPicker);
              outcome = {
                action: 'navigate',
                msgId,
                text: this.buildAlbumPickerText(days, idx - 1),
                keyboard: this.buildAlbumPickerKeyboard(days, idx - 1),
              };
            }
            break;
          case 'next':
            if (idx === days.length - 1) {
              outcome = { action: 'noop' };
            } else {
              pending.currentDayIndex = idx + 1;
              await this.setPendingCommand(userId, pending, BOT_STATE_TTL.albumPicker);
              outcome = {
                action: 'navigate',
                msgId,
                text: this.buildAlbumPickerText(days, idx + 1),
                keyboard: this.buildAlbumPickerKeyboard(days, idx + 1),
              };
            }
            break;
          case 'gen': {
            const daysWithMatches = days.filter(
              (d) => d.selectedMatchIds.length > 0,
            );
            if (daysWithMatches.length === 0) {
              outcome = {
                action: 'noop',
                callbackText: 'Select at least one match.',
              };
            } else {
              await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
              outcome = {
                action: 'gen',
                msgId,
                allSelectedIds: daysWithMatches.flatMap((d) => d.selectedMatchIds),
                daysSnapshot: daysWithMatches,
              };
            }
            break;
          }
          default:
            outcome = { action: 'noop' };
        }
      }
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }

    switch (outcome.action) {
      case 'noop':
        await answerCallback(outcome.callbackText);
        break;
      case 'expired':
        if (outcome.staleMessageId !== null) {
          await this.removeInlineButtonsSafely(userId, outcome.staleMessageId);
        }
        await answerCallback('Session expired.');
        break;
      case 'cancel':
        await this.removeInlineButtonsSafely(userId, outcome.msgId);
        await answerCallback();
        await this.channel.sendMessage(userId, 'Album generation cancelled.');
        break;
      case 'navigate':
        await this.editMessageWithButtonsSafely(
          userId,
          outcome.msgId,
          outcome.text,
          outcome.keyboard,
        );
        await answerCallback();
        break;
      case 'gen': {
        await this.editMessageTextSafely(
          userId,
          outcome.msgId,
          this.buildAlbumPickerSummary(outcome.daysSnapshot),
        );
        await answerCallback();
        await this.channel.sendMessage(userId, 'Generating weekly album...');
        const dbMatches = await this.prisma.match.findMany({
          where: { id: { in: outcome.allSelectedIds } },
        });
        const favoritesByDate = outcome.daysSnapshot
          .map((day) => ({
            date: day.date,
            matches: dbMatches
              .filter((m) => day.selectedMatchIds.includes(m.id))
              .sort((a, b) => a.kickoffTime.getTime() - b.kickoffTime.getTime()),
            strongDay: day.strongDay,
          }))
          .filter((d) => d.matches.length > 0);
        if (favoritesByDate.length === 0) {
          await this.channel.sendMessage(
            userId,
            'Selected matches are no longer available. Album generation cancelled.',
          );
          return;
        }
        await this.deliverAlbum(
          favoritesByDate,
          (msg) => this.channel.sendMessage(userId, msg),
          (items) =>
            items.length === 1
              ? this.channel.sendPhoto(userId, items[0].source, items[0].caption)
              : this.channel.sendAlbum(userId, items),
        );
        break;
      }
    }
  }

  @Cron('0 11 * * 5')
  async sendWeeklyAdminDigest(): Promise<void> {
    this.logger.log('Sending weekly games digest to admins');
    const admins = await this.prisma.user.findMany({ where: { isAdmin: true } });
    if (admins.length === 0) return;

    const matches = await this.football.getWeekMatchesForCron();
    const summary = formatWeekMatches(matches, 'Games This Week');

    for (const admin of admins) {
      await this.cancelPendingCommand(admin.telegramId, true);
      await this.channel.sendMessage(admin.telegramId, summary);
      await this.sendAlbumModeChoice(admin.telegramId, 'cron');
    }
  }
}
