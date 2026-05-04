import { CMD } from './commands.const';

type GeneratePostDateCallbackPrefix =
  `${typeof CMD.generatePost.command}:date:`;
export const GENERATE_POST_DATE_CALLBACK_PREFIX: GeneratePostDateCallbackPrefix = `${CMD.generatePost.command}:date:`;
export const UPCOMING_POST_DATE_LIMIT = 6;

export const BOT_STATE_KEY = {
  onboarding: (userId: string) => `onboarding:${userId}`,
  pendingCommand: (userId: string) => `pending_command:${userId}`,
  pendingCommandLock: (userId: string) => `pending_command_lock:${userId}`,
} as const;

export const BOT_STATE_TTL = {
  onboarding: 600,
  pendingCommand: 120,
  pendingCommandLock: 30,
} as const;

export type PendingPostDateCommand = {
  type: typeof CMD.generatePost.command;
  step: 'awaiting_date';
  messageId: number;
};

export type PendingPostMatchesCommand = {
  type: typeof CMD.generatePost.command;
  step: 'awaiting_matches';
  matchDate: string;
  matchIds: string[];
};

export type PendingCommand = PendingPostDateCommand | PendingPostMatchesCommand;
