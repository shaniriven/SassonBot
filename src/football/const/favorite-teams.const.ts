import {
  BUNDESLIGA_TEAMS,
  ISRAELI_TEAMS,
  LA_LIGA_TEAMS,
  LIGUE_1_TEAMS,
  PREMIER_LEAGUE_TEAMS,
  SERIE_A_TEAMS,
} from './teams.const';

export const FAVORITE_TEAMS: string[] = [
  ...Object.values(ISRAELI_TEAMS).map((t) => t.name),
  LA_LIGA_TEAMS.BARCELONA.name,
  LA_LIGA_TEAMS.REAL_MADRID.name,
  LA_LIGA_TEAMS.ATLETICO_MADRID.name,
  ...Object.values(PREMIER_LEAGUE_TEAMS).map((t) => t.name),
  LIGUE_1_TEAMS.PSG.name,
  BUNDESLIGA_TEAMS.BAYERN.name,
  SERIE_A_TEAMS.INTER.name,
  SERIE_A_TEAMS.MILAN.name,
];
