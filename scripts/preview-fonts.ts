import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PosterService } from '../src/poster/poster.service';
import { FONTS } from '../src/poster/fonts.const';
import * as dotenv from 'dotenv';

dotenv.config();

const COUNT = 1;
const BACKGROUND_FILE = 'bg-1.png';

function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-');
}

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

  const bgPath = path.join(
    process.cwd(),
    'assets',
    'backgrounds',
    BACKGROUND_FILE,
  );
  const outDir = path.join(process.cwd(), 'assets', 'debug');
  await fs.mkdir(outDir, { recursive: true });

  console.log(
    `Generating ${FONTS.length} font previews with ${matches.length} match(es) using ${BACKGROUND_FILE}:\n`,
  );

  for (const font of FONTS) {
    const stubFontService = {
      getNextFont: () => Promise.resolve({ family: font.family }),
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const posterService = new PosterService(stubFontService as any);
    const buffer = await posterService.generate(matches, bgPath);

    const fileName = `preview-font-${slugify(font.family)}.jpg`;
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
