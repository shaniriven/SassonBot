import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PosterService } from '../src/poster/poster.service';
import { POSTER_CONFIG } from '../src/poster/poster.config';
import * as dotenv from 'dotenv';

dotenv.config();

const COUNTS = [1, 2, 3, 4, 5];
const BACKGROUND_FILE = 'bg-1.png';

async function getMatches(prisma: PrismaClient, count: number) {
  let matches = await prisma.match.findMany({
    where: { status: 'NS' },
    orderBy: { kickoffTime: 'asc' },
    take: count,
  });

  if (matches.length < count) {
    console.log(
      `Only found ${matches.length} upcoming match(es), falling back to most recent matches...`,
    );
    matches = await prisma.match.findMany({
      orderBy: { kickoffTime: 'desc' },
      take: count,
    });
  }

  return matches;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();

  const bgPath = path.join(
    process.cwd(),
    'assets',
    'backgrounds',
    BACKGROUND_FILE,
  );
  const outDir = path.join(process.cwd(), 'assets', 'debug');
  await fs.mkdir(outDir, { recursive: true });

  const stubFontService = {
    getNextFont: () =>
      Promise.resolve({ family: POSTER_CONFIG.font.family }),
  };

  console.log(
    `Generating match-count previews using ${BACKGROUND_FILE} and ${POSTER_CONFIG.font.family}:\n`,
  );

  for (const count of COUNTS) {
    const matches = await getMatches(prisma, count);

    if (matches.length === 0) {
      console.error('No matches in the database. Run the football sync first.');
      process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const posterService = new PosterService(stubFontService as any);
    const buffer = await posterService.generate(matches, bgPath);

    const fileName = `preview-count-${count}-games.jpg`;
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
