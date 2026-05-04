import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  ChannelAdapter,
  CallbackQueryHandler,
  CommandHandler,
  GuardHandler,
  InlineButton,
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
    this.bot.catch((err, ctx) => {
      this.logger.error(
        `Unhandled error for update ${ctx.update.update_id}: ${String(err)}`,
      );
      if (ctx.chat) {
        void ctx.reply('Something went wrong. Please contact support.');
      }
    });
    void this.bot.telegram.setMyCommands([CMD.start]).catch((err) => {
      this.logger.warn(`Failed to set default Telegram commands: ${err}`);
    });
    void this.bot
      .launch()
      .then(() => this.logger.log('Telegram bot started'))
      .catch((err) => {
        this.logger.error(`Failed to launch Telegram bot: ${err}`);
      });
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(userId, text);
  }

  async sendMessageWithInlineButtons(
    userId: string,
    text: string,
    buttons: InlineButton[][],
  ): Promise<number> {
    const msg = await this.bot.telegram.sendMessage(userId, text, {
      reply_markup: {
        inline_keyboard: buttons.map((row) =>
          row.map((button) => ({
            text: button.text,
            callback_data: button.callbackData,
          })),
        ),
      },
    });
    return msg.message_id;
  }

  async removeInlineButtons(userId: string, messageId: number): Promise<void> {
    await this.bot.telegram.editMessageReplyMarkup(
      userId,
      messageId,
      undefined,
      { inline_keyboard: [] },
    );
  }

  async editMessageText(
    userId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.bot.telegram.editMessageText(userId, messageId, undefined, text);
  }

  async sendImage(
    userId: string,
    imageUrl: string,
    caption?: string,
  ): Promise<void> {
    await this.bot.telegram.sendPhoto(userId, imageUrl, { caption });
  }

  async sendPhoto(
    userId: string,
    buffer: Buffer,
    caption?: string,
  ): Promise<string> {
    const msg = await this.bot.telegram.sendPhoto(
      userId,
      { source: buffer },
      { caption },
    );
    return msg.photo[msg.photo.length - 1].file_id;
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

  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.bot.on('callback_query', async (ctx) => {
      if (!ctx.from || !('data' in ctx.callbackQuery)) {
        await ctx.answerCbQuery();
        return;
      }

      const messageId =
        ctx.callbackQuery.message && 'message_id' in ctx.callbackQuery.message
          ? ctx.callbackQuery.message.message_id
          : null;

      let answered = false;
      const answerOnce = async (text?: string): Promise<void> => {
        if (answered) return;
        answered = true;
        await ctx.answerCbQuery(text);
      };

      try {
        await handler(
          String(ctx.from.id),
          ctx.callbackQuery.data,
          messageId,
          answerOnce,
        );
      } catch (err) {
        this.logger.error(`Callback query handler error: ${err}`);
      } finally {
        await answerOnce();
      }
    });
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.bot.command(command, (ctx) => handler(String(ctx.from.id)));
  }
}
