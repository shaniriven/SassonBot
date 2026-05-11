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
  generatePost: {
    command: 'generate_post',
    description: 'Create image post for matches',
  },
  generateAlbum: {
    command: 'generate_album',
    description: 'Create weekly posts album',
  },
} as const;

export const USER_COMMANDS = [CMD.gamesToday, CMD.gamesWeek, CMD.gamesNextWeek];

export const ADMIN_COMMANDS = [
  CMD.generatePost,
  CMD.generateAlbum,
  CMD.gamesToday,
  CMD.gamesWeek,
  CMD.gamesNextWeek,
  CMD.adminSyncMatches,
  CMD.adminLoadFavoriteLeagues,
];
