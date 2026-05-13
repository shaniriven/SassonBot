import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Match } from '@prisma/client';
import { PostJobData } from './interfaces/post-job.interface';
import { PosterService } from '../poster/poster.service';
import { BackgroundService } from '../poster/background.service';

export const POST_QUEUE = 'post';

@Injectable()
export class PostService {
  constructor(
    @InjectQueue(POST_QUEUE) private readonly queue: Queue<PostJobData>,
    private readonly poster: PosterService,
    private readonly background: BackgroundService,
  ) {}

  async enqueuePost(
    matchIds: string[],
    recipientUserId: string,
    headlinerId?: string,
  ): Promise<void> {
    await this.queue.add('generate', {
      matchIds,
      recipientUserId,
      headlinerId,
    });
  }

  async generatePosterBuffer(
    matches: Match[],
    headlinerId?: string,
  ): Promise<Buffer> {
    const backgroundPath = await this.background.getNextBackground();
    return this.poster.generate(matches, backgroundPath, headlinerId);
  }
}
