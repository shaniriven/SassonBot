import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly channel: TelegramAdapter,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.channel.onCommand('start', async (userId) => {
      await this.prisma.user.upsert({
        where: { telegramId: userId },
        update: {},
        create: { telegramId: userId },
      });
      this.logger.log(`User registered: ${userId}`);
      await this.channel.sendMessage(userId, 'Welcome to Sasson Sport Bar Bot! 🍺⚽');
    });

    this.channel.onMessage(async (userId, text) => {
      await this.channel.sendMessage(
        userId,
        `Sasson is alive! I received your message: ${text}`,
      );
    });
  }
}
