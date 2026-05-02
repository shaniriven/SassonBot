import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { BotModule } from './bot/bot.module';
import { HealthModule } from './health/health.module';
import { FootballModule } from './football/football.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    FootballModule,
    BotModule,
    HealthModule,
  ],
})
export class AppModule {}
