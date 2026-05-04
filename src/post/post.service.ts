import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PostJobData } from './interfaces/post-job.interface';

export const POST_QUEUE = 'post';

@Injectable()
export class PostService {
  constructor(
    @InjectQueue(POST_QUEUE) private readonly queue: Queue<PostJobData>,
  ) {}

  async enqueuePost(
    matchIds: string[],
    recipientUserId: string,
  ): Promise<void> {
    await this.queue.add('generate', { matchIds, recipientUserId });
  }
}
