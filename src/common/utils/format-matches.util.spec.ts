import {
  formatMatchesForPosts,
  orderMatchesForPostSelection,
} from './format-matches.util';

describe('post match selection ordering', () => {
  const matches = [
    {
      id: 'liverpool-chelsea',
      homeTeam: 'Liverpool',
      awayTeam: 'Chelsea',
      kickoffTime: new Date('2026-05-09T11:30:00Z'),
      league: 'Premier League',
    },
    {
      id: 'sunderland-man-utd',
      homeTeam: 'Sunderland',
      awayTeam: 'Manchester United',
      kickoffTime: new Date('2026-05-09T14:00:00Z'),
      league: 'Premier League',
    },
    {
      id: 'lazio-inter',
      homeTeam: 'Lazio',
      awayTeam: 'Inter',
      kickoffTime: new Date('2026-05-09T16:00:00Z'),
      league: 'Serie A',
    },
    {
      id: 'man-city-brentford',
      homeTeam: 'Manchester City',
      awayTeam: 'Brentford',
      kickoffTime: new Date('2026-05-09T16:30:00Z'),
      league: 'Premier League',
    },
  ];

  it('matches the league-grouped numbering shown to the user', () => {
    const ordered = orderMatchesForPostSelection(matches);

    expect(ordered.map((match) => match.id)).toEqual([
      'liverpool-chelsea',
      'sunderland-man-utd',
      'man-city-brentford',
      'lazio-inter',
    ]);
  });

  it('keeps displayed numbers aligned with the ordered ids', () => {
    const ordered = orderMatchesForPostSelection(matches);
    const message = formatMatchesForPosts(ordered, 'Post for - 09/05');

    expect(message).toContain('3. Manchester City | Brentford | 19:30');
    expect(ordered[2].id).toBe('man-city-brentford');
  });
});
