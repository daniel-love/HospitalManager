/**
 * Whole days beside the public road (ROADMAP M3.5): walk-ins arrive along the
 * pavement or off the bus and keep to the paths, and ambulances drive in,
 * hand over and drive off. Invariants are checked throughout.
 */
import { describe, expect, it } from "vitest";
import { arrivalPoints } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { parkingSpaces } from "@sim/systems/ambulances";
import { TICKS_PER_DAY } from "@sim/time";
import { FloorType, tileIndex } from "@sim/world/grid";
import { drivable } from "@sim/world/vehicles";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { SMALL_AE_TEAM, staffedSmallAE } from "../fixtures/smallAE";
import { invariantProblems, run } from "./simHelpers";

/** Runs a day, noting where each patient first appears. */
function dayWithSpawns(state: SimState): { x: number; y: number; ambulance: boolean }[] {
  const seen = new Set(Object.keys(state.patients).map(Number));
  const spawns: { x: number; y: number; ambulance: boolean }[] = [];
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    tick(state);
    for (const p of Object.values(state.patients)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      spawns.push({ x: p.prevX, y: p.prevY, ambulance: p.ambulanceId !== null });
    }
    if (i % 50 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  return spawns;
}

describe("a small A&E beside the road over 24 hours", () => {
  const state = staffedSmallAE(3, SMALL_AE_TEAM, { site: true });
  const spawns = dayWithSpawns(state);
  const day1 = state.history[0]!;

  it("has walk-ins arrive at the road ends or the bus stop", () => {
    const points = arrivalPoints(state).map((p) => `${p.x},${p.y}`);
    // The run starts at 08:00, so it ends 8 hours into day 2.
    expect(spawns.length).toBe(day1.stats.arrivals + state.today.stats.arrivals);
    expect(spawns.every((s) => points.includes(`${s.x},${s.y}`))).toBe(true);
    // Some of each.
    for (const p of points) expect(spawns.some((s) => `${s.x},${s.y}` === p)).toBe(true);
  });

  it("still sees patients through, losing fewer than half", () => {
    expect(day1.stats.arrivals).toBeGreaterThan(25);
    expect(day1.stats.discharged).toBeGreaterThan(15);
    expect(day1.stats.lwbs).toBeLessThan(day1.stats.discharged / 2);
  });

  it("keeps people outside off the grass", () => {
    const grid = state.floors[0]!;
    let outside = 0;
    let onGrass = 0;
    run(state, 6 * 60 * 10, (s) => {
      for (const p of Object.values(s.patients)) {
        if (p.path.length === 0) continue;
        const t = grid.floorType[tileIndex(grid, Math.round(p.x), Math.round(p.y))];
        if (t === FloorType.Floor) continue;
        outside++;
        if (t === FloorType.Grass) onGrass++;
      }
    });
    expect(outside).toBeGreaterThan(100);
    expect(onGrass / outside).toBeLessThan(0.05);
  });
});

describe("a majors A&E with ambulances beside the road over 24 hours", () => {
  const state = staffedMajorsAE(1, MAJORS_TEAM, { ambulance: true, site: true });
  const grid = state.floors[0]!;
  let offRoad = 0;
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    tick(state);
    for (const a of Object.values(state.ambulances)) {
      if (a.phase === "parked") continue;
      const i = tileIndex(grid, Math.round(a.x), Math.round(a.y));
      if (drivable(state).tiles[i] !== 1) offRoad++;
    }
    if (i % 50 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  const day1 = state.history[0]!;

  it("can reach its bay by the access road", () => {
    expect(parkingSpaces(state)).toHaveLength(1);
  });

  it("has ambulances drive in, hand over and drive off, keeping to tarmac", () => {
    expect(day1.stats.ambulances).toBeGreaterThan(10);
    expect(day1.stats.handovers).toBeGreaterThan(5);
    expect(offRoad).toBe(0);
    expect(state.alerts["ambulance_no_road"]).toBeUndefined();
  });

  it("is deterministic", () => {
    const again = staffedMajorsAE(1, MAJORS_TEAM, { ambulance: true, site: true });
    for (let i = 0; i < TICKS_PER_DAY; i++) tick(again);
    expect(again.history).toEqual(state.history);
  });
});
