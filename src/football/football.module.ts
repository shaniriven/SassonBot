import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FootballService } from './football.service';
import { FootballController } from './football.controller';

@Module({
  imports: [HttpModule],
  controllers: [FootballController],
  providers: [FootballService],
  exports: [FootballService],
})
export class FootballModule {}
