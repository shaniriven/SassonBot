import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTIVE_FONT_FAMILIES,
  DEFAULT_FONT_FAMILY,
  FONTS,
} from './fonts.const';

@Injectable()
export class FontService implements OnModuleInit {
  private readonly logger = new Logger(FontService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.font.deleteMany({
      where: { family: { notIn: ACTIVE_FONT_FAMILIES } },
    });

    for (const font of FONTS) {
      await this.prisma.font.upsert({
        where: { family: font.family },
        update: {},
        create: { family: font.family },
      });
    }
    this.logger.log(`Font records synced: ${ACTIVE_FONT_FAMILIES.join(', ')}`);
  }

  async getNextFont(): Promise<{ family: string }> {
    const fonts = await this.prisma.font.findMany({
      where: { family: { in: ACTIVE_FONT_FAMILIES } },
    });

    if (fonts.length === 0) throw new Error('No fonts found in DB');

    const lastUsedFont = await this.prisma.font.findFirst({
      where: {
        family: { in: ACTIVE_FONT_FAMILIES },
        lastUsedDate: { not: null },
      },
      orderBy: { lastUsedDate: 'desc' },
    });

    const defaultFont = fonts.find(
      (font) => font.family === DEFAULT_FONT_FAMILY,
    );
    const candidates = lastUsedFont
      ? fonts.filter((font) => font.family !== lastUsedFont.family)
      : defaultFont
        ? [defaultFont]
        : fonts;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];

    await this.prisma.font.update({
      where: { id: chosen.id },
      data: { lastUsedDate: new Date().toISOString() },
    });

    return { family: chosen.family };
  }
}
