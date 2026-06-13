import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { FAVORITE_LEAGUES } from './const/leagues.const';
import { FAVORITE_TEAMS } from './const/favorite-teams.const';
import {
  ALBUM_MIN_KICKOFF_HOUR,
  DISPLAY_FRIDAY,
  WEEK_START_DAY,
} from './const/album-settings.const';
import { FixtureConfig } from './interfaces/fixture.interface';
import { PrismaService } from '../prisma/prisma.service';
import { OpenAiService } from '../openai/openai.service';
import { Match } from '@prisma/client';
import {
  toIsraeliDate,
  currentSeason,
  getWeekEnd,
  getNextWeekStart,
  getFollowingWeekStart,
  getIsraeliHour,
  getIsraeliTimeMinutes,
  isFriday,
} from '../common/utils/date.util';

@Injectable()
export class FootballService {
  private readonly logger = new Logger(FootballService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly openAi: OpenAiService,
  ) {}

  private get apiKey(): string {
    return this.config.getOrThrow<string>('SPORTS_API_KEY');
  }

  private get apiBase(): string {
    return this.config.getOrThrow<string>('SPORTS_API_BASE_URL');
  }

  private get headers() {
    return { 'x-apisports-key': this.apiKey };
  }

  @Cron('0 9 * * 5', { timeZone: 'Asia/Jerusalem' })
  async syncWeeklyGames(): Promise<void> {
    this.logger.log('Starting weekly games sync...');
    await this.syncLeagues();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: deleted } = await this.prisma.match.deleteMany({
      where: { kickoffTime: { lt: today } },
    });
    if (deleted > 0) this.logger.log(`Deleted ${deleted} past matches`);

    const from = toIsraeliDate(new Date());
    const to = getFollowingWeekStart(WEEK_START_DAY);
    const season = currentSeason();
    let total = 0;

    this.logger.log(`Sync range: ${from} → ${to}, season: ${season}`);

    try {
      const leagueIds = (
        await this.prisma.league.findMany({ select: { apiId: true } })
      ).map((l) => l.apiId);
      if (leagueIds.length === 0) {
        this.logger.warn('No leagues in DB — run /admin_leagues first');
        return;
      }
      this.logger.log(
        `Syncing ${leagueIds.length} leagues: [${leagueIds.join(', ')}]`,
      );

      for (const league of leagueIds) {
        const config = FAVORITE_LEAGUES.find((l) => l.id_league === league);
        const leagueSeason = config?.seasonYear ?? season;
        const res = await firstValueFrom(
          this.http.get<{ response: FixtureConfig[]; errors: unknown }>(
            `${this.apiBase}/fixtures`,
            {
              headers: this.headers,
              params: { league, season: leagueSeason, from, to },
            },
          ),
        );

        const fixtures = res.data.response ?? [];
        this.logger.log(
          `League ${league}: API returned ${fixtures.length} fixtures (errors: ${JSON.stringify(res.data.errors)}`,
        );

        const teamIds = config?.teams?.map((t) => t.id);
        const byTeam = teamIds
          ? fixtures.filter(
              (f) =>
                teamIds.includes(f.teams.home.id) ||
                teamIds.includes(f.teams.away.id),
            )
          : fixtures;
        const relevant = config?.rounds
          ? byTeam.filter((f) => config.rounds!.includes(f.league.round))
          : byTeam;

        for (const f of relevant) {
          try {
            await this.prisma.match.upsert({
              where: { apiId: f.fixture.id },
              update: {
                status: f.fixture.status.short,
                kickoffTime: new Date(f.fixture.date),
                matchDate: toIsraeliDate(new Date(f.fixture.date)),
                homeLogo: f.teams.home.logo ?? null,
                awayLogo: f.teams.away.logo ?? null,
              },
              create: {
                apiId: f.fixture.id,
                homeTeam: f.teams.home.name,
                awayTeam: f.teams.away.name,
                homeLogo: f.teams.home.logo ?? null,
                awayLogo: f.teams.away.logo ?? null,
                league: f.league.name,
                kickoffTime: new Date(f.fixture.date),
                matchDate: toIsraeliDate(new Date(f.fixture.date)),
                status: f.fixture.status.short,
              },
            });
            total++;
          } catch (dbErr) {
            this.logger.error(
              `Failed to upsert fixture ${f.fixture.id}: ${dbErr}`,
            );
          }
        }
      }

      this.logger.log(`Sync complete — ${total} fixtures upserted`);
    } catch (err) {
      this.logger.error(`Sync failed: ${err}`);
    }
  }

  async manualSync(): Promise<{ synced: number }> {
    await this.syncWeeklyGames();
    const count = await this.prisma.match.count();
    return { synced: count };
  }

  async getTodayMatches() {
    const today = toIsraeliDate(new Date());
    return this.prisma.match.findMany({
      where: { matchDate: today },
      orderBy: { kickoffTime: 'asc' },
    });
  }

  async getWeekMatches() {
    const today = toIsraeliDate(new Date());
    const saturday = getWeekEnd(WEEK_START_DAY);
    const matches = await this.prisma.match.findMany({
      where: { matchDate: { gte: today, lte: saturday } },
      orderBy: { kickoffTime: 'asc' },
    });
    return matches.filter((m) => DISPLAY_FRIDAY || !isFriday(m.matchDate));
  }

  async getWeekMatchesForCron() {
    const from = getNextWeekStart(WEEK_START_DAY);
    const to = getFollowingWeekStart(WEEK_START_DAY);
    const matches = await this.prisma.match.findMany({
      where: { matchDate: { gte: from, lte: to } },
      orderBy: { kickoffTime: 'asc' },
    });
    return matches.filter((m) => DISPLAY_FRIDAY || !isFriday(m.matchDate));
  }

  async getUpcomingMatchDates(limit: number): Promise<string[]> {
    const today = toIsraeliDate(new Date());
    const rows = await this.prisma.match.findMany({
      where: { matchDate: { gte: today } },
      distinct: ['matchDate'],
      orderBy: { matchDate: 'asc' },
      take: limit,
      select: { matchDate: true },
    });
    return rows.map((row) => row.matchDate);
  }

  async getMatchesByDate(matchDate: string): Promise<Match[]> {
    return this.prisma.match.findMany({
      where: { matchDate },
      orderBy: { kickoffTime: 'asc' },
    });
  }

  private fallbackGroupByDate(
    matches: Match[],
  ): { date: string; matches: Match[]; strongDay: boolean }[] {
    const favoriteSet = new Set(FAVORITE_TEAMS);
    const filtered = matches.filter(
      (m) =>
        (favoriteSet.has(m.homeTeam) || favoriteSet.has(m.awayTeam)) &&
        getIsraeliHour(m.kickoffTime) >= ALBUM_MIN_KICKOFF_HOUR,
    );
    const byDate = new Map<string, Match[]>();
    for (const match of filtered) {
      const group = byDate.get(match.matchDate) ?? [];
      group.push(match);
      byDate.set(match.matchDate, group);
    }
    return [...byDate.entries()].map(([date, dayMatches]) => {
      const sorted = dayMatches
        .sort((a, b) => a.kickoffTime.getTime() - b.kickoffTime.getTime())
        .slice(0, 5);
      return { date, matches: sorted, strongDay: sorted.length >= 2 };
    });
  }

  private formatIsraeliTime(date: Date): string {
    const total = getIsraeliTimeMinutes(date);
    const h = Math.floor(total / 60)
      .toString()
      .padStart(2, '0');
    const m = (total % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private async aiGroupMatchesByDate(
    matches: Match[],
  ): Promise<
    { date: string; matches: Match[]; strongDay: boolean; reason?: string }[]
  > {
    const candidates = matches.filter(
      (m) => getIsraeliHour(m.kickoffTime) >= ALBUM_MIN_KICKOFF_HOUR,
    );
    if (candidates.length === 0) return [];

    const candidateMap = new Map(candidates.map((m) => [m.id, m]));
    const candidateDates = new Set(candidates.map((m) => m.matchDate));

    const system = `You are a match curator for Sasson, a sports bar in Beer Sheva, Israel.
Select and rank up to 5 matches per calendar date for the bar's weekly poster album.

Prioritise in this order:
1. Match prestige: UEFA Champions League > La Liga / Premier League / Serie A / Bundesliga > Europa League > domestic cups > Ligat Ha'al > other
2. Team popularity in Israel: Real Madrid, Barcelona, Man City, Liverpool, Man United, Arsenal, Bayern, Inter, AC Milan are most-watched; PSG secondary; Hapoel Beer Sheva and Maccabi Tel Aviv matter to local fans
3. Season significance: knockout rounds, title/relegation deciders outrank mid-table
4. Derbies and rivalries carry extra weight

Set strongDay: true for dates where 2+ high-interest matches fall on the same evening.
Return only dates that have at least one suitable match. Max 5 matchIds per date, best-first.`;

    const matchList = candidates.map((m) => ({
      id: m.id,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      league: m.league,
      kickoffTimeIsraeli: this.formatIsraeliTime(m.kickoffTime),
      date: m.matchDate,
    }));

    const user = `Today is ${toIsraeliDate(new Date())}. Here are the upcoming evening matches:\n${JSON.stringify(matchList)}`;

    try {
      const response = await this.openAi.selectMatches(system, user);

      const validated = response.selections
        .filter((s) => candidateDates.has(s.date))
        .map((s) => ({
          ...s,
          matchIds: [...new Set(s.matchIds)]
            .filter((id) => candidateMap.has(id))
            .slice(0, 5),
        }))
        .filter((s) => s.matchIds.length > 0);

      const result = validated.map((s) => ({
        date: s.date,
        matches: s.matchIds.map((id) => candidateMap.get(id)!),
        strongDay: s.strongDay,
        reason: s.reason,
      }));

      this.logger.log(
        `AI selected ${result.reduce((acc, r) => acc + r.matches.length, 0)} matches across ${result.length} dates`,
      );
      return result;
    } catch (err) {
      this.logger.warn(`AI match selection failed, falling back: ${err}`);
      return this.fallbackGroupByDate(matches);
    }
  }

  async getWeekFavoriteTeamMatches(): Promise<
    { date: string; matches: Match[]; strongDay: boolean; reason?: string }[]
  > {
    const all = await this.getWeekMatches();
    return this.aiGroupMatchesByDate(all);
  }

  async getWeekFavoriteTeamMatchesForCron(): Promise<
    { date: string; matches: Match[]; strongDay: boolean; reason?: string }[]
  > {
    const all = await this.getWeekMatchesForCron();
    return this.aiGroupMatchesByDate(all);
  }

  async getWeekMatchesGroupedByDate(
    forCron: boolean,
  ): Promise<{ date: string; matches: Match[] }[]> {
    const all = forCron
      ? await this.getWeekMatchesForCron()
      : await this.getWeekMatches();
    const evening = all.filter(
      (m) => getIsraeliHour(m.kickoffTime) >= ALBUM_MIN_KICKOFF_HOUR,
    );
    const byDate = new Map<string, Match[]>();
    for (const match of evening) {
      const group = byDate.get(match.matchDate) ?? [];
      group.push(match);
      byDate.set(match.matchDate, group);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, matches]) => ({
        date,
        matches: matches.sort(
          (a, b) => a.kickoffTime.getTime() - b.kickoffTime.getTime(),
        ),
      }));
  }

  async syncLeagues(): Promise<{ loaded: number }> {
    if (FAVORITE_LEAGUES.length === 0) {
      this.logger.warn(
        'FAVORITE_LEAGUES is empty — add leagues to src/football/const/leagues.const.ts',
      );
      return { loaded: 0 };
    }

    for (const league of FAVORITE_LEAGUES) {
      await this.prisma.league.upsert({
        where: { apiId: league.id_league },
        update: { seasonApiId: league.id_season },
        create: { apiId: league.id_league, seasonApiId: league.id_season },
      });
    }

    this.logger.log(
      `Loaded ${FAVORITE_LEAGUES.length} favorite leagues into DB`,
    );
    return { loaded: FAVORITE_LEAGUES.length };
  }
}
