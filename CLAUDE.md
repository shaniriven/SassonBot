# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (requires Docker services running)
docker compose up -d          # start Postgres + Redis + RedisInsight
npm run start:dev             # run NestJS in watch mode

# Database
npx prisma migrate dev --name <name>   # create and apply a migration
npx prisma generate                    # regenerate Prisma client after schema changes
npx prisma studio                      # open Prisma GUI

# Build & quality
npm run build                 # compile TypeScript to dist/
npm run lint                  # ESLint with auto-fix
npm run format                # Prettier

# Tests
npm test                      # all unit tests (jest, rootDir: src)
npm test -- --testPathPattern=bot   # single module
npm run test:cov              # coverage report
npm run test:e2e              # e2e (test/jest-e2e.json config)
```

Health check endpoint: `GET http://localhost:3000/health`

## Local environment

Docker services and `TELEGRAM_BOT_TOKEN` are already configured and running. You can assume `npm run start:dev` and `GET http://localhost:3000/health` work without any setup steps.

## Architecture

The app is a NestJS Telegram bot for a sports bar. It uses long-polling (Telegraf `bot.launch()`), not webhooks. The HTTP server exists only for the health endpoint.

### Module layout

| Module | Role |
|--------|------|
| `AppModule` | Root — wires ConfigModule (global), PrismaModule, BotModule, HealthModule |
| `PrismaModule` | `@Global()` — PrismaService is available everywhere without re-importing |
| `BotModule` | TelegramAdapter + BotService |
| `HealthModule` | `GET /health` via Terminus + custom Prisma indicator |

### Channel adapter pattern

`ChannelAdapter` (`src/common/interfaces/channel-adapter.interface.ts`) abstracts the messaging channel. `TelegramAdapter` is the only implementation so far. `BotService` registers command and message handlers via `onCommand` / `onMessage` — it never touches Telegraf directly. New channels (e.g. WhatsApp) should implement `ChannelAdapter` and be swapped in `BotModule`.

### Data layer

`PrismaService` extends `PrismaClient` and uses the `@prisma/adapter-pg` driver adapter (node-postgres pool) instead of the default binary engine — set via `new PrismaPg(pool)` in the constructor. The `DATABASE_URL` must point to the Postgres instance from `docker-compose.yml`.

BullMQ + ioredis are installed and ready but not yet wired into any module.

### Environment variables (see `.env.example`)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | `postgresql://sasson:sasson@localhost:5432/sasson` |
| `REDIS_URL` | `redis://localhost:6379` |
| `TELEGRAM_BOT_TOKEN` | Required — bot won't start without it |
| `PORT` | HTTP server port, defaults to 3000 |

### Docker services

`docker-compose.yml` runs Postgres 16, Redis 7 (with `--save 60 1` persistence), and RedisInsight (port 8001). The `app` service is commented out — the NestJS process runs locally via `npm run start:dev`.
