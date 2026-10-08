import { describe, expect, it } from "vitest";
import { createSimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import { accessTiles, footprintRect, frontTiles, isStandable, sideTiles } from "@sim/world/objects";
import { applyAll } from "../fixtures/smallAE";

describe("item fronts", () => {
  // A 3×1 bench at (2, 2): rotation 0 faces down, turns go clockwise.
  const bench = (rotation: 0 | 1 | 2 | 3) =>
    frontTiles(footprintRect("waiting_bench", 2, 2, rotation), rotation);

  it("faces down at rotation 0, then left, up and right", () => {
    expect(bench(0)).toEqual([
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 4, y: 3 },
    ]);
    // Rotated: footprint is 1×3 at (2, 2)–(2, 4).
    expect(bench(1)).toEqual([
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 1, y: 4 },
    ]);
    expect(bench(2).map((t) => t.y)).toEqual([1, 1, 1]);
    expect(bench(3).map((t) => t.x)).toEqual([3, 3, 3]);
  });

  it("puts a bed's foot (front) below its head at rotation 0", () => {
    expect(frontTiles(footprintRect("hospital_bed", 5, 5, 0), 0)).toEqual([{ x: 5, y: 7 }]);
  });

  it("knows which front tiles someone could stand on", () => {
    const state = createSimState({ seed: 1, width: 8, height: 8 });
    applyAll(state, [
      { type: "build_floor", floor: 0, rect: { x: 0, y: 0, w: 6, h: 6 } },
      { type: "build_walls", floor: 0, rect: { x: 3, y: 0, w: 1, h: 6 }, wall: WallType.Standard },
      { type: "place_object", floor: 0, defId: "sink", x: 1, y: 1, rotation: 0 },
    ]);
    const grid = state.floors[0]!;
    expect(isStandable(grid, 0, 0)).toBe(true);
    expect(isStandable(grid, 3, 2)).toBe(false); // Wall.
    expect(isStandable(grid, 1, 1)).toBe(false); // Sink.
    expect(isStandable(grid, 1, 1, 1)).toBe(true); // Unless it's the item being moved.
    expect(isStandable(grid, 7, 7)).toBe(false); // Grass.
    expect(isStandable(grid, -1, 0)).toBe(false); // Off the map.
  });
});

describe("access sides", () => {
  it("lists a reception desk's patient front and staff back", () => {
    // 3×1 desk at (2, 2) facing down: patients below, staff above.
    const r = footprintRect("reception_desk", 2, 2, 0);
    const tiles = accessTiles("reception_desk", r, 0);
    expect(tiles.filter((t) => t.who === "user").map((t) => t.y)).toEqual([3, 3, 3]);
    expect(tiles.filter((t) => t.who === "staff").map((t) => t.y)).toEqual([1, 1, 1]);
    expect(tiles.every((t) => t.side === (t.who === "user" ? "front" : "back"))).toBe(true);
  });

  it("rotates the staff side with the item", () => {
    // Rotation 1 faces left, so staff stand to the right.
    const r = footprintRect("reception_desk", 2, 2, 1);
    const staff = accessTiles("reception_desk", r, 1).filter((t) => t.who === "staff");
    expect(staff).toHaveLength(3);
    expect(staff.every((t) => t.x === 3)).toBe(true);
  });

  it("gives lateral edges for 'sides'", () => {
    // A 3×1 footprint facing down has its sides at x = 1 and x = 5.
    const r = { x: 2, y: 2, w: 3, h: 1 };
    expect(sideTiles(r, 0, "sides")).toEqual([
      { x: 1, y: 2 },
      { x: 5, y: 2 },
    ]);
  });

  it("has no access tiles for symmetric items", () => {
    expect(accessTiles("plant", footprintRect("plant", 0, 0, 0), 0)).toEqual([]);
  });
});
