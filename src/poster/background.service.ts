import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

const BACKGROUND_FILE_PATTERN = /^bg-\d+\.(png|jpe?g|webp)$/i;

@Injectable()
export class BackgroundService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundService.name);
  private backgroundFilenames: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const backgroundFilenames = await this.loadBackgroundFilenames();

    for (const filename of backgroundFilenames) {
      await this.prisma.background.upsert({
        where: { filename },
        update: {},
        create: { filename },
      });
    }

    await this.prisma.background.deleteMany({
      where: {
        filename: {
          notIn: backgroundFilenames,
        },
      },
    });

    this.backgroundFilenames = backgroundFilenames;
    this.logger.log(
      `Background records synced: ${backgroundFilenames.join(', ')}`,
    );
  }

  async getNextBackground(): Promise<string> {
    const backgroundFilenames =
      this.backgroundFilenames.length > 0
        ? this.backgroundFilenames
        : await this.loadBackgroundFilenames();

    const chosen = await this.prisma.background.findFirst({
      where: {
        filename: { in: backgroundFilenames },
      },
      orderBy: [
        { lastUsedDate: { sort: 'asc', nulls: 'first' } },
        { filename: 'asc' },
      ],
    });

    if (!chosen) throw new Error('No backgrounds found in DB');

    await this.prisma.background.update({
      where: { id: chosen.id },
      data: { lastUsedDate: new Date().toISOString() },
    });

    return path.join(process.cwd(), 'assets', 'backgrounds', chosen.filename);
  }

  private async loadBackgroundFilenames(): Promise<string[]> {
    const backgroundsDir = path.join(process.cwd(), 'assets', 'backgrounds');
    const filenames = (await fs.readdir(backgroundsDir))
      .filter((filename) => BACKGROUND_FILE_PATTERN.test(filename))
      .sort(
        (a, b) => this.getBackgroundNumber(a) - this.getBackgroundNumber(b),
      );

    if (filenames.length === 0) {
      throw new Error(`No background files found in ${backgroundsDir}`);
    }

    return filenames;
  }

  private getBackgroundNumber(filename: string): number {
    return Number(filename.match(/\d+/)?.[0] ?? 0);
  }
}
