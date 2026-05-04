import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { TelegramModule } from './bot/telegram.module';
import { BotModule } from './bot/bot.module';
import { HealthModule } from './health/health.module';
import { FootballModule } from './football/football.module';
import { RedisModule } from './redis/redis.module';
import { PostModule } from './post/post.module';
import { PosterModule } from './poster/poster.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    PrismaModule,
    RedisModule,
    TelegramModule,
    FootballModule,
    BotModule,
    PostModule,
    PosterModule,
    HealthModule,
  ],
})
export class AppModule {}
