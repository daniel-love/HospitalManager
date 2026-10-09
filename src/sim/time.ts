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

/** The game starts at 08:00 on day 1. */
export const START_MINUTE_OF_DAY = 8 * 60;

export interface GameClock {
  /** 1-based day number. */
  day: number;
  hour: number;
  minute: number;
}

export function clockFromTick(tick: number): GameClock {
  const totalMinutes = Math.floor(tick / TICKS_PER_MINUTE) + START_MINUTE_OF_DAY;
  const day = Math.floor(totalMinutes / MINUTES_PER_DAY) + 1;
  const minuteOfDay = totalMinutes % MINUTES_PER_DAY;
  return { day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
}

export function formatClock(c: GameClock): string {
  const hh = String(c.hour).padStart(2, "0");
  const mm = String(c.minute).padStart(2, "0");
  return `Day ${c.day}  ${hh}:${mm}`;
}
