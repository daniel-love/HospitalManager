import { describe, expect, it } from "vitest";
import { applyCommand, type Command } from "@sim/commands";
import { addToPlan, buildPreview, commitPlan, planDiff } from "@sim/plan";
import { createSimState } from "@sim/state";
import { FloorType, tileIndex } from "@sim/world/grid";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const floorCmd = (r = rect(0, 0, 4, 4)): Command => ({ type: "build_floor", floor: 0, rect: r });
const chair = (x: number, y: number): Command => ({
  type: "place_object",
  floor: 0,
  defId: "waiting_chair",
  x,
  y,
  rotation: 0,
});

function planWith(money: number, ...cmds: Command[]) {
  const real = createSimState({ seed: 1, width: 12, height: 12, money });
  const { preview } = buildPreview(real);
  for (const c of cmds) expect(addToPlan(real, preview, c).ok).toBe(true);
  return { real, preview };
}

describe("plans", () => {
  it("previews changes and their cost without touching the real hospital", () => {
    const { real, preview } = planWith(1_000_000, floorCmd(), chair(1, 1));
    expect(preview.cost).toBe(16 * 1200 + 150);
    expect(real.money).toBe(1_000_000);
    expect(real.floors[0]!.floorType.every((t) => t === FloorType.Grass)).toBe(true);
    expect(preview.state.floors[0]!.floorType[0]).toBe(FloorType.Floor);
    expect(real.plan).toHaveLength(2);
  });

  it("lets you plan beyond your budget, but not build it", () => {
    const { real, preview } = planWith(1000, floorCmd());
    expect(preview.cost).toBeGreaterThan(real.money);
    expect(commitPlan(real)).toMatchObject({ ok: false });
    // Nothing half-built.
    expect(real.floors[0]!.floorType.every((t) => t === FloorType.Grass)).toBe(true);
    expect(real.plan).toHaveLength(1);
  });

  it("builds the whole plan for real and empties it", () => {
    const { real } = planWith(1_000_000, floorCmd(), chair(1, 1));
    expect(commitPlan(real)).toEqual({ ok: true, cost: 16 * 1200 + 150, steps: 2 });
    expect(real.money).toBe(1_000_000 - 16 * 1200 - 150);
    expect(Object.values(real.objects).map((o) => o.defId)).toEqual(["waiting_chair"]);
    expect(real.plan).toEqual([]);
  });

  it("keeps planned items linked when real building shifts their ids", () => {
    const { real, preview } = planWith(1_000_000, floorCmd(), chair(1, 1));
    // Move the planned chair (planned id 1).
    const move: Command = { type: "move_object", floor: 0, id: 1, x: 2, y: 2, rotation: 0 };
    expect(addToPlan(real, preview, move).ok).toBe(true);

    // Meanwhile, build something real elsewhere: it takes id 1.
    applyCommand(real, floorCmd(rect(8, 8, 2, 2)));
    applyCommand(real, chair(8, 8));
    const { dropped } = buildPreview(real);
    expect(dropped).toBe(0);

    expect(commitPlan(real)).toMatchObject({ ok: true, steps: 3 });
    const chairs = Object.values(real.objects).map((o) => `${o.x},${o.y}`);
    expect(chairs.sort()).toEqual(["2,2", "8,8"]); // The real chair didn't move.
  });

  it("drops steps that no longer fit, and anything that depended on them", () => {
    const { real, preview } = planWith(1_000_000, floorCmd(), chair(1, 1));
    addToPlan(real, preview, { type: "move_object", floor: 0, id: 1, x: 2, y: 2, rotation: 0 });
    // Build a real wall where the planned chair would go.
    applyCommand(real, { type: "build_walls", floor: 0, rect: rect(1, 1, 1, 1), wall: 1 });
    const { preview: rebuilt, dropped } = buildPreview(real);
    expect(dropped).toBe(2); // The chair, and the move of that chair.
    expect(real.plan.map((e) => e.cmd.type)).toEqual(["build_floor"]);
    expect(Object.keys(rebuilt.state.objects)).toEqual([]);
  });

  it("reports which tiles a plan adds to or removes from", () => {
    const real = createSimState({ seed: 1, width: 12, height: 12, money: 1_000_000 });
    applyCommand(real, floorCmd(rect(0, 0, 2, 1)));
    const { preview } = buildPreview(real);
    addToPlan(real, preview, floorCmd(rect(5, 5, 1, 1)));
    addToPlan(real, preview, { type: "remove_floor", floor: 0, rect: rect(0, 0, 1, 1) });
    const grid = real.floors[0]!;
    expect(planDiff(real, preview.state)).toEqual({
      added: [tileIndex(grid, 5, 5)],
      removed: [tileIndex(grid, 0, 0)],
    });
  });
});
