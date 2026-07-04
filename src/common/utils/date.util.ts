const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function todayLabel(): string {
  return new Date().toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
  });
}

export function toIsraeliDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

export function currentSeason(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

export function getWeekEnd(weekStartDay: string): string {
  const target = DAY_INDEX[weekStartDay];
  const d = new Date();
  const daysUntil = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysUntil);
  return toIsraeliDate(d);
}

export function getNextWeekStart(weekStartDay: string): string {
  const target = DAY_INDEX[weekStartDay];
  const d = new Date();
  const daysUntil = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntil);
  return toIsraeliDate(d);
}

export function getFollowingWeekStart(weekStartDay: string): string {
  const target = DAY_INDEX[weekStartDay];
  const d = new Date();
  const daysUntil = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntil + 7);
  return toIsraeliDate(d);
}

export function getIsraeliHour(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === 'hour');
  return parseInt(hourPart?.value ?? '0', 10);
}

export function matchDateToDay(matchDate: string): string {
  return new Date(`${matchDate}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'Asia/Jerusalem',
  });
}

export function getIsraeliTimeMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return h * 60 + m;
}

export function isFriday(dateString: string): boolean {
  return new Date(`${dateString}T12:00:00`).getDay() === 5;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toIsraeliDate(d);
}
