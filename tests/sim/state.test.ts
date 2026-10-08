import { describe, expect, it } from "vitest";
import { tick } from "@sim/sim";
import { createSimState } from "@sim/state";
import { FloorType, inBounds, tileIndex } from "@sim/world/grid";

describe("sim state", () => {
  it("creates an empty grass grid of the requested size", () => {
    const state = createSimState({ seed: 1, width: 20, height: 10 });
    const grid = state.floors[0]!;
    expect(grid.floorType.length).toBe(200);
    expect(grid.floorType.every((t) => t === FloorType.Grass)).toBe(true);
    expect(grid.objectId.every((o) => o === -1)).toBe(true);
    expect(tileIndex(grid, 3, 2)).toBe(43);
    expect(inBounds(grid, 19, 9)).toBe(true);
    expect(inBounds(grid, 20, 0)).toBe(false);
    expect(inBounds(grid, 0, -1)).toBe(false);
  });

  it("tick() advances the tick counter", () => {
    const state = createSimState({ seed: 1, width: 4, height: 4 });
    for (let i = 0; i < 5; i++) tick(state);
    expect(state.tick).toBe(5);
  });
});
