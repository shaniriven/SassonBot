# Implementation Notes — Sasson Bot

## What's built

Football match notifications for a sports bar Telegram bot. Users query matches from the database; admins trigger data sync from an external API.

---

## Feature: Match Commands (3 user commands)

| Command | Handler | Service method |
|---|---|---|
| `/games_today` | `BotService` | `FootballService.getTodayMatches()` |
| `/games_week` | `BotService` | `FootballService.getWeekMatches()` |
| `/games_next_week` | `BotService` | `FootballService.getNextWeekMatches()` |

All queries hit the local **`Match` table** — they never call the external API at read time. Date boundaries use Israeli timezone (`Asia/Jerusalem`) via `src/common/utils/date.util.ts`.

Display format:
- Today → grouped by league, one match per line with flag emoji + kickoff time
- Week / Next week → grouped by day, then by league within each day

---

## Feature: Admin Commands (2 commands)

| Command | Effect |
|---|---|
| `/admin_sync_matches` | Calls `FootballService.manualSync()` → fetches fixtures from football-api-sports.io for every league in the DB, filters by configured teams/rounds, upserts into `Match` |
| `/admin_load_favorite_leagues` | Calls `FootballService.syncLeagues()` → seeds the `League` table from `leagues.const.ts` |

No auth guard is on these commands yet — any user can call them. Add a guard before going to production.

**Automated sync**: `FootballService.syncWeeklyGames()` runs via `@Cron('0 9 * * 6')` every Saturday at 09:00 to pre-load the coming week.

---

## Module layout

```
AppModule
├── FootballModule          # API sync + DB queries
│   ├── FootballService     # core logic
│   ├── FootballController  # REST: GET /football/sync, /football/sync-leagues
│   └── HttpModule          # @nestjs/axios for API calls
└── BotModule               # Telegram
    ├── TelegramAdapter     # implements ChannelAdapter
    └── BotService          # registers all /commands, formats output
```

`BotModule` imports `FootballModule` so `BotService` can inject `FootballService` directly.

---

## Data layer

**Match** table is the source of truth for query commands.

```
Match { id, apiId (unique), homeTeam, awayTeam, league, kickoffTime, matchDate, status }
League { id, apiId (unique), seasonApiId }
```

Sync uses `upsert` on `apiId` — safe to re-run without duplicates.

---

## Constants (src/football/const/)

| File | Contents |
|---|---|
| `leagues.const.ts` | 14 leagues with `id_league`, `id_season`, `countryFlag`, optional `teams`/`rounds` filters |
| `teams.const.ts` | Team ID lists per league (La Liga, Serie A, Bundesliga) |
| `rounds.const.ts` | Cup round identifiers (Last 16, QF, SF, Final) |
| `country-flag.const.ts` | Country → flag emoji map |
| `football-api.const.ts` | Base URL `https://v3.football.api-sports.io` |

To add a league: add an entry to `leagues.const.ts`, run `/admin_load_favorite_leagues`, then `/admin_sync_matches`.

---

## Channel adapter pattern

`src/common/interfaces/channel-adapter.interface.ts` defines the contract between `BotService` and the messaging platform:

```
ChannelAdapter (interface)
├── sendMessage / sendImage / sendAction   — outbound
├── onCommand / onMessage                  — register handlers
└── useGuard / setUserCommands             — auth + menu visibility
```

`BotService` only depends on `ChannelAdapter` — it never imports Telegraf directly. `TelegramAdapter` is the sole implementation. Adding WhatsApp/Discord means writing a new adapter and swapping it in `BotModule`; `BotService` stays unchanged.

**Handler types** (also in the interface file):
- `CommandHandler` — fired on `/command`
- `MessageHandler` — fired on plain text
- `GuardHandler` — runs before every update; returns an error string to block or `null` to allow

---

## Key utilities

`src/common/utils/date.util.ts` — all date helpers use `Asia/Jerusalem`:
- `toIsraeliDate(d)` → `YYYY-MM-DD`
- `currentSeason()` → football season year (flips in June)
- `getNextSaturday/Sunday/FollowingSaturday()` → date-range boundaries

`src/common/utils/format-matches.util.ts` — pure formatting functions (no side effects):
- `formatMatches(matches, label)` — groups by league, used for `/games_today`
- `formatWeekMatches(matches, label)` — groups by day then league, used for `/games_week` and `/games_next_week`

Both look up country flags via `LEAGUE_FLAGS` from `leagues.const.ts` and fall back to `🏆`.

`src/bot/commands.const.ts` — single source of truth for all command strings and descriptions:
- `CMD` object — each key holds `{ command, description }` used in both handler registration (`BotService`) and Telegram menu setup (`TelegramAdapter`)
- `USER_COMMANDS` / `ADMIN_COMMANDS` arrays — slices of `CMD` passed to `setMyCommands`

---

## What's missing before production

1. **Admin guard** — gate `/admin_*` commands to a known Telegram user ID list
2. **Error handling in sync** — API failures are currently unhandled; add retry + alerting
3. **BullMQ** — installed but not wired; sync could move to a queue job for reliability
4. **Match status updates** — `status` field exists but is not refreshed post-sync
