export const ROUNDS = {
  ROUND_OF_16: 'Round of 16',
  QUARTER_FINALS: 'Quarter-finals',
  SEMI_FINALS: 'Semi-finals',
  FINAL: 'Final',
} as const;

export type Round = (typeof ROUNDS)[keyof typeof ROUNDS];
