import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramAdapter } from '../bot/telegram.adapter';
import { PosterService } from '../poster/poster.service';
import { BackgroundService } from '../poster/background.service';
import { PostJobData } from './interfaces/post-job.interface';
import { POST_QUEUE } from './post.service';
import { toIsraeliDate } from '../common/utils/date.util';

@Processor(POST_QUEUE)
export class PostProcessor extends WorkerHost {
  private readonly logger = new Logger(PostProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channel: TelegramAdapter,
    private readonly poster: PosterService,
    private readonly background: BackgroundService,
  ) {
    super();
  }

  async process(job: Job<PostJobData>): Promise<void> {
    const { matchIds, recipientUserId, headlinerId } = job.data;

    const matches = await this.prisma.match.findMany({
      where: { id: { in: matchIds } },
      orderBy: { kickoffTime: 'asc' },
    });
    if (matches.length === 0) throw new Error('No matches found for given IDs');

    const backgroundPath = await this.background.getNextBackground();
    const posterBuffer = await this.poster.generate(
      matches,
      backgroundPath,
      headlinerId,
    );

    const telegramFileId = await this.channel.sendPhoto(
      recipientUserId,
      posterBuffer,
    );

    await this.prisma.post.create({
      data: {
        postDate: toIsraeliDate(new Date()),
        telegramFileId,
      },
    });

    this.logger.log(
      `Poster delivered for ${matches.length} match(es) on ${toIsraeliDate(new Date())}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PostJobData>, error: Error): void {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.logger.error(
        `Post job ${job.id} permanently failed: ${error.message}`,
      );
      void this.channel.sendMessage(
        job.data.recipientUserId,
        `Poster generation failed after ${job.attemptsMade} attempt(s): ${error.message}`,
      );
    }
  }
}
