# Sasson Bot — Developer & Agent Onboarding Guide

> Complete reference for any developer or AI agent working in this repository for the first time.  
> Keep this document up to date as the project evolves.

---

## Table of Contents

1. [What This Is](#what-this-is)
2. [Tech Stack](#tech-stack)
3. [Two-Bot Setup (Local vs. Production)](#two-bot-setup-local-vs-production)
4. [External API Keys & Billing](#external-api-keys--billing)
5. [Module Architecture](#module-architecture)
6. [Data Models](#data-models)
7. [Core Flows](#core-flows)
8. [Bot Commands](#bot-commands)
9. [Environment Variables](#environment-variables)
10. [Local Development](#local-development)
11. [Deployment (Railway)](#deployment-railway)
12. [Current State vs. Original Architecture Plan](#current-state-vs-original-architecture-plan)
13. [Next Steps](#next-steps)

---

## What This Is

A NestJS Telegram bot for **Sasson Sport Bar**. It:

- Fetches football match schedules from the Sports API and stores them in PostgreSQL
- Lets admins generate AI-powered promotional captions (Hebrew + English) for upcoming matches via Groq LLM
- Composes poster images (1080×1920 JPEG) using Sharp — team logos, match info, rotating background images
- Sends daily and weekly digests to admin users via Telegram
- Uses BullMQ + Redis to run AI generation tasks asynchronously with retry logic

The HTTP server exists only for health checks. The bot runs as a long-polling Telegram client, not a webhook.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Framework | NestJS 10 |
| Database | PostgreSQL 16 via Prisma ORM + `@prisma/adapter-pg` |
| Cache / Queue | Redis 7 + BullMQ + ioredis |
| Telegram | Telegraf (long-polling, `bot.launch()`) |
| AI Text | Groq SDK — `llama-3.3-70b-versatile` |
| AI Image | fal.ai FLUX (installed, not yet wired) |
| Image Composition | Sharp — composites background + logos + SVG overlays |
| Sports Data | API-Football v3 (api-sports.io) |
| Deployment | Railway (prod) / Docker Compose (local) |
| Font | Oswald-Bold (loaded from `assets/fonts/` as base64) |

---

## Two-Bot Setup (Local vs. Production)

**This project runs two separate Telegram bots with two separate bot tokens — one for local development and one for production on Railway.**

Because this bot uses long-polling (not webhooks), any running instance actively pulls updates from Telegram's servers. If two instances share the same token and run simultaneously, they compete for updates — each message is delivered to only one of them at random, making both unreliable. To avoid this, a dedicated development bot was created via [@BotFather](https://t.me/BotFather) for local use. The production bot token lives only in Railway's environment variables and is never committed to the repository. The local `.env` file holds the dev bot token. This means you can run `npm run start:dev` locally at any time without affecting production users or disrupting the Railway deployment.

- **Local dev bot token** → `.env` → `TELEGRAM_BOT_TOKEN`
- **Production bot token** → Railway env vars → `TELEGRAM_BOT_TOKEN`

Never swap these. Never run both environments with the same token at the same time.

---

## External API Keys & Billing

### API-Football (api-sports.io)

The Sports API subscription is currently on a **paid monthly plan**. It requires **manual renewal** — there is no auto-renewal configured. If the subscription lapses, `syncWeeklyGames()` will fail silently and the match database will go stale.

- Check renewal at [api-sports.io](https://api-sports.io) dashboard
- The key is stored as `SPORTS_API_KEY` in env vars
- Base URL: `https://v3.football.api-sports.io`
- Cron sync runs every Saturday at 09:00 — if the key is expired, that is the first place it will surface

### Groq

Free tier with generous limits. Key is `GROQ_API_KEY`. Model: `llama-3.3-70b-versatile`.

### fal.ai

Key is `FAL_KEY`. Model config: `FAL_MODEL=fal-ai/flux/schnell`. The fal.ai integration is **not yet wired** — the key is in env but no service calls it yet (see [Next Steps](#next-steps)).

---

## Module Architecture

```
AppModule
├── ConfigModule (global)
├── ScheduleModule
├── PrismaModule (global) ← PrismaService injectable everywhere
├── RedisModule (global)  ← RedisService injectable everywhere
├── TelegramModule (global) ← TelegramAdapter injectable everywhere
├── BotModule             ← BotService, command handlers, cron digests
├── FootballModule        ← Sports API sync, match queries
├── DescriptionModule     ← BullMQ queue for AI caption generation
├── PostModule            ← BullMQ queue for poster image generation
├── PosterModule          ← Sharp image composition, background rotation
├── GroqModule            ← Groq SDK wrapper
└── HealthModule          ← GET /health
```

### Channel Adapter Pattern

`ChannelAdapter` (`src/common/interfaces/channel-adapter.interface.ts`) is the abstraction between domain logic and the messaging channel. `TelegramAdapter` is the only implementation. `BotService` only calls adapter methods — it never touches Telegraf directly. A future WhatsApp or web channel would implement the same interface and be swapped in `BotModule` with zero changes to `BotService`.

```typescript
interface ChannelAdapter {
  sendMessage(userId: string, text: string): Promise<void>;
  sendImage(userId: string, imageUrl: string, caption?: string): Promise<void>;
  sendPhoto(userId: string, buffer: Buffer, caption?: string): Promise<string>;
  sendAction(userId: string, action: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onCommand(command: string, handler: CommandHandler): void;
  useGuard(handler: GuardHandler): void;
  setUserCommands(userId: string, isAdmin: boolean): Promise<void>;
}
```

### Queue Architecture

Two BullMQ queues handle async AI jobs:

| Queue | Worker | Task |
|---|---|---|
| `description` | `DescriptionProcessor` | Generate Groq caption for a match → save to DB → send to user |
| `post` | `PostProcessor` | Compose poster image via Sharp → send via Telegram → save file_id |

Both queues: 2 retry attempts, 5-second backoff. On final failure, the worker sends an error message to the requesting user via Telegram.

---

## Data Models

```
User          — telegramId (unique), isAdmin, createdAt
Bar           — name, telegramId (unique), createdAt
Match         — apiId (unique), homeTeam, awayTeam, logos, league, kickoffTime, matchDate, status
Description   — matchId (FK → Match), caption, createdAt
Post          — postDate, telegramFileId, createdAt
Background    — filename (unique), lastUsedDate (rotates daily)
League        — apiId (unique), seasonApiId
```

Migrations live in `prisma/migrations/`. After any schema change run:

```bash
npx prisma migrate dev --name <description>
npx prisma generate
```

---

## Core Flows

### 1. Match Sync (Automated)

```
Cron: every Saturday 09:00
  → FootballService.syncWeeklyGames()
  → Sports API: fetch fixtures for FAVORITE_LEAGUES
  → Filter by team/round allowlists
  → Upsert into Match table
  → Delete past matches
```

Manual trigger: `GET /football/sync`

### 2. User Registration

```
User sends /start
  → BotService checks User table (telegramId)
  → If new: prompt for admin code
    → User sends code → compare with ADMIN_CODE env var (Redis-cached state, TTL 120s)
    → If match: create User(isAdmin=true), update command menu
    → If no match: create User(isAdmin=false), update command menu
  → If existing: greet and proceed
```

### 3. AI Caption Generation

```
Admin sends /admin_generate_description
  → BotService prompts: "send match number"
  → Admin sends number → Redis stores pending state (TTL 600s)
  → DescriptionService.enqueueDescription(matchId, userId)
  → BullMQ picks up job
  → DescriptionProcessor:
      → Fetch Match from DB
      → Build prompt via match-prompt.utils.ts
      → GroqService.generate(userContent, systemPrompt)
      → Save to Description table
      → TelegramAdapter.sendMessage(userId, caption)
```

### 4. Poster Image Generation

```
Admin sends /admin_generate_post
  → BotService prompts: "select match IDs"
  → Admin sends IDs → Redis stores pending state
  → PostService.enqueuePost(matchIds, userId)
  → BullMQ picks up job
  → PostProcessor:
      → Fetch matches from DB
      → BackgroundService.getNextBackground() — rotates bg-1/2/3 daily
      → PosterService.generate(matches, backgroundPath)
          → Sharp: resize bg to 1080×1920
          → Add 62% black overlay
          → For each match: fetch team logos, build SVG with "VS" + kickoff time
          → Composite all layers
          → Return JPEG buffer (quality 92)
      → TelegramAdapter.sendPhoto(userId, buffer) → returns telegram file_id
      → Save Post record with file_id + Israeli date
```

### 5. Admin Digests (Automated)

| Cron | Method | Content |
|---|---|---|
| Daily 13:00 | `sendDailyAdminDigest()` | Today's matches formatted by league |
| Saturday 16:00 | `sendWeeklyAdminDigest()` | Full week matches grouped by day + league |

---

## Bot Commands

### User Commands

| Command | Description |
|---|---|
| `/start` | Register or greet, triggers admin code flow if new user |
| `/games_today` | Today's matches (Israeli timezone) |
| `/games_week` | Matches from today through next Saturday |
| `/games_next_week` | Matches from next Sunday to following Saturday |

### Admin-Only Commands

| Command | Description |
|---|---|
| `/admin_sync_matches` | Manually trigger Sports API sync |
| `/admin_load_favorite_leagues` | Upsert FAVORITE_LEAGUES into League table |
| `/admin_generate_description` | Start AI caption generation flow |
| `/admin_generate_post` | Start poster image generation flow |

Command menus are set per-user based on `isAdmin` flag via `TelegramAdapter.setUserCommands()`.

---

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | `postgresql://sasson:sasson@localhost:5432/sasson` |
| `REDIS_URL` | Yes | `redis://localhost:6379` |
| `TELEGRAM_BOT_TOKEN` | Yes | Dev token locally, prod token on Railway |
| `PORT` | No | Defaults to 3000 |
| `SPORTS_API_KEY` | Yes | api-sports.io key — see billing note above |
| `SPORTS_API_BASE_URL` | Yes | `https://v3.football.api-sports.io` |
| `ADMIN_CODE` | Yes | Secret code users enter to gain admin status |
| `GROQ_API_KEY` | Yes | Groq LLM key |
| `FAL_KEY` | No | fal.ai key — not yet used in code |
| `FAL_MODEL` | No | `fal-ai/flux/schnell` |

---

## Local Development

Docker services (Postgres, Redis, RedisInsight) are configured in `docker-compose.yml`. The NestJS app runs locally, not in Docker.

```bash
# Start infrastructure
docker compose up -d

# Start NestJS in watch mode
npm run start:dev

# Open Prisma Studio (database GUI)
npx prisma studio

# Health check
curl http://localhost:3000/health

# Manual match sync
curl http://localhost:3000/football/sync
```

RedisInsight GUI: `http://localhost:8001`

Assets that must exist locally:
- `assets/backgrounds/bg-1.png`, `bg-2.png`, `bg-3.png` — poster backgrounds (not committed to git, add manually)
- `assets/fonts/Oswald-Bold.ttf` — poster font (not committed, add manually)

---

## Deployment (Railway)

- **Platform:** Railway
- **Services:** NestJS app + PostgreSQL plugin + Redis plugin — all in one Railway project
- **Deploy trigger:** git push to main branch
- **Build:** `npm run build` → `dist/main.js`
- **Start command:** `node dist/main`
- **Environment vars:** set in Railway dashboard (never in git)
- **Health check:** Railway polls `GET /health`

The `app` service in `docker-compose.yml` is intentionally commented out — it is only used as documentation reference for Railway's expected environment.

---

## Current State vs. Original Architecture Plan

The `architecture.md` file defined a 4-sprint roadmap. Here is where the project stands:

| Sprint | Planned | Status |
|---|---|---|
| 1 | NestJS skeleton, Telegram, channel adapter, Prisma schema, health check | **Complete** |
| 2 | Sports API, "games today/week" commands, match persistence | **Complete** |
| 3 | Claude AI text, fal.ai images, BullMQ workers, Cloudinary | **Partially complete** — Groq replaces Anthropic Claude, Sharp replaces Cloudinary for image composition, BullMQ workers are live; fal.ai AI image generation not yet wired |
| 4 | Cron auto-posts, Redis caching, monitoring + retry dashboards | **Partially complete** — cron digests are live, Redis used for session state; auto-post scheduling and BullMQ dashboard not yet implemented |

**Deviations from original plan:**

- **Groq instead of Anthropic Claude** for text generation (faster, free tier)
- **Sharp (local image composition) instead of fal.ai** for poster generation — team logos + match info are composited directly; fal.ai AI-generated imagery is planned but not implemented
- **No Cloudinary** — poster images are sent directly as Telegram file buffers; `telegramFileId` is stored for re-use
- **No BullMQ dashboard** wired yet

---

## Next Steps

The following features are planned but not yet implemented:

1. **fal.ai AI image generation** — integrate `FAL_KEY` and `FAL_MODEL` into poster generation pipeline. The current poster uses Sharp composition with static backgrounds; fal.ai would generate the background itself from a match-based prompt.

2. **Automated scheduled posting** — cron job that automatically generates and sends a poster + caption to a Telegram channel on match days, without admin trigger.

3. **Redis caching for Sports API** — cache match data in Redis to reduce API calls between weekly syncs. Important given the paid monthly quota.

4. **BullMQ dashboard** — wire up Bull Board or similar for job visibility (pending, active, failed states).

5. **Telegram channel posting** — current flow posts only to admin users. Extend `ChannelAdapter` to post to a public/private Telegram channel.

6. **Font asset** — `assets/fonts/Oswald-Bold.ttf` must be present for posters to render correctly. Ensure it is added to the Railway deployment (committed to git or added via Railway volume).

7. **Background images** — `assets/backgrounds/bg-1.png` through `bg-3.png` must also be present in production. Verify they are committed or otherwise available in Railway's filesystem.
