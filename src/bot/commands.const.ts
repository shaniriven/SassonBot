export const CMD = {
  start: { command: 'start', description: 'Register' },
  gamesToday: { command: 'games_today', description: "Today's matches" },
  gamesWeek: { command: 'games_week', description: "This week's matches" },
  gamesNextWeek: {
    command: 'games_next_week',
    description: "Next week's matches",
  },
  adminSyncMatches: {
    command: 'admin_sync_matches',
    description: 'Sync fixtures from API',
  },
  adminLoadFavoriteLeagues: {
    command: 'admin_load_favorite_leagues',
    description: 'Load favorite leagues into DB',
  },
  adminGeneratePost: {
    command: 'admin_generate_post',
    description: 'Generate image post for matches',
  },
} as const;

export const USER_COMMANDS = [CMD.gamesToday, CMD.gamesWeek, CMD.gamesNextWeek];

export const ADMIN_COMMANDS = [
  ...USER_COMMANDS,
  CMD.adminGeneratePost,
  CMD.adminSyncMatches,
  CMD.adminLoadFavoriteLeagues,
];
