import { CMD } from './commands.const';

export const BOT_STATE_KEY = {
  onboarding: (userId: string) => `onboarding:${userId}`,
  pendingCommand: (userId: string) => `pending_command:${userId}`,
} as const;

export const BOT_STATE_TTL = {
  onboarding: 600,
  pendingCommand: 120,
} as const;

export type PendingCommand = {
  type: typeof CMD.adminGeneratePost.command;
  matchIds: string[];
};
