import { LeagueConfig } from '../interfaces/league.interface';
import { CountryFlag } from './country-flag.const';
import { BUNDESLIGA_TEAMS, LA_LIGA_TEAMS, SERIE_A_TEAMS } from './teams.const';
import { ROUNDS } from './rounds.const';

export const FAVORITE_LEAGUES: LeagueConfig[] = [
  {
    id_league: 2,
    id_season: 7318,
    name: 'UEFA Champions League',
    countryFlag: CountryFlag.Europe,
  },
  {
    id_league: 140,
    id_season: 7351,
    name: 'La Liga',
    countryFlag: CountryFlag.Spain,
    teams: Object.values(LA_LIGA_TEAMS),
  },
  {
    id_league: 39,
    id_season: 7293,
    name: 'Premier League',
    countryFlag: CountryFlag.England,
  },
  {
    id_league: 135,
    id_season: 7286,
    name: 'Serie A',
    countryFlag: CountryFlag.Italy,
    teams: Object.values(SERIE_A_TEAMS),
  },
  {
    id_league: 78,
    id_season: 7338,
    name: 'Bundesliga',
    countryFlag: CountryFlag.Germany,
    teams: Object.values(BUNDESLIGA_TEAMS),
  },
  {
    id_league: 383,
    id_season: 7344,
    name: "Ligat Ha'al",
    countryFlag: CountryFlag.Israel,
  },
  {
    id_league: 384,
    id_season: 7814,
    name: 'Israel State Cup',
    countryFlag: CountryFlag.Israel,
  },
  {
    id_league: 143,
    id_season: 7810,
    name: 'Copa del Rey',
    countryFlag: CountryFlag.Spain,
    rounds: Object.values(ROUNDS),
  },
  {
    id_league: 45,
    id_season: 7508,
    name: 'FA Cup',
    countryFlag: CountryFlag.England,
    rounds: Object.values(ROUNDS),
  },
  {
    id_league: 137,
    id_season: 7369,
    name: 'Coppa Italia',
    countryFlag: CountryFlag.Italy,
    rounds: Object.values(ROUNDS),
  },
  {
    id_league: 81,
    id_season: 7291,
    name: 'DFB Pokal',
    countryFlag: CountryFlag.Germany,
    rounds: Object.values(ROUNDS),
  },
  {
    id_league: 1,
    id_season: 7902,
    name: 'FIFA World Cup',
    countryFlag: CountryFlag.World,
  },
  {
    id_league: 3,
    id_season: 7320,
    name: 'UEFA Europa League',
    countryFlag: CountryFlag.Europe,
  },
  {
    id_league: 9,
    id_season: 5872,
    name: 'Copa America',
    countryFlag: CountryFlag.Americas,
  },
];

export const LEAGUE_FLAGS: Record<string, CountryFlag> = Object.fromEntries(
  FAVORITE_LEAGUES.filter((l) => l.countryFlag).map((l) => [
    l.name,
    l.countryFlag!,
  ]),
);

export const FAVORITE_LEAGUE_IDS = FAVORITE_LEAGUES.map((l) => l.id_league);
