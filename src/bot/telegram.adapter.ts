import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  ChannelAdapter,
  CommandHandler,
  GuardHandler,
  MessageHandler,
} from '../common/interfaces/channel-adapter.interface';
import { ADMIN_COMMANDS, CMD, USER_COMMANDS } from './commands.const';

@Injectable()
export class TelegramAdapter implements ChannelAdapter, OnModuleInit {
  private readonly logger = new Logger(TelegramAdapter.name);
  private readonly bot: Telegraf;

  constructor(private readonly config: ConfigService) {
    this.bot = new Telegraf(
      this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN'),
    );
  }

  onModuleInit() {
    void this.bot.telegram.setMyCommands([CMD.start]);
    void this.bot.launch().then(() => this.logger.log('Telegram bot started'));
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(userId, text);
  }

  async sendImage(
    userId: string,
    imageUrl: string,
    caption?: string,
  ): Promise<void> {
    await this.bot.telegram.sendPhoto(userId, imageUrl, { caption });
  }

  async sendAction(
    userId: string,
    action: 'typing' | 'uploading_photo',
  ): Promise<void> {
    const tgAction = action === 'uploading_photo' ? 'upload_photo' : 'typing';
    await this.bot.telegram.sendChatAction(userId, tgAction);
  }

  useGuard(handler: GuardHandler): void {
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return next();
      const userId = String(ctx.from.id);
      let command: string | null = null;
      if (ctx.message && 'text' in ctx.message) {
        const text = ctx.message.text;
        if (text.startsWith('/')) {
          command = text.split('@')[0].substring(1).split(' ')[0];
        }
      }
      const blockMessage = await handler(userId, command);
      if (blockMessage) {
        await ctx.reply(blockMessage);
        return;
      }
      return next();
    });
  }

  async setUserCommands(userId: string, isAdmin: boolean): Promise<void> {
    await this.bot.telegram.setMyCommands(
      isAdmin ? ADMIN_COMMANDS : USER_COMMANDS,
      { scope: { type: 'chat', chat_id: Number(userId) } },
    );
  }

  onMessage(handler: MessageHandler): void {
    this.bot.on(message('text'), (ctx) =>
      handler(String(ctx.from.id), ctx.message.text),
    );
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.bot.command(command, (ctx) => handler(String(ctx.from.id)));
  }
}
