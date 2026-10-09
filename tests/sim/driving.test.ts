/**
 * Ambulances driving in along the road (ROADMAP M3.5 step 4).
 */
import { describe, expect, it } from "vitest";
import type { Ambulance } from "@sim/agents";
import { decodeSave, encodeSave } from "@save/codec";
import { PUBLIC_LAND, applyCommand, planCommand, type Command } from "@sim/commands";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import {
  ambulanceArrives,
  ambulancesWaiting,
  baySpaces,
  parkingSpaces,
} from "@sim/systems/ambulances";
import { updateArrivals } from "@sim/systems/arrivals";
import { FloorType, isPublic, tileIndex } from "@sim/world/grid";
import { drivable, entryPoint } from "@sim/world/vehicles";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const road = (r: ReturnType<typeof rect>): Command => ({
  type: "pave",
  floor: 0,
  rect: r,
  surface: "road",
});

/**
 * A 40×40 map: council road at y 26–31 with pavements at 24–25 and 32–33.
 * An Ambulance Bay (one 3×6 space) on access road at x 10–12, y 14–19, and an
 * access road `width` wide down to the road, across the pavement.
 */
function site(width = 3): SimState {
  const state = createSimState({ seed: 1, width: 40, height: 40, money: 1_000_000, site: true });
  state.settings.patientVolume = 0;
  for (const cmd of [
    road(rect(10, 14, 3, 6)),
    road(rect(10, 20, width, 6)),
    { type: "zone", floor: 0, rect: rect(10, 14, 3, 6), roomType: "ambulance_bay" } as const,
  ]) {
    expect(applyCommand(state, cmd).ok).toBe(true);
  }
  return state;
}

/** Calls an ambulance in from the west end. */
function callFromWest(state: SimState): Ambulance {
  const a = ambulanceArrives(state);
  const at = entryPoint(state.site!, 40, 0);
  Object.assign(a, { from: 0, x: at.x, y: at.y, prevX: at.x, prevY: at.y });
  return a;
}

function runUntil(state: SimState, done: () => boolean, limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    if (done()) return i;
    tick(state);
  }
  throw new Error("timed out");
}

describe("a dropped kerb", () => {
  it("lets an access road cross the council pavement, but not the road itself", () => {
    const state = site();
    const grid = state.floors[0]!;
    const kerb = tileIndex(grid, 11, 24);
    expect(grid.floorType[kerb]).toBe(FloorType.Road);
    expect(isPublic(grid, kerb)).toBe(true);
    expect(planCommand(state, road(rect(20, 27, 2, 2))).error).toBe(PUBLIC_LAND);
    expect(
      planCommand(state, { type: "pave", floor: 0, rect: rect(20, 24, 1, 1), surface: "path" }).ok,
    ).toBe(false);
  });
});

describe("getting to the Ambulance Bay", () => {
  it("counts a bay linked to the road by a 3-wide access road", () => {
    const state = site();
    expect(parkingSpaces(state)).toEqual([{ x: 10, y: 14, w: 3, h: 6 }]);
    const grid = state.floors[0]!;
    expect(drivable(state).reachable[tileIndex(grid, 11, 17)]).toBe(1);
  });

  it("doesn't count a bay reached only by a narrower road, and says why", () => {
    expect(baySpaces(site(2))).toHaveLength(1);
    expect(parkingSpaces(site(2))).toEqual([]);
    // A working A&E (so ambulances are called) whose access road is narrowed to 2 tiles.
    const state = staffedMajorsAE(1, MAJORS_TEAM, { ambulance: true, site: true });
    expect(
      applyCommand(state, { type: "remove_floor", floor: 0, rect: rect(17, 35, 1, 2) }).ok,
    ).toBe(true);
    expect(parkingSpaces(state)).toEqual([]);
    state.settings.patientVolume = 1e6; // An ambulance (and a walk-in) every tick.
    updateArrivals(state);
    expect(Object.keys(state.ambulances)).toHaveLength(0);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(
      /couldn't drive to your Ambulance Bay/,
    );
  });
});

describe("an ambulance on the road", () => {
  it("drives in on tarmac, parks, then hands over its patient", () => {
    const state = site();
    const grid = state.floors[0]!;
    const a = callFromWest(state);
    const surfaces = new Set<number>();
    const ticks = runUntil(state, () => {
      surfaces.add(grid.floorType[tileIndex(grid, Math.round(a.x), Math.round(a.y))]!);
      return a.phase === "parked";
    });
    expect(ticks).toBeGreaterThan(5);
    expect([...surfaces]).toEqual([FloorType.Road]);
    expect({ x: a.x, y: a.y }).toEqual({ x: 11, y: 17 });
    const p = state.patients[a.patientId!]!;
    expect(p.ambulanceId).toBe(a.id);
    expect(p.times.arrived).toBe(a.arrived);
  });

  it("drives off the map once it's done", () => {
    const state = site();
    const a = callFromWest(state);
    runUntil(state, () => a.phase === "parked");
    a.leaveAt = state.tick;
    tick(state);
    expect(a.phase).toBe("leaving");
    expect(a.space).toBeNull();
    runUntil(state, () => !state.ambulances[a.id]);
    expect(a.x).toBe(0);
  });

  it("queues on the road short of the turn-off while the bay is full", () => {
    const state = site();
    const first = callFromWest(state);
    runUntil(state, () => first.phase === "parked");
    const second = callFromWest(state);
    runUntil(state, () => second.route.length === 0 && second.x > 0);
    expect(second).toMatchObject({ phase: "arriving", space: null, x: 3, y: 27 });
    expect(ambulancesWaiting(state)).toBe(1);
    // The first leaves; the second takes the space.
    first.leaveAt = state.tick;
    runUntil(state, () => second.phase === "parked");
    expect({ x: second.x, y: second.y }).toEqual({ x: 11, y: 17 });
  });

  it("is saved mid-journey", () => {
    const state = site();
    const a = callFromWest(state);
    for (let i = 0; i < 4; i++) tick(state);
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "drive")))).state;
    expect(loaded.ambulances[a.id]).toEqual(a);
  });
});
