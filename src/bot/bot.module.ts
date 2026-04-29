import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter';
import { BotService } from './bot.service';

@Module({
  providers: [TelegramAdapter, BotService],
  exports: [TelegramAdapter],
})
export class BotModule {}
