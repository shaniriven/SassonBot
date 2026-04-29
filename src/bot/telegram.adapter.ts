import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { ChannelAdapter, CommandHandler, MessageHandler } from '../common/interfaces/channel-adapter.interface';

@Injectable()
export class TelegramAdapter implements ChannelAdapter, OnModuleInit {
  private readonly logger = new Logger(TelegramAdapter.name);
  private readonly bot: Telegraf;

  constructor(private readonly config: ConfigService) {
    this.bot = new Telegraf(this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN'));
  }

  onModuleInit() {
    this.bot.launch().then(() => this.logger.log('Telegram bot started'));
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(userId, text);
  }

  async sendImage(userId: string, imageUrl: string, caption?: string): Promise<void> {
    await this.bot.telegram.sendPhoto(userId, imageUrl, { caption });
  }

  async sendAction(userId: string, action: 'typing' | 'uploading_photo'): Promise<void> {
    const tgAction = action === 'uploading_photo' ? 'upload_photo' : 'typing';
    await this.bot.telegram.sendChatAction(userId, tgAction);
  }

  onMessage(handler: MessageHandler): void {
    this.bot.on(message('text'), (ctx) => handler(String(ctx.from.id), ctx.message.text));
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.bot.command(command, (ctx) => handler(String(ctx.from.id)));
  }
}
