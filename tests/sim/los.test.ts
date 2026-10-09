import { describe, expect, it } from "vitest";
import { createFloorGrid, tileIndex, WallType, type FloorGrid } from "@sim/world/grid";
import { hasLineOfSight } from "@sim/world/los";

function grid(): FloorGrid {
  return createFloorGrid(12, 12);
}

const wall = (g: FloorGrid, x: number, y: number, type: number = WallType.Standard) =>
  void (g.wall[tileIndex(g, x, y)] = type);

describe("line of sight", () => {
  it("sees across open floor in any direction", () => {
    const g = grid();
    expect(hasLineOfSight(g, 1, 1, 9, 4)).toBe(true);
    expect(hasLineOfSight(g, 9, 4, 1, 1)).toBe(true);
    expect(hasLineOfSight(g, 5, 5, 5, 5)).toBe(true);
  });

  it("is blocked by a standard wall but not a glazed one", () => {
    const g = grid();
    for (let y = 0; y < 12; y++) wall(g, 5, y);
    expect(hasLineOfSight(g, 2, 3, 8, 6)).toBe(false);
    for (let y = 0; y < 12; y++) wall(g, 5, y, WallType.Glass);
    expect(hasLineOfSight(g, 2, 3, 8, 6)).toBe(true);
  });

  it("is blocked by a door", () => {
    const g = grid();
    g.door[tileIndex(g, 5, 5)] = 1;
    expect(hasLineOfSight(g, 2, 5, 8, 5)).toBe(false);
    expect(hasLineOfSight(g, 2, 4, 8, 4)).toBe(true);
  });

  it("can't squeeze diagonally between two walls meeting at a corner", () => {
    const g = grid();
    wall(g, 5, 4);
    wall(g, 4, 5);
    expect(hasLineOfSight(g, 4, 4, 5, 5)).toBe(false);
    // One wall alone leaves the diagonal open.
    g.wall[tileIndex(g, 4, 5)] = WallType.None;
    expect(hasLineOfSight(g, 4, 4, 5, 5)).toBe(true);
  });

  it("doesn't count the end tiles themselves", () => {
    const g = grid();
    wall(g, 8, 8);
    expect(hasLineOfSight(g, 2, 2, 8, 8)).toBe(true);
  });
});
