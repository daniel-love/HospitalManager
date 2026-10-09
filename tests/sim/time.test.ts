import { describe, expect, it } from "vitest";
import {
  clockFromTick,
  formatClock,
  isWeekday,
  tickAt,
  TICKS_PER_DAY,
  TICKS_PER_MINUTE,
} from "@sim/time";

describe("game clock", () => {
  it("starts at 08:00 on day 1", () => {
    expect(clockFromTick(0)).toEqual({ day: 1, weekday: 0, hour: 8, minute: 0 });
  });

  it("advances one minute every TICKS_PER_MINUTE ticks", () => {
    expect(clockFromTick(TICKS_PER_MINUTE - 1).minute).toBe(0);
    expect(clockFromTick(TICKS_PER_MINUTE).minute).toBe(1);
  });

  it("rolls over midnight into the next day", () => {
    const midnight = 16 * 60 * TICKS_PER_MINUTE; // 16 hours after 08:00
    expect(clockFromTick(midnight - TICKS_PER_MINUTE)).toEqual({
      day: 1,
      weekday: 0,
      hour: 23,
      minute: 59,
    });
    expect(clockFromTick(midnight)).toEqual({ day: 2, weekday: 1, hour: 0, minute: 0 });
    expect(clockFromTick(TICKS_PER_DAY).day).toBe(2);
  });

  it("formats with zero padding", () => {
    expect(formatClock({ day: 3, weekday: 2, hour: 7, minute: 5 })).toBe("Wed day 3  07:05");
  });

  it("starts on a Monday and runs through the week", () => {
    expect(clockFromTick(5 * TICKS_PER_DAY).weekday).toBe(5); // Saturday, day 6
    expect(isWeekday(clockFromTick(5 * TICKS_PER_DAY))).toBe(false);
    expect(clockFromTick(7 * TICKS_PER_DAY).weekday).toBe(0);
    expect(clockFromTick(tickAt(3, 9, 30))).toEqual({ day: 3, weekday: 2, hour: 9, minute: 30 });
  });
});
