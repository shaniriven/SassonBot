import { Round } from '../const/rounds.const';

export interface FixtureConfig {
  fixture: {
    id: number;
    date: string;
    status: { short: string };
  };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  league: { name: string; round: Round };
}
