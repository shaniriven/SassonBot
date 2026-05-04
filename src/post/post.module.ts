import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PostService, POST_QUEUE } from './post.service';
import { PostProcessor } from './post.processor';
import { PosterModule } from '../poster/poster.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: POST_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    PosterModule,
  ],
  providers: [PostService, PostProcessor],
  exports: [PostService],
})
export class PostModule {}
