# Plan: Global Album Generation Mode Setting

## Context
The weekly album generation currently always uses AI to select matches. The admin wants a single global constant they can change to switch between three modes:
- `ai` — AI picks matches (current behavior)
- `auto` — Hardcoded FAVORITE_TEAMS + time filter, no AI (the existing `fallbackGroupByDate` logic)
- `user` — Admin picks matches interactively via a Telegram day-by-day toggle picker before the album is generated

The mode governs both the manual `/generate_album` command and the Friday 11am cron (`sendWeeklyAdminDigest`). In `user` mode the cron immediately sends each admin an interactive picker in their chat.

---

## Files to Change

| File | Type of change |
|---|---|
| `src/football/const/album-settings.const.ts` | Add mode type + constant |
| `src/football/football.service.ts` | Add 3 new public methods |
| `src/common/interfaces/channel-adapter.interface.ts` | Add 2 new method signatures |
| `src/bot/telegram.adapter.ts` | Implement the 2 new adapter methods |
| `src/bot/bot.const.ts` | New types, new TTL entry, 2 new callback prefixes |
| `src/bot/bot.service.ts` | Mode branching, interactive picker flow |

---

## Step-by-step Changes

### 1. `src/football/const/album-settings.const.ts`
Add below the existing constants:
```ts
export type AlbumGenerationMode = 'ai' | 'auto' | 'user';
export const ALBUM_GENERATION_MODE: AlbumGenerationMode = 'ai';
```
**This single line is the global switch.** Change `'ai'` to `'auto'` or `'user'` to change behavior.

---

### 2. `src/football/football.service.ts`
Add three new public methods (keep existing ones unchanged):

```ts
// For user-mode picker: evening matches grouped by date, no AI/favorites filtering
async getWeekMatchesGroupedByDate(forCron = false): Promise<{ date: string; matches: Match[] }[]>
  // Gets all via getWeekMatches() or getWeekMatchesForCron() based on forCron
  // Filters by ALBUM_MIN_KICKOFF_HOUR
  // Groups by matchDate preserving chronological order (Prisma already orders by kickoffTime asc)

// For auto-mode manual trigger: FAVORITE_TEAMS + time filter, no AI
async getWeekAutoMatches(): Promise<{ date: string; matches: Match[]; strongDay: boolean }[]>
  // Calls: this.fallbackGroupByDate(await this.getWeekMatches())

// For auto-mode cron: same but next week
async getWeekAutoMatchesForCron(): Promise<{ date: string; matches: Match[]; strongDay: boolean }[]>
  // Calls: this.fallbackGroupByDate(await this.getWeekMatchesForCron())
```

---

### 3. `src/common/interfaces/channel-adapter.interface.ts`
Add two methods to `ChannelAdapter`:
```ts
editMessageButtons(userId: string, messageId: number, buttons: InlineButton[][]): Promise<void>;
editMessageWithButtons(userId: string, messageId: number, text: string, buttons: InlineButton[][]): Promise<void>;
```
- `editMessageButtons` — refreshes only the keyboard (used on toggle, text stays)
- `editMessageWithButtons` — refreshes both text and keyboard (used on navigation to new day)

---

### 4. `src/bot/telegram.adapter.ts`
Implement both using Telegraf's `bot.telegram` methods:
- `editMessageButtons` → `bot.telegram.editMessageReplyMarkup(userId, messageId, undefined, { inline_keyboard: ... })`
- `editMessageWithButtons` → `bot.telegram.editMessageText(userId, messageId, undefined, text, { reply_markup: { inline_keyboard: ... } })`

---

### 5. `src/bot/bot.const.ts`

**New callback prefixes:**
```ts
export const ALBUM_PICKER_TOGGLE_PREFIX = 'album:toggle:'; // + 'YYYY-MM-DD:<uuid>' = max 60 bytes ✓
export const ALBUM_PICKER_NAV_PREFIX    = 'album:nav:';    // + 'next'|'prev'|'gen'|'cancel'
```

**Add to `BOT_STATE_TTL`:**
```ts
albumPicker: 1800, // 30 minutes — admin may take time going through days
```

**New types:**
```ts
export type AlbumPickerMatch = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoffTime: string; // ISO string, serialized for Redis
};

export type AlbumPickerDay = {
  date: string;           // 'YYYY-MM-DD'
  matches: AlbumPickerMatch[];
  selectedMatchIds: string[];
};

export type PendingAlbumPickerCommand = {
  type: typeof CMD.generateAlbum.command;
  step: 'awaiting_picks';
  messageId: number;
  days: AlbumPickerDay[];
  currentDayIndex: number;
};
```

**Update the union:**
```ts
export type PendingCommand = PendingPostDateCommand | PendingPostMatchesCommand | PendingAlbumPickerCommand;
```

---

### 6. `src/bot/bot.service.ts`

#### 6a. Update `cancelPendingCommand`
Extend the existing cleanup to also handle `generate_album` type — call `removeInlineButtonsSafely` when the pending command is an album picker.

#### 6b. Update `/generate_album` command handler
Branch on `ALBUM_GENERATION_MODE` after the admin auth check:
```
user  → getWeekMatchesGroupedByDate(false) → buildAlbumPickerDays → startAlbumPicker
auto  → getWeekAutoMatches() → existing deliverAlbum path
ai    → getWeekFavoriteTeamMatches() → existing deliverAlbum path (unchanged)
```

#### 6c. Update `sendWeeklyAdminDigest` cron
Branch on `ALBUM_GENERATION_MODE`:
```
user  → getWeekMatchesGroupedByDate(true) → buildAlbumPickerDays
        → for each admin: startAlbumPicker(admin.telegramId, freshDays, true)
        (each admin picks independently, generates their own album)
auto  → getWeekAutoMatchesForCron() → existing notifyAdminsAlbum path
ai    → getWeekFavoriteTeamMatchesForCron() → existing path (unchanged)
```

#### 6d. New private methods to add

**`startAlbumPicker(userId, days, forCron)`**
- Sends first day's picker via `sendMessageWithInlineButtons`
- Stores `PendingAlbumPickerCommand` in Redis with TTL of `BOT_STATE_TTL.albumPicker`
- Uses `setPendingCommand` with a TTL override parameter (add optional `ttlOverride?` to `setPendingCommand`)

**`buildAlbumPickerDays(grouped)`**
- Converts `{ date, matches: Match[] }[]` to `AlbumPickerDay[]`
- Serializes `kickoffTime` to ISO string, starts `selectedMatchIds: []`

**`buildAlbumPickerText(days, index)`**
Returns:
```
Saturday, 18 May (day 1 of 3)
Select the matches for this day's poster:
```

**`buildAlbumPickerKeyboard(days, index)`**
Returns `InlineButton[][]`:
- One row per match: `☐ HomeTeam vs AwayTeam HH:MM` or `☑ ...`
  - callback: `album:toggle:YYYY-MM-DD:<matchId>`
- Bottom nav row:
  - `← Back` if `index > 0` (callback: `album:nav:prev`)
  - `Next →` if not last day (callback: `album:nav:next`)
  - `Generate Album` if last day (callback: `album:nav:gen`)
  - `Cancel` always (callback: `album:nav:cancel`)

**`handleAlbumPickerToggle(userId, callbackData, messageId, answerCallback)`**
1. Acquire lock
2. Load state from Redis; if null → `answerCallback('Session expired. Run /generate_album again.')`, removeInlineButtonsSafely, return
3. Validate `messageId === state.messageId`
4. Parse: after stripping prefix, date = first 10 chars, matchId = chars after index 11
5. Toggle the matchId in `days[currentDayIndex].selectedMatchIds`
6. Write updated state back with same TTL
7. `editMessageButtons` with rebuilt keyboard
8. `answerCallback()`

**`handleAlbumPickerNav(userId, callbackData, messageId, answerCallback)`**
Parse nav type and branch:

- **`cancel`**: delete Redis key, removeInlineButtonsSafely, sendMessage 'Album generation cancelled.'
- **`prev`**: decrement `currentDayIndex`, write Redis, `editMessageWithButtons`
- **`next`**: validate ≥1 selection on current day (else `answerCallback('Select at least one match')`), increment index, write Redis, `editMessageWithButtons`
- **`gen`**: validate ≥1 selection on last day, delete Redis key, removeInlineButtonsSafely, build `favoritesByDate` from all days' selections, call `deliverAlbum`

When building `favoritesByDate` for `deliverAlbum`:
```ts
const favoritesByDate = state.days.map((day) => ({
  date: day.date,
  matches: day.matches
    .filter((m) => day.selectedMatchIds.includes(m.id))
    .map((m) => ({ ...m, kickoffTime: new Date(m.kickoffTime) })) as Match[],
  strongDay: day.selectedMatchIds.length >= 2,
}));
```

#### 6e. Extend `handleCallbackQuery` routing
Add two new branches before the final `answerCallback()` fallthrough:
```ts
if (callbackData.startsWith(ALBUM_PICKER_TOGGLE_PREFIX)) → handleAlbumPickerToggle
if (callbackData.startsWith(ALBUM_PICKER_NAV_PREFIX))    → handleAlbumPickerNav
```

---

## Key Edge Cases

- **TTL expiry**: both toggle and nav handlers check for null state and answer with session-expired message + removeInlineButtonsSafely
- **Stale messageId**: toggle handler validates `messageId === state.messageId` and ignores if mismatched
- **Cron + multiple admins**: each admin gets independent Redis key and independent picker; each generates their own album on confirm
- **Single-day week**: no Back/Next buttons, only Generate + Cancel — `buildAlbumPickerKeyboard` handles this naturally
- **New `/generate_album` while picker open**: `cancelPendingCommand` (called at top of handler) now handles `generate_album` type, removes the old keyboard

---

## Verification

1. **Mode switch works**: Change `ALBUM_GENERATION_MODE` to `'auto'`, run `/generate_album` — should generate without AI. Change to `'ai'` — AI call fires.
2. **User-mode manual**: Change to `'user'`, run `/generate_album` — picker message appears with day 1's matches as toggle buttons.
3. **Toggle**: Tap a match — keyboard updates immediately showing `☑`, no new message sent.
4. **Navigate**: Tap Next — message text changes to day 2, new matches shown. Tap Back — returns to day 1 with previous selections preserved.
5. **Generate**: On last day, tap Generate Album — album image(s) sent, picker message buttons removed.
6. **Enforcement**: Tap Next with nothing selected — toast shows "Select at least one match", no navigation.
7. **Cancel**: Tap Cancel — buttons removed, cancellation message sent.
8. **Cron user-mode**: Manually invoke `sendWeeklyAdminDigest` — each admin receives the picker for next week's matches.
9. **TTL test**: Let picker sit idle >30 min, tap a button — "Session expired" toast, buttons removed.
