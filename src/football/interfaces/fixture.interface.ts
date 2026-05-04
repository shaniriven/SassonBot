import { Round } from '../const/rounds.const';

export interface FixtureConfig {
  fixture: {
    id: number;
    date: string;
    status: { short: string };
  };
  teams: {
    home: { id: number; name: string; logo: string | null };
    away: { id: number; name: string; logo: string | null };
  };
  league: { name: string; round: Round };
}
