/**
 * Multiple floors, part 1 (ROADMAP M7 step 2): upper floors stack on
 * foundations, first-floor link bridges span short gaps, A&E and the
 * mortuary stay on the ground floor, and agents walk on their own floor.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGE_COST_FACTOR,
  BRIDGE_MAX_SPAN,
  FOUNDATION_COST_PER_TILE,
  MAX_FLOORS,
  UPPER_FLOOR_COST_FACTOR,
} from "@data/structures";
import { decodeSave, encodeSave } from "@save/codec";
import { migrate } from "@save/migrations";
import type { AgentBase } from "@sim/agents";
import { applyCommand, planCommand } from "@sim/commands";
import { createSimState, type SimState } from "@sim/state";
import { headTo, moveAgents } from "@sim/systems/movement";
import { FloorType, tileIndex, WallType } from "@sim/world/grid";
import { roomAt } from "@sim/world/rooms";
import { BRIDGE_CORRIDOR_ONLY, HOLDS_UP_FLOOR_ABOVE, NO_SUPPORT } from "@sim/world/storeys";
import { walkRouteExists } from "@sim/world/walkRegions";
import { applyAll } from "../fixtures/smallAE";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** Two 6×6 buildings on a 30×10 plot, `gap` tiles of grass apart. */
function twoBuildings(gap: number): SimState {
  const state = createSimState({ seed: 1, width: 30, height: 10, money: 10_000_000 });
  applyAll(state, [
    { type: "build_floor", floor: 0, rect: rect(1, 1, 6, 6) },
    { type: "build_floor", floor: 0, rect: rect(7 + gap, 1, 6, 6) },
  ]);
  return state;
}

const floorType = (state: SimState, floor: number, x: number, y: number) =>
  state.floors[floor]!.floorType[tileIndex(state.floors[floor]!, x, y)];

describe("an upper floor", () => {
  it("is started by building on it, over the ground floor's footprint", () => {
    const state = twoBuildings(4);
    expect(state.floors).toHaveLength(1);
    const plan = planCommand(state, { type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) });
    expect(plan).toMatchObject({ ok: true, count: 36 });
    expect(state.floors).toHaveLength(1); // A preview builds nothing.

    const r = applyCommand(state, { type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) });
    expect(r).toMatchObject({
      ok: true,
      count: 36,
      cost: 36 * Math.round(FOUNDATION_COST_PER_TILE * UPPER_FLOOR_COST_FACTOR),
    });
    expect(state.floors).toHaveLength(2);
    expect(floorType(state, 1, 1, 1)).toBe(FloorType.Floor);
    expect(floorType(state, 1, 0, 0)).toBe(FloorType.Void);
  });

  it("can't overhang open ground, and the floor above needs one below it", () => {
    const state = twoBuildings(12);
    const over = applyCommand(state, { type: "build_floor", floor: 1, rect: rect(0, 0, 1, 1) });
    expect(over).toMatchObject({ ok: false, error: NO_SUPPORT });
    expect(state.floors).toHaveLength(1); // Nothing built, so no new storey either.
    // The second floor up can't be started before the first.
    expect(applyCommand(state, { type: "build_floor", floor: 2, rect: rect(1, 1, 2, 2) }).ok).toBe(
      false,
    );
    applyAll(state, [{ type: "build_floor", floor: 1, rect: rect(1, 1, 3, 3) }]);
    const second = applyCommand(state, { type: "build_floor", floor: 2, rect: rect(1, 1, 6, 6) });
    expect(second).toMatchObject({ ok: true, count: 9 }); // Only over the first floor.
  });

  it(`stops at ${MAX_FLOORS} storeys`, () => {
    const state = twoBuildings(4);
    for (let f = 1; f < MAX_FLOORS; f++) {
      applyAll(state, [{ type: "build_floor", floor: f, rect: rect(1, 1, 2, 2) }]);
    }
    const top = applyCommand(state, {
      type: "build_floor",
      floor: MAX_FLOORS,
      rect: rect(1, 1, 2, 2),
    });
    expect(top.ok).toBe(false);
  });

  it("holds up nothing it can't: the floor beneath can't be taken away", () => {
    const state = twoBuildings(4);
    applyAll(state, [{ type: "build_floor", floor: 1, rect: rect(1, 1, 2, 2) }]);
    const under = applyCommand(state, { type: "remove_floor", floor: 0, rect: rect(1, 1, 1, 1) });
    expect(under).toMatchObject({ ok: false, error: HOLDS_UP_FLOOR_ABOVE });
    // Elsewhere is fine; and upstairs, removing floor leaves open air.
    expect(applyCommand(state, { type: "remove_floor", floor: 0, rect: rect(5, 5, 1, 1) }).ok).toBe(
      true,
    );
    applyAll(state, [{ type: "remove_floor", floor: 1, rect: rect(1, 1, 1, 1) }]);
    expect(floorType(state, 1, 1, 1)).toBe(FloorType.Void);
  });

  it("isn't paved", () => {
    const state = twoBuildings(4);
    applyAll(state, [{ type: "build_floor", floor: 1, rect: rect(1, 1, 2, 2) }]);
    const r = applyCommand(state, {
      type: "pave",
      floor: 1,
      rect: rect(1, 1, 1, 1),
      surface: "path",
    });
    expect(r.ok).toBe(false);
  });
});

describe("a link bridge", () => {
  it(`spans up to ${BRIDGE_MAX_SPAN} tiles of open ground between buildings, as a corridor`, () => {
    const state = twoBuildings(BRIDGE_MAX_SPAN);
    applyAll(state, [
      { type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) },
      { type: "build_floor", floor: 1, rect: rect(7 + BRIDGE_MAX_SPAN, 1, 6, 6) },
    ]);
    const bridge = rect(7, 3, BRIDGE_MAX_SPAN, 2);
    const r = applyCommand(state, { type: "build_floor", floor: 1, rect: bridge });
    expect(r).toMatchObject({
      ok: true,
      count: 2 * BRIDGE_MAX_SPAN,
      cost: 2 * BRIDGE_MAX_SPAN * Math.round(FOUNDATION_COST_PER_TILE * BRIDGE_COST_FACTOR),
    });
    // Traffic still passes underneath.
    expect(floorType(state, 0, 8, 3)).toBe(FloorType.Grass);

    const ward = applyCommand(state, { type: "zone", floor: 1, rect: bridge, roomType: "ward" });
    expect(ward).toMatchObject({ ok: false, error: BRIDGE_CORRIDOR_ONLY });
    const corridor = applyCommand(state, {
      type: "zone",
      floor: 1,
      rect: bridge,
      roomType: "corridor",
    });
    expect(corridor.ok).toBe(true);
    // Upstairs, the two buildings are joined.
    expect(walkRouteExists(state, { x: 2, y: 3, floor: 1 }, { x: 20, y: 3, floor: 1 })).toBe(true);
  });

  it("can't span a wider gap, or be built higher up", () => {
    const state = twoBuildings(BRIDGE_MAX_SPAN + 2);
    applyAll(state, [{ type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) }]);
    const wide = applyCommand(state, {
      type: "build_floor",
      floor: 1,
      rect: rect(7, 3, BRIDGE_MAX_SPAN + 2, 2),
    });
    expect(wide).toMatchObject({ ok: false, error: NO_SUPPORT });
  });
});

describe("A&E and the mortuary", () => {
  it("only work on the ground floor", () => {
    const state = twoBuildings(4);
    applyAll(state, [
      { type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) },
      { type: "build_walls", floor: 1, rect: rect(1, 1, 6, 6), wall: WallType.Standard },
      { type: "place_object", floor: 1, defId: "door_double", x: 3, y: 6, rotation: 0 },
      { type: "zone", floor: 1, rect: rect(2, 2, 4, 4), roomType: "majors_bay" },
    ]);
    const room = roomAt(state, 1, 3, 3)!;
    expect(room.floor).toBe(1);
    expect(room.valid).toBe(false);
    expect(room.checks).toContainEqual(
      expect.objectContaining({ label: "On the ground floor", ok: false }),
    );
  });
});

describe("someone on an upper floor", () => {
  const walker = (floor: number): AgentBase => ({
    id: 999,
    name: "Walker",
    x: 2,
    y: 2,
    floor,
    prevX: 2,
    prevY: 2,
    path: [],
    dest: null,
    pathVersion: 0,
  });

  it("walks about on their own floor", () => {
    const state = twoBuildings(4);
    applyAll(state, [
      { type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) },
      // A wall across the ground floor that isn't there upstairs.
      { type: "build_walls", floor: 0, rect: rect(4, 1, 1, 6), wall: WallType.Standard },
    ]);
    const a = { ...walker(1), patientId: 1, stage: "visiting" as const, until: 100 };
    state.visitors[a.id] = a;
    const to = { x: 6, y: 2, floor: 1 };
    expect(headTo(state, a, to)).toBe("moving");
    for (let i = 0; i < 200 && headTo(state, a, to) !== "arrived"; i++) moveAgents(state);
    expect(headTo(state, a, to)).toBe("arrived");
    expect(a).toMatchObject({ x: 6, y: 2, floor: 1 });
  });

  it("can't yet get to another floor", () => {
    const state = twoBuildings(4);
    applyAll(state, [{ type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) }]);
    expect(headTo(state, walker(1), { x: 3, y: 3, floor: 0 })).toBe("no_route");
  });

  it("stays there through a save and load", () => {
    const state = twoBuildings(4);
    applyAll(state, [{ type: "build_floor", floor: 1, rect: rect(1, 1, 6, 6) }]);
    const a = { ...walker(1), id: state.nextAgentId++ };
    state.visitors[a.id] = {
      ...a,
      patientId: 1,
      stage: "visiting",
      until: 100,
    } as SimState["visitors"][number];
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "test")))).state;
    expect(loaded.floors).toHaveLength(2);
    expect(floorType(loaded, 1, 3, 3)).toBe(FloorType.Floor);
    expect(loaded.visitors[a.id]!.floor).toBe(1);
  });
});

describe("a save from before floors", () => {
  it("puts everyone on the ground floor", () => {
    const old = {
      version: 50,
      state: {
        patients: [{ id: 1 }],
        staff: [{ id: 2 }],
        visitors: [],
        outpatients: [{ id: 3 }],
        tours: [],
        collections: [{ id: 4, crew: { id: 5 } }],
      },
    };
    const m = migrate(old) as {
      state: {
        patients: { floor: number }[];
        staff: { floor: number }[];
        outpatients: { floor: number }[];
        collections: { crew: { floor: number } }[];
      };
    };
    expect(m.state.patients[0]!.floor).toBe(0);
    expect(m.state.staff[0]!.floor).toBe(0);
    expect(m.state.outpatients[0]!.floor).toBe(0);
    expect(m.state.collections[0]!.crew.floor).toBe(0);
  });
});
