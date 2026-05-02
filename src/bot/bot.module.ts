import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter';
import { BotService } from './bot.service';
import { FootballModule } from '../football/football.module';

@Module({
  imports: [FootballModule],
  providers: [TelegramAdapter, BotService],
  exports: [TelegramAdapter],
})
export class BotModule {}
