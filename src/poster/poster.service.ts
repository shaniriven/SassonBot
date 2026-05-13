import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { Match } from '@prisma/client';
import { POSTER_CONFIG, HEADLINER_POSTER_CONFIG } from './poster.config';
import { FontService } from './font.service';
import { FONTS } from './fonts.const';
import { getIsraeliTimeMinutes } from '../common/utils/date.util';

for (const font of FONTS) {
  GlobalFonts.registerFromPath(font.woffPath, font.family);
}

@Injectable()
export class PosterService {
  private readonly logger = new Logger(PosterService.name);

  constructor(private readonly fontService: FontService) {}

  async generate(
    matches: Match[],
    backgroundPath: string,
    headlinerId?: string,
  ): Promise<Buffer> {
    const byKickoff = [...matches].sort(
      (a, b) =>
        getIsraeliTimeMinutes(a.kickoffTime) -
        getIsraeliTimeMinutes(b.kickoffTime),
    );
    const sorted = headlinerId
      ? [
          ...byKickoff.filter((m) => m.id === headlinerId),
          ...byKickoff.filter((m) => m.id !== headlinerId),
        ].slice(0, 5)
      : byKickoff.slice(0, 5);
    const { poster, overlay, logo, font } = POSTER_CONFIG;

    const backgroundBuffer = await sharp(backgroundPath)
      .resize(poster.width, poster.height, { fit: 'cover', position: 'centre' })
      .toBuffer();

    const overlayBuffer = await sharp({
      create: {
        width: poster.width,
        height: poster.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: overlay.opacity },
      },
    })
      .png()
      .toBuffer();

    const { family: fontFamily } = await this.fontService.getNextFont();

    const composites: sharp.OverlayOptions[] = [
      { input: overlayBuffer, top: 0, left: 0 },
    ];

    const isHeadlinerMode = !!headlinerId;
    const gap = isHeadlinerMode
      ? HEADLINER_POSTER_CONFIG.gap
      : POSTER_CONFIG.row.gap;

    const rowConfigs = sorted.map((m) => {
      if (!isHeadlinerMode) {
        return {
          logoSize: logo.size,
          rowHeight: POSTER_CONFIG.row.height,
          centerWidth: POSTER_CONFIG.center.width,
          vsSize: font.vsSize,
          timeSize: font.timeSize,
          vsTimeGap: font.vsTimeGap,
        };
      }
      const cfg =
        m.id === headlinerId
          ? HEADLINER_POSTER_CONFIG.headliner
          : HEADLINER_POSTER_CONFIG.regular;
      return {
        logoSize: cfg.logoSize,
        rowHeight: cfg.rowHeight,
        centerWidth: cfg.centerWidth,
        vsSize: cfg.vsSize,
        timeSize: cfg.timeSize,
        vsTimeGap: cfg.vsTimeGap,
      };
    });

    let totalGaps = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const isHeadlinerRow = isHeadlinerMode && sorted[i].id === headlinerId;
      totalGaps += isHeadlinerRow ? HEADLINER_POSTER_CONFIG.headlinerGap : gap;
    }
    const blockHeight =
      rowConfigs.reduce((sum, c) => sum + c.rowHeight, 0) + totalGaps;
    const rowStartY = Math.round((poster.height - blockHeight) / 2);

    let rowY = rowStartY;
    for (let i = 0; i < sorted.length; i++) {
      const match = sorted[i];
      const { logoSize, rowHeight, centerWidth, vsSize, timeSize, vsTimeGap } =
        rowConfigs[i];

      const logoTop = rowY + Math.round((rowHeight - logoSize) / 2);
      const homeLogoLeft = logo.sidePadding;
      const awayLogoLeft = poster.width - logo.sidePadding - logoSize;
      const centerLeft = Math.round((poster.width - centerWidth) / 2);

      const [homeLogoBuffer, awayLogoBuffer] = await Promise.all([
        this.fetchLogo(match.homeLogo, logoSize),
        this.fetchLogo(match.awayLogo, logoSize),
      ]);

      const timeStr = match.kickoffTime.toLocaleTimeString('he-IL', {
        timeZone: 'Asia/Jerusalem',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const centerBuffer = this.buildCenterCanvas({
        width: centerWidth,
        height: rowHeight,
        timeStr,
        fontFamily,
        font: { ...font, vsSize, timeSize, vsTimeGap },
      });

      composites.push(
        { input: homeLogoBuffer, top: logoTop, left: homeLogoLeft },
        { input: centerBuffer, top: rowY, left: centerLeft },
        { input: awayLogoBuffer, top: logoTop, left: awayLogoLeft },
      );

      const isHeadlinerRow = isHeadlinerMode && match.id === headlinerId;
      const rowGap: number = isHeadlinerRow
        ? HEADLINER_POSTER_CONFIG.headlinerGap
        : gap;
      rowY += rowHeight + (i < sorted.length - 1 ? rowGap : 0);
    }

    return sharp(backgroundBuffer)
      .composite(composites)
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  private buildCenterCanvas(opts: {
    width: number;
    height: number;
    timeStr: string;
    fontFamily: string;
    font: {
      vsSize: number;
      timeSize: number;
      vsTimeGap: number;
      color: string;
      timeColor: string;
    };
  }): Buffer {
    const { width, height, timeStr, fontFamily, font } = opts;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const centerX = width / 2;
    const getVisualCenterX = (metrics: TextMetrics) =>
      centerX +
      (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    ctx.font = `bold ${font.vsSize}px "${fontFamily}"`;
    const vsMetrics = ctx.measureText('VS');
    const vsAscent = vsMetrics.actualBoundingBoxAscent || font.vsSize;
    const vsDescent = vsMetrics.actualBoundingBoxDescent || 0;
    const vsHeight = vsAscent + vsDescent;

    ctx.font = `bold ${font.timeSize}px "${fontFamily}"`;
    const timeMetrics = ctx.measureText(timeStr);
    const timeAscent = timeMetrics.actualBoundingBoxAscent || font.timeSize;
    const timeDescent = timeMetrics.actualBoundingBoxDescent || 0;
    const timeHeight = timeAscent + timeDescent;

    const gap = font.vsTimeGap;
    const blockHeight = vsHeight + gap + timeHeight;
    const blockTop = Math.max(0, (height - blockHeight) / 2);

    ctx.font = `bold ${font.vsSize}px "${fontFamily}"`;
    ctx.fillStyle = font.color;
    ctx.fillText('VS', getVisualCenterX(vsMetrics), blockTop + vsAscent);

    ctx.font = `bold ${font.timeSize}px "${fontFamily}"`;
    ctx.fillStyle = font.timeColor;
    ctx.fillText(
      timeStr,
      getVisualCenterX(timeMetrics),
      blockTop + vsHeight + gap + timeAscent,
    );

    return canvas.toBuffer('image/png');
  }

  private async fetchLogo(url: string | null, size: number): Promise<Buffer> {
    if (!url) return this.transparentSquare(size);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      return sharp(Buffer.from(arrayBuffer))
        .resize(size, size, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
    } catch (err) {
      this.logger.warn(`Failed to fetch logo ${url}: ${err}`);
      return this.transparentSquare(size);
    }
  }

  private transparentSquare(size: number): Promise<Buffer> {
    return sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  }
}
