/**
 * Walking outside: grass is slow, paths are preferred, and walk-ins arrive
 * along the public road (ROADMAP M3.5 step 3).
 */
import { describe, expect, it } from "vitest";
import { WALK_IN_BY_BUS } from "@data/patients";
import { applyCommand } from "@sim/commands";
import { arrivalPoints, siteEntrance } from "@sim/places";
import { createSimState } from "@sim/state";
import { spawnPatient, walkInPoint } from "@sim/systems/arrivals";
import { moveAgents } from "@sim/systems/movement";
import { findPath } from "@sim/world/pathfinding";
import { applyAll, SMALL_AE_COMMANDS } from "../fixtures/smallAE";

describe("walking outside", () => {
  it("keeps to a path rather than cutting straight across grass", () => {
    const state = createSimState({ seed: 1, width: 20, height: 4, money: 100_000 });
    applyCommand(state, {
      type: "pave",
      floor: 0,
      rect: { x: 0, y: 0, w: 20, h: 1 },
      surface: "path",
    });
    const grid = state.floors[0]!;
    const route = findPath(grid, 0, 1, 19, 1)!;
    const onPath = route.filter((i) => Math.floor(i / grid.width) === 0).length;
    expect(onPath).toBeGreaterThan(15);
  });

  it("is half as fast on grass as on a path", () => {
    const state = createSimState({ seed: 1, width: 20, height: 4, money: 100_000 });
    applyCommand(state, {
      type: "pave",
      floor: 0,
      rect: { x: 0, y: 0, w: 20, h: 1 },
      surface: "path",
    });
    const onPath = spawnPatient(state, { x: 0, y: 0 });
    const onGrass = spawnPatient(state, { x: 0, y: 2 });
    onPath.path = [10, 0];
    onGrass.path = [10, 2];
    moveAgents(state);
    expect(onGrass.x).toBeCloseTo(onPath.x / 2);
  });
});

describe("arriving by the public road", () => {
  const site = () => {
    const state = createSimState({ seed: 2, width: 40, height: 40, site: true });
    state.money = 1_000_000;
    applyAll(state, SMALL_AE_COMMANDS);
    return state;
  };

  it("arrives at either end of the pavement or off the bus", () => {
    const state = site();
    const [west, east, bus] = arrivalPoints(state);
    expect([west, east, bus]).toEqual([
      { x: 0, y: 24 },
      { x: 39, y: 24 },
      { x: 16, y: 24 },
    ]);
    const counts = { west: 0, east: 0, bus: 0 };
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const at = walkInPoint(state)!;
      const same = (p: typeof at | undefined) => p?.x === at.x && p.y === at.y;
      if (same(bus)) counts.bus++;
      else if (same(west)) counts.west++;
      else if (same(east)) counts.east++;
    }
    expect(counts.west + counts.east + counts.bus).toBe(n);
    expect(counts.bus / n).toBeCloseTo(WALK_IN_BY_BUS, 1);
    expect(counts.west / n).toBeCloseTo((1 - WALK_IN_BY_BUS) / 2, 1);
  });

  it("leaves by the arrival point nearest reception", () => {
    // The A&E's front door is at its bottom left, nearest the west end.
    expect(siteEntrance(site())).toEqual({ x: 0, y: 24 });
  });

  it("still uses the map edge on a map with no road", () => {
    const state = createSimState({ seed: 2, width: 24, height: 20, money: 1_000_000 });
    applyAll(state, SMALL_AE_COMMANDS);
    expect(arrivalPoints(state)).toEqual([]);
    expect(walkInPoint(state)).toBeNull();
    expect(siteEntrance(state)).toEqual({ x: 6, y: 19 });
  });
});
