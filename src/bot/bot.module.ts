import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { MatchPickerService } from './match-picker.service';
import { FootballModule } from '../football/football.module';
import { PostModule } from '../post/post.module';

@Module({
  imports: [FootballModule, PostModule],
  providers: [BotService, MatchPickerService],
})
export class BotModule {}
