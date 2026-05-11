import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FootballService } from './football.service';
import { FootballController } from './football.controller';
import { OpenAiModule } from '../openai/openai.module';

@Module({
  imports: [HttpModule, OpenAiModule],
  controllers: [FootballController],
  providers: [FootballService],
  exports: [FootballService],
})
export class FootballModule {}
