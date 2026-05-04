import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { TelegramAdapter } from './telegram.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { FootballService } from '../football/football.service';
import { RedisService } from '../redis/redis.service';
import { PostService } from '../post/post.service';
import { InlineButton } from '../common/interfaces/channel-adapter.interface';
import {
  formatMatches,
  formatMatchesForPosts,
  formatWeekMatches,
} from '../common/utils/format-matches.util';
import { todayLabel } from '../common/utils/date.util';
import { CMD } from './commands.const';
import {
  GENERATE_POST_DATE_CALLBACK_PREFIX,
  BOT_STATE_KEY,
  BOT_STATE_TTL,
  PendingCommand,
  UPCOMING_POST_DATE_LIMIT,
} from './bot.const';

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
      const matches = await this.football.getNextWeekMatches();
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
  ): Promise<void> {
    await this.redis.set(
      BOT_STATE_KEY.pendingCommand(userId),
      JSON.stringify(pendingCommand),
      BOT_STATE_TTL.pendingCommand,
    );
  }

  private async cancelPendingCommand(userId: string): Promise<void> {
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
      await this.channel.sendMessage(userId, 'Previous command cancelled.');
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

      await this.setPendingCommand(userId, {
        type: CMD.generatePost.command,
        step: 'awaiting_matches',
        matchDate,
        matchIds: matches.map((m) => m.id),
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
          matches,
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

  private async notifyAdmins(message: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { isAdmin: true },
    });
    if (admins.length === 0) {
      this.logger.warn('No admin users found for notification');
      return;
    }
    await Promise.all(
      admins.map((a) => this.channel.sendMessage(a.telegramId, message)),
    );
    this.logger.log(`Notified ${admins.length} admin(s)`);
  }

  @Cron('0 13 * * *')
  async sendDailyAdminDigest(): Promise<void> {
    this.logger.log('Sending daily games digest to admins');
    const matches = await this.football.getTodayMatches();
    const label = `Games Today - ${todayLabel()}`;
    await this.notifyAdmins(formatMatches(matches, label));
  }

  @Cron('0 16 * * 6')
  async sendWeeklyAdminDigest(): Promise<void> {
    this.logger.log('Sending weekly games digest to admins');
    const matches = await this.football.getWeekMatches();
    await this.notifyAdmins(formatWeekMatches(matches, 'Games This Week'));
  }
}
