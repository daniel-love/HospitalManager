/**
 * Pressure events (ROADMAP M6 step 1): the realistic calendar, winter
 * pressures and heatwaves, cooling and staff flu vaccination.
 */
import { describe, expect, it } from "vitest";
import { pressureEventById } from "@data/pressure";
import { applyCommand } from "@sim/commands";
import { spawnPatient } from "@sim/systems/arrivals";
import { createSimState, type SimState } from "@sim/state";
import {
  announce,
  arrivalFactor,
  conditionFactor,
  heatAt,
  intensity,
  isCooled,
  sicknessFactor,
  updatePressure,
} from "@sim/systems/pressure";
import { clockFromTick, dateOf, tickAt } from "@sim/time";
import { buildSmallAE, staffedSmallAE } from "../fixtures/smallAE";

const winter = pressureEventById.get("winter_surge")!;
const heatwave = pressureEventById.get("heatwave")!;

/** Runs the event calendar alone, a day at a time from midnight, for `days` days. */
function runCalendar(state: SimState, days: number): void {
  for (let d = 1; d <= days; d++) {
    for (const hour of [0, 8]) {
      state.tick = tickAt(d + 1, hour);
      updatePressure(state);
    }
  }
}

const monthOf = (tick: number) => dateOf(clockFromTick(tick).day).monthIndex % 12;

describe("pressure events", () => {
  it("follow the calendar: flu in winter, heatwaves in summer", () => {
    const state = createSimState({ seed: 3, width: 20, height: 20, eventFrequency: "realistic" });
    runCalendar(state, 365 * 8);
    const all = [...state.pressure.past, ...state.pressure.active];
    const flu = all.filter((e) => e.defId === "winter_surge");
    const heat = all.filter((e) => e.defId === "heatwave");
    expect(flu.length).toBeGreaterThanOrEqual(5);
    expect(flu.length).toBeLessThanOrEqual(8); // At most one a winter.
    expect(heat.length).toBeGreaterThanOrEqual(6);
    expect(heat.length).toBeLessThanOrEqual(18);
    // Forecast in season, starting a few days later.
    for (const e of flu) expect([8, 9, 10, 11]).toContain(monthOf(e.start));
    for (const e of heat) expect([2, 3, 4, 5]).toContain(monthOf(e.start));
  });

  it("never happen with events off, and don't touch the random stream", () => {
    const state = createSimState({ seed: 3, width: 20, height: 20 });
    const rng = structuredClone(state.rng);
    runCalendar(state, 365);
    expect(state.pressure.past.length + state.pressure.active.length).toBe(0);
    expect(state.rng).toEqual(rng);
  });

  it("a flu season builds and fades, bringing breathing problems and staff sickness", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20 });
    const e = announce(state, winter, 0);
    expect(intensity(state, e)).toBe(0);
    state.tick = Math.round((e.start + e.end) / 2);
    expect(intensity(state, e)).toBeCloseTo(1, 2);
    expect(arrivalFactor(state, "ambulance")).toBeCloseTo(winter.arrivals.ambulance, 2);
    expect(conditionFactor(state, "shortness_of_breath")).toBeGreaterThan(2);
    expect(conditionFactor(state, "laceration")).toBe(1);
    const unvaccinated = sicknessFactor(state);
    expect(unvaccinated).toBeCloseTo(winter.sickness, 2);
    state.pressure.vaccinated = 0;
    expect(sicknessFactor(state)).toBeLessThan(unvaccinated);
    expect(sicknessFactor(state)).toBeGreaterThan(1);
    state.tick = e.end;
    updatePressure(state);
    expect(state.pressure.active).toEqual([]);
    expect(state.pressure.past[0]!.defId).toBe("winter_surge");
  });

  it("shifts the walk-in mix towards flu-like illness in a flu season", () => {
    const share = (surge: boolean) => {
      const state = staffedSmallAE(5);
      if (surge) {
        const e = announce(state, winter, 0);
        state.tick = Math.round((e.start + e.end) / 2);
      }
      let ill = 0;
      for (let i = 0; i < 2000; i++) {
        const p = spawnPatient(state, { x: 1, y: 1 });
        if (p.conditionId === "minor_illness") ill++;
        delete state.patients[p.id];
      }
      return ill / 2000;
    };
    expect(share(true)).toBeGreaterThan(share(false) * 1.1);
  });

  it("heat hurts in rooms without cooling, and air conditioners fix it", () => {
    const state = buildSmallAE(1);
    announce(state, heatwave, 0);
    const waiting = state.rooms.find((r) => r.typeId === "waiting_area")!;
    const spot = { x: waiting.bounds.x + 4, y: waiting.bounds.y + 3 };
    expect(isCooled(state, waiting)).toBe(false);
    expect(heatAt(state, spot)).toBe(1);
    const need = Math.ceil(waiting.tiles.length / 30);
    for (let i = 0; i < need; i++) {
      const r = applyCommand(state, {
        type: "place_object",
        floor: 0,
        defId: "portable_air_conditioner",
        x: waiting.bounds.x + 6 + i,
        y: waiting.bounds.y + 1,
        rotation: 0,
      });
      expect(r.ok).toBe(true);
    }
    const room = state.rooms.find((r) => r.typeId === "waiting_area")!;
    expect(isCooled(state, room)).toBe(true);
    expect(heatAt(state, spot)).toBe(0);
  });

  it("vaccinates staff against flu each autumn, with the policy on", () => {
    const state = staffedSmallAE(1);
    state.policies.fluVaccination = true;
    const money = state.money;
    // Midnight going into 1 October (day 184 of the year).
    state.tick = tickAt(184, 0);
    updatePressure(state);
    expect(state.pressure.vaccinated).toBe(0);
    expect(state.money).toBeLessThan(money);
    const after = state.money;
    state.tick = tickAt(185, 0);
    updatePressure(state);
    expect(state.money).toBe(after); // Once a year.
  });
});
