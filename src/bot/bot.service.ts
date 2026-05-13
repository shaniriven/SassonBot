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
  formatWeekMatches,
} from '../common/utils/format-matches.util';
import { todayLabel, matchDateToDay } from '../common/utils/date.util';
import { CMD } from './commands.const';
import {
  GENERATE_POST_DATE_CALLBACK_PREFIX,
  ALBUM_MODE_PREFIX,
  BOT_STATE_KEY,
  BOT_STATE_TTL,
  PendingCommand,
  AlbumModeSource,
  AlbumPickerDay,
  UPCOMING_POST_DATE_LIMIT,
} from './bot.const';
import { MatchPickerService, PickerResult } from './match-picker.service';

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
    private readonly matchPicker: MatchPickerService,
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
              'No new leagues loaded (already up to date).',
            );
          } else {
            await this.channel.sendMessage(
              userId,
              `Loaded ${loaded} leagues into DB`,
            );
          }
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
      await this.channel.sendMessage(
        userId,
        formatWeekMatches(matches, 'Games This Week'),
      );

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
      if (
        pendingCommand?.type === CMD.generatePost.command &&
        pendingCommand.step === 'awaiting_date'
      ) {
        await this.channel.sendMessage(
          userId,
          'Please click one of the date buttons above. To cancel, run the command again.',
        );
        return;
      }
      if (pendingCommand?.step === 'awaiting_picks') {
        await this.channel.sendMessage(
          userId,
          'Please use the inline buttons to make your selection.',
        );
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
      await this.removeInlineButtonsSafely(userId, existing.messageId);
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

  private async handleCallbackQuery(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<void> {
    if (callbackData.startsWith(ALBUM_MODE_PREFIX)) {
      return this.handleAlbumModeChoice(
        userId,
        callbackData,
        messageId,
        answerCallback,
      );
    }

    const pickerResult = await this.matchPicker.handleCallback(
      userId,
      callbackData,
      messageId,
      answerCallback,
    );
    if (pickerResult !== null) {
      if (pickerResult.status === 'complete') {
        await this.onPickerComplete(userId, pickerResult);
      }
      return;
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

      await this.editMessageTextSafely(
        userId,
        pendingCommand.messageId,
        `For what day do you want to create the post?\n→ ${this.formatMatchDateConfirmation(matchDate)}`,
      );
      await answerCallback('Date selected.');

      const singleDay: AlbumPickerDay = {
        date: matchDate,
        matches: matches.map((m) => ({
          id: m.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          kickoffTime: m.kickoffTime.toISOString(),
          league: m.league,
        })),
        selectedMatchIds: [],
        strongDay: false,
      };
      await this.matchPicker.startPicker(userId, [singleDay], {
        showStrongDay: false,
        completeLabel: 'Generate Post',
        source: 'post',
      });
    } finally {
      await this.releasePendingCommandLock(userId, lockToken);
    }
  }

  private async onPickerComplete(
    userId: string,
    result: Extract<PickerResult, { status: 'complete' }>,
  ): Promise<void> {
    if (result.source === 'post') {
      const selectedIds = result.days[0]?.selectedMatchIds ?? [];
      const headlinerId = result.days[0]?.headlinerId;
      const matchIds = headlinerId
        ? [headlinerId, ...selectedIds]
        : selectedIds;
      if (matchIds.length === 0) return;
      await this.channel.sendMessage(
        userId,
        'Generating poster... This may take a few seconds.',
      );
      await this.channel.sendAction(userId, 'uploading_photo');
      await this.post.enqueuePost(matchIds, userId, headlinerId);
      return;
    }

    await this.channel.sendMessage(userId, 'Generating weekly album...');
    const allSelectedIds = [
      ...new Set(
        result.days.flatMap((d) =>
          d.headlinerId
            ? [d.headlinerId, ...d.selectedMatchIds]
            : d.selectedMatchIds,
        ),
      ),
    ];
    const dbMatches = await this.prisma.match.findMany({
      where: { id: { in: allSelectedIds } },
    });
    const favoritesByDate = result.days
      .map((day) => {
        const dayMatchIds = day.headlinerId
          ? [day.headlinerId, ...day.selectedMatchIds]
          : day.selectedMatchIds;
        return {
          date: day.date,
          matches: dbMatches
            .filter((m) => dayMatchIds.includes(m.id))
            .sort((a, b) => a.kickoffTime.getTime() - b.kickoffTime.getTime()),
          strongDay: day.strongDay,
          headlinerId: day.headlinerId,
        };
      })
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
      'Strong game days',
    );
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
      await this.channel.editMessageWithButtons(
        userId,
        messageId,
        text,
        buttons,
      );
    } catch (err) {
      this.logger.warn(`Failed to edit message with buttons: ${err}`);
    }
  }

  private async deliverAlbum(
    favoritesByDate: {
      date: string;
      matches: Match[];
      strongDay: boolean;
      reason?: string;
      headlinerId?: string;
    }[],
    sendText: (msg: string) => Promise<void>,
    sendAlbum: (items: AlbumItem[]) => Promise<unknown>,
    strongDayLabel = 'Suggested strong game days',
  ): Promise<void> {
    const items: AlbumItem[] = [];
    for (const { date, matches, headlinerId } of favoritesByDate) {
      const buffer = await this.post.generatePosterBuffer(matches, headlinerId);
      items.push({ source: buffer, caption: matchDateToDay(date) });
    }
    await sendAlbum(items);

    const strongDays = favoritesByDate.filter(({ strongDay }) => strongDay);
    if (strongDays.length > 0) {
      const dayNames = strongDays.map(({ date }) => matchDateToDay(date));
      await sendText(`${strongDayLabel}: ${dayNames.join(', ')}`);
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
        [
          {
            text: 'Manual Selection',
            callbackData: `${ALBUM_MODE_PREFIX}user:${source}`,
          },
        ],
        [
          {
            text: 'AI Choice',
            callbackData: `${ALBUM_MODE_PREFIX}ai:${source}`,
          },
        ],
        [
          {
            text: 'Cancel',
            callbackData: `${ALBUM_MODE_PREFIX}cancel:${source}`,
          },
        ],
      ],
    );
    await this.setPendingCommand(
      userId,
      {
        type: CMD.generateAlbum.command,
        step: 'awaiting_album_mode',
        messageId,
        source,
      },
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
      | {
          action: 'generate';
          mode: 'ai' | 'user';
          msgId: number;
          source: AlbumModeSource;
        };

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
          const mode = callbackData
            .slice(ALBUM_MODE_PREFIX.length)
            .split(':')[0];
          if (mode !== 'ai' && mode !== 'user' && mode !== 'cancel') {
            outcome = { action: 'noop' };
          } else {
            const msgId = pending.messageId;
            const source = pending.source;
            await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
            outcome =
              mode === 'cancel'
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
    const modeLabel = mode === 'ai' ? 'AI Choice' : 'Manual Selection';
    await this.editMessageTextSafely(
      userId,
      msgId,
      `How do you want to generate this week's album?\n→ ${modeLabel}`,
    );

    if (mode === 'ai') {
      await this.channel.sendMessage(
        userId,
        'Generating album, might take a few moments',
      );
      const favoritesByDate =
        source === 'cron'
          ? await this.football.getWeekFavoriteTeamMatchesForCron()
          : await this.football.getWeekFavoriteTeamMatches();
      if (favoritesByDate.length === 0) {
        await this.channel.sendMessage(
          userId,
          'No matches found for album generation.',
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
      return;
    }

    const grouped = await this.football.getWeekMatchesGroupedByDate(
      source === 'cron',
    );
    const days = this.buildAlbumPickerDays(grouped);
    if (days.length === 0) {
      await this.channel.sendMessage(
        userId,
        'No evening matches found for album generation.',
      );
      return;
    }
    await this.matchPicker.startPicker(userId, days, {
      showStrongDay: true,
      completeLabel: 'Generate Album',
      source: 'album',
    });
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

  @Cron('0 11 * * 5')
  async sendWeeklyAdminDigest(): Promise<void> {
    this.logger.log('Sending weekly games digest to admins');
    const admins = await this.prisma.user.findMany({
      where: { isAdmin: true },
    });
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
