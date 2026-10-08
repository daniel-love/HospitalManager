/**
 * Game time. The sim advances in fixed ticks; everything else is derived from
 * the tick count.
 */

export const TICKS_PER_MINUTE = 10;
export const MINUTES_PER_DAY = 24 * 60;
export const TICKS_PER_DAY = TICKS_PER_MINUTE * MINUTES_PER_DAY;

/**
 * Ticks per real second at 1× speed. 14,400 ticks per day / 50 = 288 s, so an
 * in-game day takes about 4.8 real minutes (design target: 4–6).
 */
export const TICKS_PER_SECOND_1X = 50;

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
