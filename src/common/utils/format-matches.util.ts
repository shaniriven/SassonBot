import { LEAGUE_FLAGS } from '../../football/const/leagues.const';

type Match = {
  homeTeam: string;
  awayTeam: string;
  kickoffTime: Date;
  league: string;
};

function formatTime(date: Date): string {
  return date.toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMatches(matches: Match[], label: string): string {
  if (matches.length === 0) return `No games scheduled ${label} ⚽`;

  const grouped = new Map<string, Match[]>();
  for (const m of matches) {
    if (!grouped.has(m.league)) grouped.set(m.league, []);
    grouped.get(m.league)!.push(m);
  }

  const lines: string[] = [`⚽ ${label} ⚽\n`];
  for (const [league, games] of grouped) {
    const flag = LEAGUE_FLAGS[league] ?? '🏆';
    lines.push(`${flag} ${league} ${flag}`);
    for (const m of games) {
      lines.push(
        `${m.homeTeam} | ${m.awayTeam} | ${formatTime(m.kickoffTime)}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatWeekMatches(matches: Match[], label: string): string {
  if (matches.length === 0) return `No games scheduled — ${label} ⚽`;

  const byDay = new Map<string, Match[]>();
  for (const m of matches) {
    const day = m.kickoffTime.toLocaleDateString('en-GB', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
    });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(m);
  }

  const lines: string[] = [`⚽ ${label} ⚽\n`];
  for (const [day, dayMatches] of byDay) {
    lines.push(`📅 ${day}\n`);
    const byLeague = new Map<string, Match[]>();
    for (const m of dayMatches) {
      if (!byLeague.has(m.league)) byLeague.set(m.league, []);
      byLeague.get(m.league)!.push(m);
    }
    for (const [league, games] of byLeague) {
      const flag = LEAGUE_FLAGS[league] ?? '🏆';
      lines.push(`${flag} ${league} ${flag}`);
      for (const m of games) {
        lines.push(
          `${m.homeTeam} | ${m.awayTeam} | ${formatTime(m.kickoffTime)}`,
        );
      }
      lines.push('');
    }
    lines.push('');
  }
  return lines.join('\n');
}
