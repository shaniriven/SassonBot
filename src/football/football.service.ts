import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { FAVORITE_LEAGUES } from './const/leagues.const';
import { FixtureConfig } from './interfaces/fixture.interface';
import { PrismaService } from '../prisma/prisma.service';
import { Match } from '@prisma/client';
import {
  toIsraeliDate,
  currentSeason,
  getNextSaturday,
  getFollowingSaturday,
  getNextSunday,
} from '../common/utils/date.util';

@Injectable()
export class FootballService {
  private readonly logger = new Logger(FootballService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
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

  @Cron('0 9 * * 6')
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
    const to = getFollowingSaturday();
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
        const res = await firstValueFrom(
          this.http.get<{ response: FixtureConfig[]; errors: unknown }>(
            `${this.apiBase}/fixtures`,
            { headers: this.headers, params: { league, season, from, to } },
          ),
        );

        const fixtures = res.data.response ?? [];
        this.logger.log(
          `League ${league}: API returned ${fixtures.length} fixtures (errors: ${JSON.stringify(res.data.errors)}`,
        );

        const config = FAVORITE_LEAGUES.find((l) => l.id_league === league);
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
    const saturday = getNextSaturday();
    return this.prisma.match.findMany({
      where: {
        matchDate: { gte: today, lte: saturday },
      },
      orderBy: { kickoffTime: 'asc' },
    });
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

  async getNextWeekMatches() {
    const nextSunday = getNextSunday();
    const followingSaturday = getFollowingSaturday();
    return this.prisma.match.findMany({
      where: { matchDate: { gte: nextSunday, lte: followingSaturday } },
      orderBy: { kickoffTime: 'asc' },
    });
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
