/**
 * Patients keep to public routes (world/access.ts).
 */
import { describe, expect, it } from "vitest";
import { createSimState, type SimState } from "@sim/state";
import { BACK_DOOR, OPEN, PRIVATE, patientAccess } from "@sim/world/access";
import { tileIndex, WallType } from "@sim/world/grid";
import { findPath } from "@sim/world/pathfinding";
import { applyAll } from "../fixtures/smallAE";

/**
 * An 18×12 map with grass all round a building: Resus (x 2–7) and a corridor
 * (x 9–15), joined by a door at (8, 5). Resus has a back door straight
 * outside at (1, 5); the corridor has the front door at (16, 5).
 */
function building(): SimState {
  const state = createSimState({ seed: 1, width: 18, height: 12, money: 1_000_000 });
  const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  applyAll(state, [
    { type: "build_floor", floor: 0, rect: r(2, 2, 14, 8) },
    { type: "build_walls", floor: 0, rect: r(1, 1, 16, 10), wall: WallType.Standard },
    { type: "build_walls", floor: 0, rect: r(8, 1, 1, 10), wall: WallType.Standard },
    { type: "zone", floor: 0, rect: r(2, 2, 6, 8), roomType: "resus_bay" },
    { type: "zone", floor: 0, rect: r(9, 2, 7, 8), roomType: "corridor" },
    { type: "place_object", floor: 0, defId: "door_single", x: 1, y: 5, rotation: 1 },
    { type: "place_object", floor: 0, defId: "door_single", x: 8, y: 5, rotation: 1 },
    { type: "place_object", floor: 0, defId: "door_single", x: 16, y: 5, rotation: 1 },
  ]);
  return state;
}

describe("patient access", () => {
  const state = building();
  const grid = state.floors[0]!;
  const at = (x: number, y: number) => tileIndex(grid, x, y);
  const access = patientAccess(state);
  const route = (sx: number, sy: number, gx: number, gy: number, patient: boolean) =>
    findPath(grid, sx, sy, gx, gy, patient ? { patient: access } : {});

  it("marks clinical rooms private and their outside doors as back doors", () => {
    expect(access[at(4, 5)]).toBe(PRIVATE);
    expect(access[at(12, 5)]).toBe(OPEN);
    expect(access[at(1, 5)]).toBe(BACK_DOOR);
    // The door between Resus and the corridor is the way in and out.
    expect(access[at(8, 5)]).toBe(OPEN);
    expect(access[at(16, 5)]).toBe(OPEN);
  });

  it("sends a patient leaving Resus out through the department", () => {
    const path = route(4, 5, 0, 5, true)!;
    expect(path).toContain(at(8, 5));
    expect(path).toContain(at(16, 5));
    expect(path).not.toContain(at(1, 5));
    // Staff can use the back door.
    expect(route(4, 5, 0, 5, false)).toContain(at(1, 5));
  });

  it("never takes a walk-in through Resus to reach the corridor", () => {
    const path = route(0, 5, 12, 5, true)!;
    expect(path.some((i) => access[i] === PRIVATE)).toBe(false);
    expect(path).toContain(at(16, 5));
  });

  it("lets a patient into Resus when that's where they're going", () => {
    const path = route(12, 5, 4, 5, true)!;
    expect(path).toContain(at(8, 5));
    expect(path).not.toContain(at(1, 5));
  });
});
