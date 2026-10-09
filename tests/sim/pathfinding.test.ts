import { describe, expect, it } from "vitest";
import { applyCommand } from "@sim/commands";
import { createSimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import { findPath, nearestEdgeTile } from "@sim/world/pathfinding";
import { buildSmallAE } from "../fixtures/smallAE";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** A 10×10 field split by a wall at x = 5, with an optional door at (5, 5). */
function walled(door: boolean) {
  const state = createSimState({ seed: 1, width: 10, height: 10 });
  applyCommand(state, {
    type: "build_walls",
    floor: 0,
    rect: rect(5, 0, 1, 10),
    wall: WallType.Standard,
  });
  if (door) {
    applyCommand(state, {
      type: "place_object",
      floor: 0,
      defId: "door_single",
      x: 5,
      y: 5,
      rotation: 1,
    });
  }
  return state.floors[0]!;
}

const xy = (grid: { width: number }, i: number) => [i % grid.width, Math.floor(i / grid.width)];

describe("findPath", () => {
  it("goes straight across open ground, diagonally where it can", () => {
    const grid = createSimState({ seed: 1, width: 10, height: 10 }).floors[0]!;
    const path = findPath(grid, 0, 0, 4, 4)!;
    expect(path.map((i) => xy(grid, i))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  it("returns null when a wall cuts the goal off", () => {
    const grid = walled(false);
    expect(findPath(grid, 2, 2, 8, 2)).toBeNull();
  });

  it("walks straight through a door, never diagonally into it", () => {
    const grid = walled(true);
    const path = findPath(grid, 2, 2, 8, 8)!.map((i) => xy(grid, i));
    const at = path.findIndex(([x, y]) => x === 5 && y === 5);
    expect(at).toBeGreaterThan(0);
    expect(path[at - 1]).toEqual([4, 5]);
    expect(path[at + 1]).toEqual([6, 5]);
  });

  it("doesn't cut the corners of walls", () => {
    const grid = walled(true);
    for (const i of findPath(grid, 4, 4, 8, 8)!) {
      expect(grid.wall[i]).toBe(0);
    }
    // From (4, 4) the door at (5, 5) is diagonal, so the route steps down first.
    expect(xy(grid, findPath(grid, 4, 4, 8, 8)![0]!)).toEqual([4, 5]);
  });

  it("treats floor-standing items as obstacles", () => {
    const state = buildSmallAE();
    const grid = state.floors[0]!;
    const desk = Object.values(state.objects).find((o) => o.defId === "reception_desk")!;
    const path = findPath(grid, 4, 12, 9, 10)!;
    expect(path).not.toBeNull();
    for (const i of path) expect(grid.objectId[i] === desk.id).toBe(false);
  });
});

describe("nearestEdgeTile", () => {
  it("finds the way out of the small A&E through its entrance", () => {
    const state = buildSmallAE();
    const grid = state.floors[0]!;
    // From reception, the double doors at (5–6, 16) lead to the bottom edge.
    const exit = nearestEdgeTile(grid, 6, 12)!;
    expect(exit.y).toBe(grid.height - 1);
    expect([5, 6]).toContain(exit.x);
  });

  it("is null inside a building with no outside door", () => {
    const state = createSimState({ seed: 1, width: 10, height: 10 });
    applyCommand(state, {
      type: "build_walls",
      floor: 0,
      rect: rect(2, 2, 5, 5),
      wall: WallType.Standard,
    });
    expect(nearestEdgeTile(state.floors[0]!, 4, 4)).toBeNull();
  });
});
