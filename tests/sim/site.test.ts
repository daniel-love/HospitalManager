import { describe, expect, it } from "vitest";
import { whereIs } from "@game/describe";
import { applyCommand, planCommand, PUBLIC_LAND } from "@sim/commands";
import { createSimState } from "@sim/state";
import { FloorType, isPublic, tileIndex, WallType } from "@sim/world/grid";
import { SITE_BAND } from "@sim/world/site";

const newSite = () => createSimState({ seed: 1, width: 40, height: 40, site: true });

describe("the public road", () => {
  it("runs across the map a little south of the middle", () => {
    const state = newSite();
    const grid = state.floors[0]!;
    expect(state.site).toEqual({
      road: { x: 0, y: 26, w: 40, h: 6 },
      pavements: [
        { x: 0, y: 24, w: 40, h: 2 },
        { x: 0, y: 32, w: 40, h: 2 },
      ],
      busStop: { x: 16, y: 24 },
    });
    const column = (x: number) =>
      Array.from({ length: 40 }, (_, y) => grid.floorType[tileIndex(grid, x, y)]);
    for (const x of [0, 20, 39]) {
      expect(column(x).slice(22, 36)).toEqual([0, 0, 2, 2, 3, 3, 3, 3, 3, 3, 2, 2, 0, 0]);
    }
    const publicTiles = grid.land.reduce((n, l) => n + l, 0);
    expect(publicTiles).toBe(40 * SITE_BAND);
  });

  it("isn't laid out unless asked for, or on a map too small for it", () => {
    expect(createSimState({ seed: 1, width: 40, height: 40 }).site).toBeNull();
    const tiny = createSimState({ seed: 1, width: 24, height: 20, site: true });
    expect(tiny.site).toBeNull();
    expect(tiny.floors[0]!.land.every((l) => l === 0)).toBe(true);
  });

  it("can't be built on or dug up", () => {
    const state = newSite();
    const onRoad = { x: 5, y: 25, w: 4, h: 4 };
    for (const type of ["build_floor", "remove_floor"] as const) {
      expect(planCommand(state, { type, floor: 0, rect: onRoad }).error).toBe(PUBLIC_LAND);
    }
    const wall = { type: "build_walls", floor: 0, rect: onRoad, wall: WallType.Standard } as const;
    expect(planCommand(state, wall).error).toBe(PUBLIC_LAND);
    const zone = { type: "zone", floor: 0, rect: onRoad, roomType: "waiting_area" } as const;
    expect(planCommand(state, zone).ok).toBe(false);
  });

  it("is left alone by foundations laid across it", () => {
    const state = newSite();
    const grid = state.floors[0]!;
    const money = state.money;
    // 3 grass rows and the 2 pavement rows: only the grass is built on.
    const result = applyCommand(state, {
      type: "build_floor",
      floor: 0,
      rect: { x: 10, y: 21, w: 2, h: 5 },
    });
    expect(result.count).toBe(6);
    expect(money - state.money).toBe(result.cost);
    expect(grid.floorType[tileIndex(grid, 10, 23)]).toBe(FloorType.Floor);
    expect(grid.floorType[tileIndex(grid, 10, 24)]).toBe(FloorType.Path);
    // Removing it again leaves the pavement.
    applyCommand(state, { type: "remove_floor", floor: 0, rect: { x: 10, y: 21, w: 2, h: 5 } });
    expect(grid.floorType[tileIndex(grid, 10, 23)]).toBe(FloorType.Grass);
    expect(grid.floorType[tileIndex(grid, 10, 24)]).toBe(FloorType.Path);
    expect(isPublic(grid, tileIndex(grid, 10, 24))).toBe(true);
  });

  it("is described as the road and pavement", () => {
    const state = newSite();
    expect(whereIs(state, { x: 3, y: 24 })).toBe("Pavement");
    expect(whereIs(state, { x: 3, y: 28 })).toBe("Road");
    expect(whereIs(state, { x: 3, y: 10 })).toBe("Outside");
  });
});
