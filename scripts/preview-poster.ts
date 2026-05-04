import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PosterService } from '../src/poster/poster.service';
import { POSTER_CONFIG } from '../src/poster/poster.config';
import * as dotenv from 'dotenv';

dotenv.config();

const COUNT = 1;
const BACKGROUND_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();

  let matches = await prisma.match.findMany({
    where: { status: 'NS' },
    orderBy: { kickoffTime: 'asc' },
    take: COUNT,
  });

  if (matches.length === 0) {
    console.log(
      'No upcoming matches found, falling back to most recent matches...',
    );
    matches = await prisma.match.findMany({
      orderBy: { kickoffTime: 'desc' },
      take: COUNT,
    });
  }

  if (matches.length === 0) {
    console.error('No matches in the database. Run the football sync first.');
    process.exit(1);
  }

  const bgDir = path.join(process.cwd(), 'assets', 'backgrounds');
  const outDir = path.join(process.cwd(), 'assets', 'debug');
  await fs.mkdir(outDir, { recursive: true });

  const backgroundFiles = (await fs.readdir(bgDir))
    .filter((file) =>
      BACKGROUND_EXTENSIONS.has(path.extname(file).toLowerCase()),
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (backgroundFiles.length === 0) {
    console.error(`No background images found in ${bgDir}`);
    process.exit(1);
  }

  const stubFontService = {
    getNextFont: async () => ({ family: POSTER_CONFIG.font.family }),
  };

  console.log(
    `Generating ${backgroundFiles.length} background previews with ${matches.length} match(es) using ${POSTER_CONFIG.font.family}:\n`,
  );

  for (const backgroundFile of backgroundFiles) {
    const bgPath = path.join(bgDir, backgroundFile);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const posterService = new PosterService(stubFontService as any);
    const buffer = await posterService.generate(matches, bgPath);

    const slug = path.parse(backgroundFile).name.toLowerCase();
    const fileName = `preview-background-${slug}.jpg`;
    const outPath = path.join(outDir, fileName);
    await fs.writeFile(outPath, buffer);
    console.log(`  saved: ${fileName}`);
  }

  console.log('\nDone.');
  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
