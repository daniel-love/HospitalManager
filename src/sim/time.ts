/**
 * Game time. The sim advances in fixed ticks; everything else is derived from
 * the tick count.
 */

export const TICKS_PER_MINUTE = 10;
export const MINUTES_PER_DAY = 24 * 60;
export const TICKS_PER_DAY = TICKS_PER_MINUTE * MINUTES_PER_DAY;

/**
 * Ticks per real second at 1× speed: one in-game minute per real second, so
 * a day takes 24 real minutes at 1× and 90 seconds at 16×. (A day once took
 * 4.8 minutes at 1×, which made everyone dart about too fast to follow.)
 */
export const TICKS_PER_SECOND_1X = 10;

/** The game starts at 08:00 on day 1, Monday 1 April (see MONTHS). */
export const START_MINUTE_OF_DAY = 8 * 60;

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface GameClock {
  /** 1-based day number. */
  day: number;
  /** 0 Monday … 6 Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

export function clockFromTick(tick: number): GameClock {
  const totalMinutes = Math.floor(tick / TICKS_PER_MINUTE) + START_MINUTE_OF_DAY;
  const day = Math.floor(totalMinutes / MINUTES_PER_DAY) + 1;
  const minuteOfDay = totalMinutes % MINUTES_PER_DAY;
  return {
    day,
    weekday: (day - 1) % 7,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  };
}

/** Monday to Friday. */
export function isWeekday(c: GameClock): boolean {
  return c.weekday < 5;
}

/** The tick a clock time falls on: `day` (1-based) at hour:minute. */
export function tickAt(day: number, hour: number, minute = 0): number {
  return (
    ((day - 1) * MINUTES_PER_DAY + hour * 60 + minute - START_MINUTE_OF_DAY) * TICKS_PER_MINUTE
  );
}

/**
 * The calendar: day 1 is Monday 1 April, the first day of the PHS financial
 * year (year 1). Months run April to March; no leap years.
 */
export const MONTHS = [
  { name: "April", short: "Apr", days: 30 },
  { name: "May", short: "May", days: 31 },
  { name: "June", short: "Jun", days: 30 },
  { name: "July", short: "Jul", days: 31 },
  { name: "August", short: "Aug", days: 31 },
  { name: "September", short: "Sep", days: 30 },
  { name: "October", short: "Oct", days: 31 },
  { name: "November", short: "Nov", days: 30 },
  { name: "December", short: "Dec", days: 31 },
  { name: "January", short: "Jan", days: 31 },
  { name: "February", short: "Feb", days: 28 },
  { name: "March", short: "Mar", days: 31 },
] as const;
const DAYS_PER_YEAR = 365;

export interface GameDate {
  /** 1-based financial year. */
  year: number;
  /** 0 April … 11 March. */
  month: number;
  /** Day of the month, 1-based. */
  date: number;
  /** Months since the game began (0 for the first April): a running month number. */
  monthIndex: number;
}

/** The calendar date of a game day (1-based). */
export function dateOf(day: number): GameDate {
  const d = day - 1;
  const year = Math.floor(d / DAYS_PER_YEAR) + 1;
  let rest = d % DAYS_PER_YEAR;
  let month = 0;
  while (rest >= MONTHS[month]!.days) rest -= MONTHS[month++]!.days;
  return { year, month, date: rest + 1, monthIndex: (year - 1) * 12 + month };
}

/** The game day (1-based) a running month number (GameDate.monthIndex) begins on. */
export function firstDayOf(monthIndex: number): number {
  const year = Math.floor(monthIndex / 12);
  let day = year * DAYS_PER_YEAR + 1;
  for (let m = 0; m < monthIndex % 12; m++) day += MONTHS[m]!.days;
  return day;
}

/** "April", or "April Y2" after the first year. */
export function monthName(d: { year: number; month: number }): string {
  return `${MONTHS[d.month]!.name}${d.year > 1 ? ` Y${d.year}` : ""}`;
}

/** "3 Apr", or "3 Apr Y2" after the first year. */
export function formatDate(day: number): string {
  const d = dateOf(day);
  return `${d.date} ${MONTHS[d.month]!.short}${d.year > 1 ? ` Y${d.year}` : ""}`;
}

/** "Wed 3 Apr  07:05". */
export function formatClock(c: GameClock): string {
  const hh = String(c.hour).padStart(2, "0");
  const mm = String(c.minute).padStart(2, "0");
  return `${WEEKDAY_NAMES[c.weekday]} ${formatDate(c.day)}  ${hh}:${mm}`;
}
