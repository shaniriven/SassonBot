import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, Timeout } from '@nestjs/schedule';
import { TelegramAdapter } from './telegram.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { FootballService } from '../football/football.service';
import { RedisService } from '../redis/redis.service';
import {
  formatMatches,
  formatWeekMatches,
} from '../common/utils/format-matches.util';
import { todayLabel } from '../common/utils/date.util';
import { CMD } from './commands.const';

const ONBOARDING_KEY = (userId: string) => `onboarding:${userId}`;
const ONBOARDING_TTL = 600;

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly channel: TelegramAdapter,
    private readonly prisma: PrismaService,
    private readonly football: FootballService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
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
          "You are already registered. Use /games_today to see today's matches.",
        );
        return;
      }
      await this.prisma.user.create({ data: { telegramId: userId } });
      await this.redis.set(
        ONBOARDING_KEY(userId),
        'awaiting_admin_code',
        ONBOARDING_TTL,
      );
      await this.channel.sendMessage(
        userId,
        'Welcome to Sasson Sport Bar!\n\nDo you have an admin code? Enter it now, or send "skip" to continue as a regular user.',
      );
    });

    this.channel.onCommand(CMD.gamesToday.command, async (userId) => {
      const matches = await this.football.getTodayMatches();
      const now = new Date();
      const label = `Games Today — ${now.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' })}`;
      await this.channel.sendMessage(userId, formatMatches(matches, label));
    });

    this.channel.onCommand(CMD.gamesWeek.command, async (userId) => {
      const matches = await this.football.getWeekMatches();
      await this.channel.sendMessage(
        userId,
        formatWeekMatches(matches, 'Games This Week'),
      );
    });

    this.channel.onCommand(CMD.gamesNextWeek.command, async (userId) => {
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
      await this.channel.sendMessage(userId, 'Syncing fixtures from API...');
      try {
        const { synced } = await this.football.manualSync();
        await this.channel.sendMessage(
          userId,
          `Sync complete — ${synced} total fixtures in DB`,
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
        try {
          const { loaded } = await this.football.syncLeagues();
          if (loaded === 0) {
            await this.channel.sendMessage(
              userId,
              'No leagues loaded — add IDs to src/football/const/leagues.const.ts first',
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

    this.channel.onMessage(async (userId, text) => {
      const state = await this.redis.get(ONBOARDING_KEY(userId));
      if (state === 'awaiting_admin_code') {
        await this.redis.del(ONBOARDING_KEY(userId));
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

      await this.channel.sendMessage(
        userId,
        'This bot does not support regular messaging. Please use the commands menu to interact.',
      );
    });
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
    const label = `Games Today — ${todayLabel()}`;
    await this.notifyAdmins(formatMatches(matches, label));
  }

  @Cron('0 16 * * 6')
  async sendWeeklyAdminDigest(): Promise<void> {
    this.logger.log('Sending weekly games digest to admins');
    const matches = await this.football.getWeekMatches();
    await this.notifyAdmins(formatWeekMatches(matches, 'Games This Week'));
  }
}
