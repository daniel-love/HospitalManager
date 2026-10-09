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

/** The game starts at 08:00 on day 1, a Monday. */
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

export function formatClock(c: GameClock): string {
  const hh = String(c.hour).padStart(2, "0");
  const mm = String(c.minute).padStart(2, "0");
  return `${WEEKDAY_NAMES[c.weekday]} day ${c.day}  ${hh}:${mm}`;
}
