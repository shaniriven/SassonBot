import { Round } from '../const/rounds.const';
import { CountryFlag } from '../const/country-flag.const';

export { CountryFlag };

export interface TeamConfig {
  id: number;
  name: string;
}

export interface LeagueConfig {
  id_league: number;
  id_season: number;
  name: string;
  countryFlag?: CountryFlag;
  teams?: TeamConfig[];
  rounds?: Round[];
}
