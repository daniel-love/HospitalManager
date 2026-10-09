/**
 * Footpaths and access roads (ROADMAP M3.5 step 2).
 */
import { describe, expect, it } from "vitest";
import { RESALE_FRACTION } from "@data/economy";
import { FOUNDATION_COST_PER_TILE, surfaces } from "@data/structures";
import { decodeSave, encodeSave } from "@save/codec";
import { applyCommand, PAVE_OVER_FLOOR, planCommand, PUBLIC_LAND } from "@sim/commands";
import { addToPlan, buildPreview, planDiff } from "@sim/plan";
import { createSimState } from "@sim/state";
import { parkingSpaces } from "@sim/systems/ambulances";
import { FloorType, tileIndex, WallType } from "@sim/world/grid";
import { isStandable } from "@sim/world/objects";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const PATH = surfaces.find((s) => s.id === "path")!.costPerTile;
const ROAD = surfaces.find((s) => s.id === "road")!.costPerTile;
const half = (n: number) => Math.round(n * RESALE_FRACTION);

const blank = () => createSimState({ seed: 1, width: 12, height: 12, money: 100_000 });
const pave = (r: ReturnType<typeof rect>, surface: "path" | "road") =>
  ({ type: "pave", floor: 0, rect: r, surface }) as const;

describe("paving", () => {
  it("lays footpath on grass, and swaps it for access road at a discount", () => {
    const state = blank();
    const grid = state.floors[0]!;
    expect(applyCommand(state, pave(rect(0, 0, 3, 2), "path"))).toMatchObject({
      ok: true,
      count: 6,
      cost: 6 * PATH,
    });
    expect(grid.floorType[tileIndex(grid, 2, 1)]).toBe(FloorType.Path);
    expect(planCommand(state, pave(rect(0, 0, 3, 2), "path")).ok).toBe(false);
    const road = applyCommand(state, pave(rect(0, 0, 1, 2), "road"));
    expect(road.cost).toBe(2 * (ROAD - half(PATH)));
    expect(grid.floorType[tileIndex(grid, 0, 0)]).toBe(FloorType.Road);
  });

  it("won't pave over a building or the council's road", () => {
    const state = blank();
    applyCommand(state, { type: "build_floor", floor: 0, rect: rect(0, 0, 2, 2) });
    expect(planCommand(state, pave(rect(0, 0, 2, 2), "path")).error).toBe(PAVE_OVER_FLOOR);
    // Partly over floor: only the grass is paved.
    expect(planCommand(state, pave(rect(0, 0, 3, 2), "path")).count).toBe(2);

    const site = createSimState({ seed: 1, width: 40, height: 40, site: true });
    expect(planCommand(site, pave(rect(0, 26, 3, 2), "path")).error).toBe(PUBLIC_LAND);
  });

  it("is dug up for half back by foundations, walls and floor removal", () => {
    const state = blank();
    const grid = state.floors[0]!;
    applyCommand(state, pave(rect(0, 0, 4, 1), "path"));
    applyCommand(state, pave(rect(0, 1, 4, 1), "road"));
    const floor = planCommand(state, { type: "build_floor", floor: 0, rect: rect(0, 0, 1, 1) });
    expect(floor.cost).toBe(FOUNDATION_COST_PER_TILE - half(PATH));
    const wall = planCommand(state, {
      type: "build_walls",
      floor: 0,
      rect: rect(1, 1, 1, 1),
      wall: WallType.Standard,
    });
    expect(wall.cost).toBe(350 + FOUNDATION_COST_PER_TILE - half(ROAD));
    const removed = applyCommand(state, { type: "remove_floor", floor: 0, rect: rect(2, 0, 1, 2) });
    expect(removed.cost).toBe(-(half(PATH) + half(ROAD)));
    expect(grid.floorType[tileIndex(grid, 2, 0)]).toBe(FloorType.Grass);
    expect(grid.floorType[tileIndex(grid, 2, 1)]).toBe(FloorType.Grass);
  });

  it("is somewhere to stand, unlike grass", () => {
    const state = blank();
    const grid = state.floors[0]!;
    applyCommand(state, pave(rect(0, 0, 1, 1), "path"));
    expect(isStandable(grid, 0, 0)).toBe(true);
    expect(isStandable(grid, 1, 0)).toBe(false);
  });
});

describe("an Ambulance Bay on the access road", () => {
  it("zones on tarmac and parks an ambulance", () => {
    const state = blank();
    applyCommand(state, pave(rect(1, 1, 3, 6), "road"));
    const zoned = applyCommand(state, {
      type: "zone",
      floor: 0,
      rect: rect(1, 1, 3, 6),
      roomType: "ambulance_bay",
    });
    expect(zoned).toMatchObject({ ok: true, count: 18, cost: 0 });
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]!.valid).toBe(true);
    expect(parkingSpaces(state)).toEqual([{ x: 1, y: 1, w: 3, h: 6 }]);
  });

  it("is the only room that can go on tarmac, and never on a footpath", () => {
    const state = blank();
    applyCommand(state, pave(rect(0, 0, 4, 4), "road"));
    applyCommand(state, pave(rect(6, 0, 4, 4), "path"));
    const zone = (x: number, roomType: string) =>
      planCommand(state, { type: "zone", floor: 0, rect: rect(x, 0, 4, 4), roomType });
    expect(zone(0, "waiting_area").error).toBe("Rooms need floor");
    expect(zone(6, "ambulance_bay").error).toBe("Needs access road or floor");
  });

  it("loses its zoning when the tarmac becomes a footpath, and can be unzoned", () => {
    const state = blank();
    const grid = state.floors[0]!;
    applyCommand(state, pave(rect(0, 0, 3, 6), "road"));
    const bay = { type: "zone", floor: 0, rect: rect(0, 0, 3, 6) } as const;
    applyCommand(state, { ...bay, roomType: "ambulance_bay" });
    applyCommand(state, { ...bay, rect: rect(0, 0, 3, 1), roomType: null });
    expect(grid.zone[tileIndex(grid, 0, 0)]).toBe(0);
    applyCommand(state, pave(rect(0, 1, 3, 1), "path"));
    expect(grid.zone[tileIndex(grid, 0, 1)]).toBe(0);
    expect(grid.zone[tileIndex(grid, 0, 2)]).not.toBe(0);
  });
});

describe("paving in plans", () => {
  it("shows planned paving and saves it", () => {
    const state = blank();
    applyCommand(state, pave(rect(0, 0, 2, 1), "path"));
    const { preview } = buildPreview(state);
    addToPlan(state, preview, pave(rect(0, 0, 3, 1), "road"));
    const after = buildPreview(state).preview;
    expect(planDiff(state, after.state).added).toHaveLength(3);
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "plan")))).state;
    expect(loaded.plan).toEqual(state.plan);
  });
});
