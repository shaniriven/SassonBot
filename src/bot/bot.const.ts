import { CMD } from './commands.const';

type GeneratePostDateCallbackPrefix =
  `${typeof CMD.generatePost.command}:date:`;
export const GENERATE_POST_DATE_CALLBACK_PREFIX: GeneratePostDateCallbackPrefix = `${CMD.generatePost.command}:date:`;
export const UPCOMING_POST_DATE_LIMIT = 6;

export const ALBUM_MODE_PREFIX = 'album:mode:';
export const PICKER_TOGGLE_PREFIX = 'picker:toggle:';
export const PICKER_NAV_PREFIX = 'picker:nav:';
export const PICKER_STRONG_PREFIX = 'picker:strong:';

export const BOT_STATE_KEY = {
  onboarding: (userId: string) => `onboarding:${userId}`,
  pendingCommand: (userId: string) => `pending_command:${userId}`,
  pendingCommandLock: (userId: string) => `pending_command_lock:${userId}`,
} as const;

export const BOT_STATE_TTL = {
  onboarding: 600,
  pendingCommand: 120,
  pendingCommandLock: 30,
  albumMode: 1800,
  albumPicker: 1800,
} as const;

export type PendingPostDateCommand = {
  type: typeof CMD.generatePost.command;
  step: 'awaiting_date';
  messageId: number;
};

export type AlbumModeSource = 'cmd' | 'cron';

export type PendingAlbumModeCommand = {
  type: typeof CMD.generateAlbum.command;
  step: 'awaiting_album_mode';
  messageId: number;
  source: AlbumModeSource;
};

export type AlbumPickerMatch = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoffTime: string;
  league: string;
};

export type AlbumPickerDay = {
  date: string;
  matches: AlbumPickerMatch[];
  selectedMatchIds: string[];
  strongDay: boolean;
  headlinerId?: string;
};

export type PendingPickerCommand = {
  type: typeof CMD.generateAlbum.command | typeof CMD.generatePost.command;
  step: 'awaiting_picks';
  messageId: number;
  days: AlbumPickerDay[];
  currentDayIndex: number;
  source: 'album' | 'post';
  showStrongDay: boolean;
  completeLabel: string;
  headlinerPickMode?: boolean;
};

export type PendingCommand =
  | PendingPostDateCommand
  | PendingAlbumModeCommand
  | PendingPickerCommand;
