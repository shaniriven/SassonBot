import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { TelegramAdapter } from './telegram.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { FootballService } from '../football/football.service';
import { RedisService } from '../redis/redis.service';
import { PostService } from '../post/post.service';
import {
  formatMatches,
  formatMatchesForPosts,
  formatWeekMatches,
} from '../common/utils/format-matches.util';
import { todayLabel } from '../common/utils/date.util';
import { CMD } from './commands.const';
import { BOT_STATE_KEY, BOT_STATE_TTL, PendingCommand } from './bot.const';

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

    this.channel.onCommand(CMD.adminGeneratePost.command, async (userId) => {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user?.isAdmin) {
        await this.channel.sendMessage(userId, 'Not authorized.');
        return;
      }
      const matches = await this.football.getTodayMatches();
      if (matches.length === 0) {
        await this.channel.sendMessage(userId, 'No matches today.');
        return;
      }

      await this.replacePendingCommand(userId, {
        type: CMD.adminGeneratePost.command,
        matchIds: matches.map((m) => m.id),
      });
      await this.channel.sendMessage(
        userId,
        formatMatchesForPosts(matches, `Post for - ${todayLabel()}`),
      );
    });

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
      if (pendingCommand?.type === CMD.adminGeneratePost.command) {
        await this.handlePendingPostCommand(userId, text, pendingCommand);
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

  private async replacePendingCommand(
    userId: string,
    pendingCommand: PendingCommand,
  ): Promise<void> {
    const existing = await this.getPendingCommand(userId);
    if (existing) {
      await this.channel.sendMessage(
        userId,
        'Previous command cancelled. Starting new command.',
      );
    }

    await this.redis.set(
      BOT_STATE_KEY.pendingCommand(userId),
      JSON.stringify(pendingCommand),
      BOT_STATE_TTL.pendingCommand,
    );
  }

  private async cancelPendingCommand(userId: string): Promise<void> {
    const existing = await this.getPendingCommand(userId);
    if (!existing) return;

    await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
    await this.channel.sendMessage(userId, 'Previous command cancelled.');
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
    pendingCommand: PendingCommand,
  ): Promise<void> {
    const parts = text
      .split(',')
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
