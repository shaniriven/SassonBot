import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import * as dotenv from 'dotenv';
import { FONTS } from '../src/poster/fonts.const';

dotenv.config();

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();

  await prisma.font.deleteMany();

  for (const font of FONTS) {
    await prisma.font.create({
      data: { family: font.family },
    });
  }

  console.log(
    `Reset ${FONTS.length} fonts: ${FONTS.map((f) => f.family).join(', ')}`,
  );

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
