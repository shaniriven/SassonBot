import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter';
import { RedisService } from '../redis/redis.service';
import { InlineButton } from '../common/interfaces/channel-adapter.interface';
import { getIsraeliTimeMinutes } from '../common/utils/date.util';
import { LEAGUE_FLAGS } from '../football/const/leagues.const';
import { CMD } from './commands.const';
import {
  AlbumPickerDay,
  BOT_STATE_KEY,
  BOT_STATE_TTL,
  PendingPickerCommand,
  PICKER_NAV_PREFIX,
  PICKER_STRONG_PREFIX,
  PICKER_TOGGLE_PREFIX,
} from './bot.const';

export type PickerOptions = {
  showStrongDay: boolean;
  completeLabel: string;
  source: 'album' | 'post';
};

export type PickerResult =
  | { status: 'done' }
  | {
      status: 'complete';
      days: AlbumPickerDay[];
      source: 'album' | 'post';
    };

@Injectable()
export class MatchPickerService {
  private readonly logger = new Logger(MatchPickerService.name);
  private readonly matchButtonsPerRow = 4;

  constructor(
    private readonly channel: TelegramAdapter,
    private readonly redis: RedisService,
  ) {}

  async startPicker(
    userId: string,
    days: AlbumPickerDay[],
    options: PickerOptions,
  ): Promise<void> {
    const messageId = await this.channel.sendMessageWithInlineButtons(
      userId,
      this.buildPickerText(days, 0),
      this.buildPickerKeyboard(days, 0, options),
    );
    const state: PendingPickerCommand = {
      type:
        options.source === 'album'
          ? CMD.generateAlbum.command
          : CMD.generatePost.command,
      step: 'awaiting_picks',
      messageId,
      days,
      currentDayIndex: 0,
      source: options.source,
      showStrongDay: options.showStrongDay,
      completeLabel: options.completeLabel,
    };
    await this.savePending(userId, state);
  }

  async handleCallback(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<PickerResult | null> {
    if (callbackData.startsWith(PICKER_TOGGLE_PREFIX)) {
      return this.handleToggle(userId, callbackData, messageId, answerCallback);
    }
    if (callbackData.startsWith(PICKER_STRONG_PREFIX)) {
      return this.handleStrong(userId, messageId, answerCallback);
    }
    if (callbackData.startsWith(PICKER_NAV_PREFIX)) {
      return this.handleNav(userId, callbackData, messageId, answerCallback);
    }
    return null;
  }

  buildPickerSummary(days: AlbumPickerDay[]): string {
    const lines: string[] = [];
    for (const d of days) {
      if (d.selectedMatchIds.length === 0 && !d.headlinerId) continue;
      const dayName = new Date(`${d.date}T12:00:00Z`).toLocaleDateString(
        'en-GB',
        { timeZone: 'Asia/Jerusalem', weekday: 'long' },
      );
      const headliner = d.headlinerId
        ? d.matches.find((m) => m.id === d.headlinerId)
        : undefined;
      const matchNames = d.selectedMatchIds
        .map((id) => d.matches.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => `${m!.homeTeam} | ${m!.awayTeam}`)
        .join(', ');
      const parts = [
        headliner
          ? `HEADLINER: ${headliner.homeTeam} | ${headliner.awayTeam}`
          : '',
        matchNames,
      ].filter(Boolean);
      const strong = d.strongDay ? '  ☑ Strong' : '';
      lines.push(`${dayName}: ${parts.join(', ')}${strong}`);
    }
    return lines.join('\n');
  }

  buildPickerText(
    days: AlbumPickerDay[],
    index: number,
    opts?: { headlinerPickMode?: boolean },
  ): string {
    const summary = days.length > 1 ? this.buildPickerSummary(days) : '';
    const lines: string[] = summary ? [summary, ''] : [];

    const day = days[index];
    const { headlinerId } = day;
    const dayLabel = new Date(`${day.date}T12:00:00Z`).toLocaleDateString(
      'en-GB',
      {
        timeZone: 'Asia/Jerusalem',
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
      },
    );
    lines.push(`📅 ${dayLabel} (day ${index + 1} of ${days.length})\n`);

    if (headlinerId) {
      const hl = day.matches.find((m) => m.id === headlinerId);
      if (hl) {
        const mins = getIsraeliTimeMinutes(new Date(hl.kickoffTime));
        const hh = Math.floor(mins / 60)
          .toString()
          .padStart(2, '0');
        const mm = (mins % 60).toString().padStart(2, '0');
        lines.push(
          `Headliner: ${hl.homeTeam} | ${hl.awayTeam}  |  ${hh}:${mm}\n`,
        );
      }
    }

    let matchNumber = 1;
    for (const [league, matches] of this.groupMatchesByLeague(day)) {
      const flag = LEAGUE_FLAGS[league] ?? '🏆';
      lines.push(`${flag} ${league} ${flag}`);
      for (const m of matches) {
        const minutes = getIsraeliTimeMinutes(new Date(m.kickoffTime));
        const h = Math.floor(minutes / 60)
          .toString()
          .padStart(2, '0');
        const min = (minutes % 60).toString().padStart(2, '0');
        const isHeadliner = m.id === headlinerId;
        const marker = isHeadliner
          ? '  ★'
          : day.selectedMatchIds.includes(m.id)
            ? '  ✓'
            : '';
        lines.push(
          `${matchNumber}. ${m.homeTeam} | ${m.awayTeam}  |  ${h}:${min}${marker}`,
        );
        matchNumber++;
      }
      lines.push('');
    }

    if (opts?.headlinerPickMode) {
      lines.push('Select the headliner match:');
    } else if (headlinerId) {
      lines.push('Select up to 4 more matches:');
    } else {
      lines.push('Select matches:');
    }
    return lines.join('\n');
  }

  private groupMatchesByLeague(
    day: AlbumPickerDay,
  ): [string, AlbumPickerDay['matches']][] {
    const byLeague = new Map<string, AlbumPickerDay['matches']>();
    for (const m of day.matches) {
      if (!byLeague.has(m.league)) byLeague.set(m.league, []);
      byLeague.get(m.league)!.push(m);
    }
    return [...byLeague.entries()];
  }

  private getDisplayMatches(day: AlbumPickerDay): AlbumPickerDay['matches'] {
    return this.groupMatchesByLeague(day).flatMap(([, matches]) => matches);
  }

  private chunkButtons(buttons: InlineButton[]): InlineButton[][] {
    const rows: InlineButton[][] = [];
    for (let i = 0; i < buttons.length; i += this.matchButtonsPerRow) {
      rows.push(buttons.slice(i, i + this.matchButtonsPerRow));
    }
    return rows;
  }

  buildPickerKeyboard(
    days: AlbumPickerDay[],
    index: number,
    options: Pick<PickerOptions, 'showStrongDay' | 'completeLabel'> & {
      source?: 'album' | 'post';
      headlinerPickMode?: boolean;
    },
  ): InlineButton[][] {
    const day = days[index];
    const { headlinerId } = day;
    const rows: InlineButton[][] = [];

    if (options.showStrongDay && !options.headlinerPickMode) {
      rows.push([
        {
          text: `${day.strongDay ? '☑' : '☐'} Strong Day`,
          callbackData: `${PICKER_STRONG_PREFIX}toggle`,
        },
      ]);
    }

    const displayMatches = this.getDisplayMatches(day);
    if (displayMatches.length > 0) {
      rows.push(
        ...this.chunkButtons(
          displayMatches.map((m, i) => {
            const buttonNumber = i + 1;
            if (m.id === headlinerId) {
              return {
                text: `★`,
                callbackData: `${PICKER_TOGGLE_PREFIX}${m.id}`,
              };
            }
            const selected = day.selectedMatchIds.includes(m.id);
            return {
              text: selected ? `✓ ${buttonNumber}` : `${buttonNumber}`,
              callbackData: `${PICKER_TOGGLE_PREFIX}${m.id}`,
            };
          }),
        ),
      );
    }

    const navRow: InlineButton[] = [
      { text: 'Cancel', callbackData: `${PICKER_NAV_PREFIX}cancel` },
    ];

    if (options.headlinerPickMode) {
      navRow.push({
        text: 'Continue',
        callbackData: `${PICKER_NAV_PREFIX}headliner_continue`,
      });
    } else {
      navRow.push({
        text: headlinerId ? 'Change Headliner' : 'Add Headliner',
        callbackData: `${PICKER_NAV_PREFIX}add_headliner`,
      });
      if (options.source === 'post') {
        navRow.push({
          text: 'Continue',
          callbackData: `${PICKER_NAV_PREFIX}gen`,
        });
      } else {
        if (index > 0) {
          navRow.push({
            text: '← Back',
            callbackData: `${PICKER_NAV_PREFIX}prev`,
          });
        }
        if (index < days.length - 1) {
          navRow.push({
            text: 'Next →',
            callbackData: `${PICKER_NAV_PREFIX}next`,
          });
        } else {
          navRow.push({
            text: options.completeLabel,
            callbackData: `${PICKER_NAV_PREFIX}gen`,
          });
        }
      }
    }
    rows.push(navRow);

    return rows;
  }

  private async handleToggle(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<PickerResult> {
    type Outcome =
      | { action: 'expired'; staleMessageId: number | null }
      | { action: 'mismatch' }
      | { action: 'limit'; callbackText?: string }
      | {
          action: 'toggled';
          msgId: number;
          text: string;
          keyboard: InlineButton[][];
        };

    let outcome: Outcome = { action: 'mismatch' };

    const lockToken = await this.acquireLock(userId);
    if (!lockToken) {
      await answerCallback();
      return { status: 'done' };
    }
    try {
      const pending = await this.getPendingPickerCommand(userId);
      if (!pending) {
        outcome = { action: 'expired', staleMessageId: messageId };
      } else if (messageId !== null && messageId !== pending.messageId) {
        outcome = { action: 'mismatch' };
      } else {
        const matchId = callbackData.slice(PICKER_TOGGLE_PREFIX.length);
        const day = pending.days[pending.currentDayIndex];
        const hlOpts = {
          headlinerPickMode: pending.headlinerPickMode,
        };

        const matchExists = day.matches.some((m) => m.id === matchId);

        if (!matchExists) {
          outcome = {
            action: 'limit',
            callbackText: 'Invalid match selection.',
          };
        } else if (matchId === day.headlinerId) {
          day.headlinerId = undefined;
          await this.savePending(userId, pending);
          outcome = {
            action: 'toggled',
            msgId: pending.messageId,
            text: this.buildPickerText(
              pending.days,
              pending.currentDayIndex,
              hlOpts,
            ),
            keyboard: this.buildPickerKeyboard(
              pending.days,
              pending.currentDayIndex,
              pending,
            ),
          };
        } else if (pending.headlinerPickMode) {
          day.headlinerId = matchId;
          day.selectedMatchIds = day.selectedMatchIds
            .filter((id) => id !== matchId)
            .slice(0, 4);
          await this.savePending(userId, pending);
          outcome = {
            action: 'toggled',
            msgId: pending.messageId,
            text: this.buildPickerText(
              pending.days,
              pending.currentDayIndex,
              hlOpts,
            ),
            keyboard: this.buildPickerKeyboard(
              pending.days,
              pending.currentDayIndex,
              pending,
            ),
          };
        } else {
          const idx = day.selectedMatchIds.indexOf(matchId);
          const maxSelections = day.headlinerId ? 4 : 5;
          if (idx === -1 && day.selectedMatchIds.length >= maxSelections) {
            outcome = {
              action: 'limit',
              callbackText: day.headlinerId
                ? 'Max 4 supporting matches.'
                : 'Max 5 matches per day.',
            };
          } else {
            if (idx === -1) {
              day.selectedMatchIds.push(matchId);
            } else {
              day.selectedMatchIds.splice(idx, 1);
            }
            await this.savePending(userId, pending);
            outcome = {
              action: 'toggled',
              msgId: pending.messageId,
              text: this.buildPickerText(
                pending.days,
                pending.currentDayIndex,
                hlOpts,
              ),
              keyboard: this.buildPickerKeyboard(
                pending.days,
                pending.currentDayIndex,
                pending,
              ),
            };
          }
        }
      }
    } finally {
      await this.releaseLock(userId, lockToken);
    }

    switch (outcome.action) {
      case 'expired':
        if (outcome.staleMessageId !== null) {
          await this.removeButtonsSafely(userId, outcome.staleMessageId);
        }
        await answerCallback('Session expired.');
        return { status: 'done' };
      case 'mismatch':
        await answerCallback();
        return { status: 'done' };
      case 'limit':
        await answerCallback(outcome.callbackText);
        return { status: 'done' };
      case 'toggled':
        await this.editWithButtonsSafely(
          userId,
          outcome.msgId,
          outcome.text,
          outcome.keyboard,
        );
        await answerCallback();
        return { status: 'done' };
    }
  }

  private async handleStrong(
    userId: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<PickerResult> {
    type Outcome =
      | { action: 'expired'; staleMessageId: number | null }
      | { action: 'mismatch' }
      | {
          action: 'toggled';
          msgId: number;
          text: string;
          keyboard: InlineButton[][];
        };

    let outcome: Outcome = { action: 'mismatch' };

    const lockToken = await this.acquireLock(userId);
    if (!lockToken) {
      await answerCallback();
      return { status: 'done' };
    }
    try {
      const pending = await this.getPendingPickerCommand(userId);
      if (!pending) {
        outcome = { action: 'expired', staleMessageId: messageId };
      } else if (messageId !== null && messageId !== pending.messageId) {
        outcome = { action: 'mismatch' };
      } else {
        const day = pending.days[pending.currentDayIndex];
        day.strongDay = !day.strongDay;
        await this.savePending(userId, pending);
        outcome = {
          action: 'toggled',
          msgId: pending.messageId,
          text: this.buildPickerText(pending.days, pending.currentDayIndex, {
            headlinerPickMode: pending.headlinerPickMode,
          }),
          keyboard: this.buildPickerKeyboard(
            pending.days,
            pending.currentDayIndex,
            pending,
          ),
        };
      }
    } finally {
      await this.releaseLock(userId, lockToken);
    }

    switch (outcome.action) {
      case 'expired':
        if (outcome.staleMessageId !== null) {
          await this.removeButtonsSafely(userId, outcome.staleMessageId);
        }
        await answerCallback('Session expired.');
        return { status: 'done' };
      case 'mismatch':
        await answerCallback();
        return { status: 'done' };
      case 'toggled':
        await this.editWithButtonsSafely(
          userId,
          outcome.msgId,
          outcome.text,
          outcome.keyboard,
        );
        await answerCallback();
        return { status: 'done' };
    }
  }

  private async handleNav(
    userId: string,
    callbackData: string,
    messageId: number | null,
    answerCallback: (text?: string) => Promise<void>,
  ): Promise<PickerResult> {
    type Outcome =
      | { action: 'noop'; callbackText?: string }
      | { action: 'expired'; staleMessageId: number | null }
      | { action: 'cancel'; msgId: number; source: 'album' | 'post' }
      | {
          action: 'navigate';
          msgId: number;
          text: string;
          keyboard: InlineButton[][];
        }
      | {
          action: 'gen';
          msgId: number;
          days: AlbumPickerDay[];
          source: 'album' | 'post';
          summary: string;
        };

    let outcome: Outcome = { action: 'noop' };

    const lockToken = await this.acquireLock(userId);
    if (!lockToken) {
      await answerCallback();
      return { status: 'done' };
    }
    try {
      const pending = await this.getPendingPickerCommand(userId);
      if (!pending) {
        outcome = { action: 'expired', staleMessageId: messageId };
      } else if (messageId !== null && messageId !== pending.messageId) {
        outcome = { action: 'noop' };
      } else {
        const navType = callbackData.slice(PICKER_NAV_PREFIX.length);
        const msgId = pending.messageId;
        const { days, source } = pending;
        const idx = pending.currentDayIndex;
        const hlOpts = {
          headlinerPickMode: pending.headlinerPickMode,
        };

        switch (navType) {
          case 'cancel':
            await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
            outcome = { action: 'cancel', msgId, source };
            break;
          case 'prev':
            if (idx === 0) {
              outcome = { action: 'noop' };
            } else {
              pending.currentDayIndex = idx - 1;
              await this.savePending(userId, pending);
              outcome = {
                action: 'navigate',
                msgId,
                text: this.buildPickerText(days, idx - 1, hlOpts),
                keyboard: this.buildPickerKeyboard(days, idx - 1, pending),
              };
            }
            break;
          case 'next':
            if (idx === days.length - 1) {
              outcome = { action: 'noop' };
            } else {
              pending.currentDayIndex = idx + 1;
              await this.savePending(userId, pending);
              outcome = {
                action: 'navigate',
                msgId,
                text: this.buildPickerText(days, idx + 1, hlOpts),
                keyboard: this.buildPickerKeyboard(days, idx + 1, pending),
              };
            }
            break;
          case 'add_headliner':
            pending.headlinerPickMode = true;
            await this.savePending(userId, pending);
            outcome = {
              action: 'navigate',
              msgId,
              text: this.buildPickerText(days, idx, {
                headlinerPickMode: true,
              }),
              keyboard: this.buildPickerKeyboard(days, idx, pending),
            };
            break;
          case 'headliner_continue': {
            if (!days[idx].headlinerId) {
              outcome = {
                action: 'noop',
                callbackText: 'Select a headliner match first.',
              };
            } else {
              pending.headlinerPickMode = false;
              days[idx].selectedMatchIds = days[idx].selectedMatchIds
                .filter((id) => id !== days[idx].headlinerId)
                .slice(0, 4);
              await this.savePending(userId, pending);
              outcome = {
                action: 'navigate',
                msgId,
                text: this.buildPickerText(days, idx),
                keyboard: this.buildPickerKeyboard(days, idx, pending),
              };
            }
            break;
          }
          case 'gen': {
            const hasContent = days.some(
              (d) => d.selectedMatchIds.length > 0 || !!d.headlinerId,
            );
            if (!hasContent) {
              outcome = {
                action: 'noop',
                callbackText: 'Select at least one match.',
              };
            } else {
              const daysWithContent = days.filter(
                (d) => d.selectedMatchIds.length > 0 || !!d.headlinerId,
              );
              await this.redis.del(BOT_STATE_KEY.pendingCommand(userId));
              outcome = {
                action: 'gen',
                msgId,
                days: daysWithContent,
                source,
                summary: this.buildPickerSummary(daysWithContent),
              };
            }
            break;
          }
          default:
            outcome = { action: 'noop' };
        }
      }
    } finally {
      await this.releaseLock(userId, lockToken);
    }

    switch (outcome.action) {
      case 'noop':
        await answerCallback(outcome.callbackText);
        return { status: 'done' };
      case 'expired':
        if (outcome.staleMessageId !== null) {
          await this.removeButtonsSafely(userId, outcome.staleMessageId);
        }
        await answerCallback('Session expired.');
        return { status: 'done' };
      case 'cancel':
        await this.removeButtonsSafely(userId, outcome.msgId);
        await answerCallback();
        await this.channel.sendMessage(
          userId,
          outcome.source === 'album'
            ? 'Album generation cancelled.'
            : 'Post generation cancelled.',
        );
        return { status: 'done' };
      case 'navigate':
        await this.editWithButtonsSafely(
          userId,
          outcome.msgId,
          outcome.text,
          outcome.keyboard,
        );
        await answerCallback();
        return { status: 'done' };
      case 'gen':
        if (outcome.source === 'post') {
          await this.removeButtonsSafely(userId, outcome.msgId);
        } else {
          await this.editTextSafely(userId, outcome.msgId, outcome.summary);
        }
        await answerCallback();
        return {
          status: 'complete',
          days: outcome.days,
          source: outcome.source,
        };
    }
  }

  private async getPendingPickerCommand(
    userId: string,
  ): Promise<PendingPickerCommand | null> {
    const raw = await this.redis.get(BOT_STATE_KEY.pendingCommand(userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingPickerCommand;
      if (parsed?.step !== 'awaiting_picks') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async savePending(
    userId: string,
    pending: PendingPickerCommand,
  ): Promise<void> {
    await this.redis.set(
      BOT_STATE_KEY.pendingCommand(userId),
      JSON.stringify(pending),
      BOT_STATE_TTL.albumPicker,
    );
  }

  private async acquireLock(userId: string): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.setNx(
      BOT_STATE_KEY.pendingCommandLock(userId),
      token,
      BOT_STATE_TTL.pendingCommandLock,
    );
    return acquired ? token : null;
  }

  private async releaseLock(userId: string, token: string): Promise<void> {
    await this.redis.delIfValue(
      BOT_STATE_KEY.pendingCommandLock(userId),
      token,
    );
  }

  private async removeButtonsSafely(
    userId: string,
    messageId: number,
  ): Promise<void> {
    try {
      await this.channel.removeInlineButtons(userId, messageId);
    } catch (err) {
      this.logger.warn(`Failed to remove inline buttons: ${err}`);
    }
  }

  private async editWithButtonsSafely(
    userId: string,
    messageId: number,
    text: string,
    buttons: InlineButton[][],
  ): Promise<void> {
    try {
      await this.channel.editMessageWithButtons(
        userId,
        messageId,
        text,
        buttons,
      );
    } catch (err) {
      this.logger.warn(`Failed to edit message with buttons: ${err}`);
    }
  }

  private async editTextSafely(
    userId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.channel.editMessageText(userId, messageId, text);
    } catch (err) {
      this.logger.warn(`Failed to edit message text: ${err}`);
    }
  }
}
