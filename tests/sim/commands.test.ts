import { describe, expect, it } from "vitest";
import { equipmentById } from "@data/catalogue";
import { RESALE_FRACTION } from "@data/economy";
import { FOUNDATION_COST_PER_TILE } from "@data/structures";
import { applyCommand, planCommand } from "@sim/commands";
import { createSimState } from "@sim/state";
import { FloorType, tileIndex, WallType } from "@sim/world/grid";
import { isStandable } from "@sim/world/objects";
import { applyAll } from "../fixtures/smallAE";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

function floored(money = 1_000_000) {
  const state = createSimState({ seed: 1, width: 12, height: 12, money: money + 144 * 1200 });
  applyAll(state, [{ type: "build_floor", floor: 0, rect: rect(0, 0, 12, 12) }]);
  return state;
}

describe("build_floor", () => {
  it("charges per new tile and ignores existing floor", () => {
    const state = createSimState({ seed: 1, width: 10, height: 10, money: 100_000 });
    const first = applyCommand(state, { type: "build_floor", floor: 0, rect: rect(0, 0, 3, 2) });
    expect(first).toMatchObject({ ok: true, count: 6, cost: 6 * FOUNDATION_COST_PER_TILE });
    const again = applyCommand(state, { type: "build_floor", floor: 0, rect: rect(0, 0, 4, 2) });
    expect(again).toMatchObject({ ok: true, count: 2 });
    expect(state.money).toBe(100_000 - 8 * FOUNDATION_COST_PER_TILE);
  });

  it("clips to the map", () => {
    const state = createSimState({ seed: 1, width: 4, height: 4, money: 100_000 });
    expect(
      planCommand(state, { type: "build_floor", floor: 0, rect: rect(2, 2, 10, 10) }).count,
    ).toBe(4);
  });

  it("refuses when unaffordable and changes nothing", () => {
    const state = createSimState({ seed: 1, width: 10, height: 10, money: 1000 });
    const r = applyCommand(state, { type: "build_floor", floor: 0, rect: rect(0, 0, 2, 2) });
    expect(r).toMatchObject({ ok: false, error: "Not enough money" });
    expect(state.money).toBe(1000);
    expect(state.floors[0]!.floorType.every((t) => t === FloorType.Grass)).toBe(true);
  });
});

describe("planCommand", () => {
  it("never mutates state", () => {
    const state = floored();
    const before = JSON.stringify({ ...state, floors: state.floors.map((g) => [...g.wall]) });
    planCommand(state, { type: "build_walls", floor: 0, rect: rect(0, 0, 5, 5), wall: 1 });
    planCommand(state, { type: "place_object", floor: 0, defId: "sink", x: 1, y: 1, rotation: 0 });
    expect(JSON.stringify({ ...state, floors: state.floors.map((g) => [...g.wall]) })).toBe(before);
  });
});

describe("build_walls", () => {
  it("draws only the outline of the dragged rect", () => {
    const state = floored();
    const r = applyCommand(state, {
      type: "build_walls",
      floor: 0,
      rect: rect(0, 0, 4, 3),
      wall: WallType.Standard,
    });
    expect(r.count).toBe(10);
    const grid = state.floors[0]!;
    expect(grid.wall[tileIndex(grid, 1, 1)]).toBe(WallType.None);
    expect(grid.wall[tileIndex(grid, 3, 2)]).toBe(WallType.Standard);
  });

  it("lays foundations under walls built on grass", () => {
    const state = createSimState({ seed: 1, width: 10, height: 10, money: 100_000 });
    const r = applyCommand(state, {
      type: "build_walls",
      floor: 0,
      rect: rect(0, 0, 1, 2),
      wall: WallType.Standard,
    });
    expect(r.cost).toBe(2 * (FOUNDATION_COST_PER_TILE + 350));
  });

  it("is blocked by equipment but keeps existing doors", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(1, 1, 5, 5), wall: WallType.Standard },
      { type: "place_object", floor: 0, defId: "door_single", x: 3, y: 1, rotation: 0 },
    ]);
    // Redraw the same outline: the door survives and nothing is charged.
    expect(
      planCommand(state, { type: "build_walls", floor: 0, rect: rect(1, 1, 5, 5), wall: 1 }).count,
    ).toBe(0);
    applyAll(state, [{ type: "place_object", floor: 0, defId: "sink", x: 7, y: 2, rotation: 0 }]);
    expect(
      planCommand(state, { type: "build_walls", floor: 0, rect: rect(7, 0, 1, 5), wall: 1 }),
    ).toMatchObject({ ok: false, error: "Blocked by Hand-wash sink" });
  });
});

describe("doors", () => {
  function wallLine() {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 5, 12, 1), wall: WallType.Standard },
    ]);
    return state;
  }

  it("replace wall tiles and refund on demolish", () => {
    const state = wallLine();
    const grid = state.floors[0]!;
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "door_double", x: 4, y: 5, rotation: 0 },
    ]);
    expect(grid.wall[tileIndex(grid, 4, 5)]).toBe(WallType.None);
    expect(grid.door[tileIndex(grid, 5, 5)]).toBe(2);
    // Demolishing one half removes the whole door.
    const r = applyCommand(state, { type: "demolish", floor: 0, rect: rect(5, 5, 1, 1) });
    expect(r).toMatchObject({ ok: true, count: 1, cost: -2400 * RESALE_FRACTION });
    expect(grid.door[tileIndex(grid, 4, 5)]).toBe(0);
    expect(Object.keys(state.objects)).toHaveLength(0);
  });

  it("must sit in a wall with open space on both sides", () => {
    const state = wallLine();
    const door = (x: number, y: number, rotation: 0 | 1) =>
      planCommand(state, { type: "place_object", floor: 0, defId: "door_single", x, y, rotation })
        .error;
    expect(door(3, 3, 0)).toBe("Doors go in walls");
    expect(door(3, 5, 1)).toBe("A door needs open space on both sides");
    expect(door(3, 5, 0)).toBeUndefined();
  });
});

describe("equipment", () => {
  it("rotates footprints and blocks overlaps", () => {
    const state = floored();
    applyAll(state, [
      // Rotation 3 faces right, into the room rather than off the map.
      { type: "place_object", floor: 0, defId: "waiting_bench", x: 0, y: 0, rotation: 3 },
    ]);
    const grid = state.floors[0]!;
    expect(grid.objectId[tileIndex(grid, 0, 2)]).toBe(1);
    expect(grid.objectId[tileIndex(grid, 1, 0)]).toBe(-1);
    const r = planCommand(state, {
      type: "place_object",
      floor: 0,
      defId: "sink",
      x: 0,
      y: 2,
      rotation: 0,
    });
    expect(r.error).toBe("Something is already here");
  });

  it("needs floor and deducts the price", () => {
    const state = createSimState({ seed: 1, width: 5, height: 5, money: 10_000 });
    const cmd = { type: "place_object", floor: 0, defId: "sink", x: 0, y: 0, rotation: 0 } as const;
    expect(planCommand(state, cmd).error).toBe("Needs floor (foundations)");
    // Two tiles: one for the sink and one in front of it to stand on.
    applyAll(state, [{ type: "build_floor", floor: 0, rect: rect(0, 0, 1, 2) }]);
    applyAll(state, [cmd]);
    expect(state.money).toBe(10_000 - 2 * 1200 - equipmentById.get("sink")!.cost);
  });

  it("sells for the resale fraction, leaving doors alone", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 5, 12, 1), wall: WallType.Standard },
      { type: "place_object", floor: 0, defId: "door_single", x: 1, y: 5, rotation: 0 },
      { type: "place_object", floor: 0, defId: "ventilator", x: 1, y: 6, rotation: 0 },
    ]);
    const r = applyCommand(state, { type: "remove_objects", floor: 0, rect: rect(0, 0, 12, 12) });
    expect(r).toMatchObject({ ok: true, count: 1, cost: -28000 * RESALE_FRACTION });
    expect(Object.values(state.objects).map((o) => o.defId)).toEqual(["door_single"]);
  });
});

describe("remove_floor", () => {
  it("clears everything on the tiles and refunds", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 0, 3, 3), wall: WallType.Standard },
      { type: "zone", floor: 0, rect: rect(4, 4, 2, 2), roomType: "corridor" },
      { type: "place_object", floor: 0, defId: "trolley", x: 4, y: 4, rotation: 0 },
    ]);
    const before = state.money;
    // Only touches the trolley's top tile, but removes the whole trolley.
    const r = applyCommand(state, { type: "remove_floor", floor: 0, rect: rect(0, 0, 6, 5) });
    expect(r.ok).toBe(true);
    expect(state.money).toBeGreaterThan(before);
    const grid = state.floors[0]!;
    expect(grid.wall.every((w) => w === 0)).toBe(true);
    expect(grid.objectId.every((o) => o === -1)).toBe(true);
    expect(state.rooms).toHaveLength(1); // The corridor's surviving row.
    expect(grid.floorType[tileIndex(grid, 4, 5)]).toBe(FloorType.Floor);
  });
});

describe("zone", () => {
  it("only paints floor tiles and is free", () => {
    const state = createSimState({ seed: 1, width: 6, height: 6, money: 100_000 });
    applyAll(state, [{ type: "build_floor", floor: 0, rect: rect(0, 0, 2, 2) }]);
    const r = applyCommand(state, {
      type: "zone",
      floor: 0,
      rect: rect(0, 0, 4, 4),
      roomType: "corridor",
    });
    expect(r).toMatchObject({ ok: true, count: 4, cost: 0 });
    expect(
      planCommand(state, { type: "zone", floor: 0, rect: rect(4, 4, 2, 2), roomType: "corridor" })
        .error,
    ).toBe("Rooms need floor");
  });
});

describe("move_object", () => {
  function withCouch() {
    const state = floored();
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "exam_couch", x: 2, y: 2, rotation: 0 },
    ]);
    return state;
  }
  const move = (x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0, id = 1) =>
    ({ type: "move_object", floor: 0, id, x, y, rotation }) as const;

  it("moves for free, updating the grid", () => {
    const state = withCouch();
    const money = state.money;
    expect(applyCommand(state, move(6, 6))).toMatchObject({ ok: true, cost: 0 });
    const grid = state.floors[0]!;
    expect(state.money).toBe(money);
    expect(grid.objectId[tileIndex(grid, 2, 2)]).toBe(-1);
    expect(grid.objectId[tileIndex(grid, 6, 7)]).toBe(1);
    expect(state.objects[1]).toMatchObject({ x: 6, y: 6, rotation: 0 });
  });

  it("can overlap its own old tiles and rotate in place", () => {
    const state = withCouch();
    applyAll(state, [move(2, 3)]);
    applyAll(state, [move(2, 3, 1)]);
    const grid = state.floors[0]!;
    expect(grid.objectId[tileIndex(grid, 3, 3)]).toBe(1);
    expect(grid.objectId[tileIndex(grid, 2, 4)]).toBe(-1);
  });

  it("is blocked by other items, walls and missing floor", () => {
    const state = withCouch();
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "sink", x: 5, y: 5, rotation: 0 },
      { type: "build_walls", floor: 0, rect: rect(8, 0, 1, 12), wall: WallType.Standard },
    ]);
    expect(planCommand(state, move(5, 4)).error).toBe("Something is already here");
    expect(planCommand(state, move(8, 4)).error).toBe("Blocked by a wall");
    expect(planCommand(state, move(11, 11)).error).toBe("Off the map");
    expect(planCommand(state, move(2, 2)).error).toBe("Nothing to change here");
  });

  it("won't move doors", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 5, 12, 1), wall: WallType.Standard },
      { type: "place_object", floor: 0, defId: "door_single", x: 3, y: 5, rotation: 0 },
    ]);
    expect(planCommand(state, move(4, 5)).error).toBe("Only equipment can be moved");
  });

  it("updates room validity when an item moves in or out", () => {
    const state = floored();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 3, 3), roomType: "toilets" },
      { type: "place_object", floor: 0, defId: "toilet", x: 6, y: 6, rotation: 0 },
    ]);
    const hasToilet = () => state.rooms[0]!.checks.find((c) => c.label === "Toilet")!.ok;
    expect(hasToilet()).toBe(false);
    applyAll(state, [move(1, 1)]);
    expect(hasToilet()).toBe(true);
  });
});

describe("item fronts must stay reachable", () => {
  const chair = (x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0) =>
    ({ type: "place_object", floor: 0, defId: "waiting_chair", x, y, rotation }) as const;

  it("refuses items facing a wall, another item, grass or the map edge", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 6, 12, 1), wall: WallType.Standard },
      chair(2, 2),
    ]);
    expect(planCommand(state, chair(4, 5)).error).toBe("Its front (arrow side) is blocked");
    // (2,3) is in front of the first chair.
    expect(planCommand(state, chair(2, 3)).error).toBe("Would block access to Waiting chair");
    expect(planCommand(state, chair(5, 0, 2)).error).toBe("Its front (arrow side) is blocked");
    expect(planCommand(state, chair(4, 4)).ok).toBe(true);
    // Every tile of a wide item's front must be clear.
    expect(
      planCommand(state, {
        type: "place_object",
        floor: 0,
        defId: "waiting_bench",
        x: 1,
        y: 1,
        rotation: 0,
      }).error,
    ).toBe("Its front (arrow side) is blocked");
  });

  it("lets symmetric items go anywhere", () => {
    const state = floored();
    expect(
      planCommand(state, {
        type: "place_object",
        floor: 0,
        defId: "plant",
        x: 0,
        y: 11,
        rotation: 0,
      }).ok,
    ).toBe(true);
  });

  it("won't let walls, items or floor removal block an existing item", () => {
    const state = floored();
    applyAll(state, [chair(5, 5)]);
    expect(
      planCommand(state, { type: "build_walls", floor: 0, rect: rect(0, 6, 12, 1), wall: 1 }).error,
    ).toBe("Would block access to Waiting chair");
    expect(
      planCommand(state, {
        type: "place_object",
        floor: 0,
        defId: "plant",
        x: 5,
        y: 6,
        rotation: 0,
      }).error,
    ).toBe("Would block access to Waiting chair");
    expect(
      planCommand(state, { type: "remove_floor", floor: 0, rect: rect(5, 6, 1, 1) }).error,
    ).toBe("Would block access to Waiting chair");
    // Removing the chair's own floor takes the chair with it, which is fine.
    expect(planCommand(state, { type: "remove_floor", floor: 0, rect: rect(5, 5, 1, 2) }).ok).toBe(
      true,
    );
  });

  it("checks moves too, ignoring the moved item's old tiles", () => {
    const state = floored();
    applyAll(state, [chair(5, 5), chair(5, 7, 2)]);
    const move = (x: number, y: number, rotation: 0 | 1 | 2 | 3) =>
      planCommand(state, { type: "move_object", floor: 0, id: 1, x, y, rotation });
    // Chair 2 at (5,7) faces up onto (5,6): chair 1 can't move there, even
    // facing back onto its own old tile.
    expect(move(5, 6, 2).error).toBe("Would block access to Waiting chair");
    // Turning chair 1 round to face up is fine: its front would be (5,4).
    expect(move(5, 5, 2).ok).toBe(true);
  });
});

describe("staffed items", () => {
  const desk = (x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0) =>
    ({ type: "place_object", floor: 0, defId: "reception_desk", x, y, rotation }) as const;

  it("needs room for staff behind as well as patients in front", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 0, 12, 1), wall: WallType.Standard },
    ]);
    // Back against the wall: nowhere for the receptionist.
    expect(planCommand(state, desk(2, 1)).error).toBe("No room for staff on its blue side");
    // One row out from the wall leaves a staff row behind it.
    expect(planCommand(state, desk(2, 2)).ok).toBe(true);
  });

  it("protects the staff side from later building", () => {
    const state = floored();
    applyAll(state, [desk(2, 4)]);
    expect(
      planCommand(state, { type: "build_walls", floor: 0, rect: rect(0, 3, 12, 1), wall: 1 }).error,
    ).toBe("Would block access to Reception desk");
    expect(
      planCommand(state, {
        type: "place_object",
        floor: 0,
        defId: "plant",
        x: 3,
        y: 3,
        rotation: 0,
      }).error,
    ).toBe("Would block access to Reception desk");
  });
});

describe("bedside access", () => {
  const bed = (x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0) =>
    ({ type: "place_object", floor: 0, defId: "hospital_bed", x, y, rotation }) as const;

  it("lets a bed stand against a wall with its other side clear", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 0, 1, 12), wall: WallType.Standard },
    ]);
    expect(planCommand(state, bed(1, 2)).ok).toBe(true);
  });

  it("refuses a bed with neither long side clear", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 0, 1, 12), wall: WallType.Standard },
      { type: "build_walls", floor: 0, rect: rect(2, 0, 1, 12), wall: WallType.Standard },
    ]);
    expect(planCommand(state, bed(1, 2)).error).toBe("Staff need one long side clear");
  });

  it("allows blocking one side but not the last clear one", () => {
    const state = floored();
    applyAll(state, [bed(5, 2)]);
    const plant = (x: number, y: number) =>
      ({ type: "place_object", floor: 0, defId: "plant", x, y, rotation: 0 }) as const;
    applyAll(state, [plant(4, 2)]); // Left side now partly blocked; right is clear.
    expect(planCommand(state, plant(6, 3)).error).toBe("Would block access to Hospital bed");
  });
});

describe("wall and ceiling fixtures", () => {
  /** A 12×12 floored map with a wall along the top row. */
  function withTopWall() {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 0, 12, 1), wall: WallType.Standard },
    ]);
    return state;
  }
  const place = (defId: string, x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0) =>
    ({ type: "place_object", floor: 0, defId, x, y, rotation }) as const;

  it("needs a wall behind a wall-mounted item", () => {
    const state = withTopWall();
    expect(planCommand(state, place("oxygen_point", 3, 1)).ok).toBe(true);
    expect(planCommand(state, place("oxygen_point", 3, 5)).error).toBe(
      "Needs a wall behind it (the dark edge)",
    );
    expect(planCommand(state, place("oxygen_point", 3, 0)).error).toBe(
      "Mount it beside a wall, not on it",
    );
  });

  it("hangs a ceiling item anywhere over floor", () => {
    const state = withTopWall();
    expect(planCommand(state, place("privacy_curtain", 6, 6)).ok).toBe(true);
  });

  it("shares a tile with a floor item and doesn't block anyone standing there", () => {
    const state = withTopWall();
    // Bed head against the wall, oxygen and monitor on the wall beside it.
    applyAll(state, [
      place("hospital_bed", 5, 1),
      place("oxygen_point", 4, 1),
      place("bedside_monitor", 6, 1),
      place("privacy_curtain", 5, 1), // Over the bed itself.
    ]);
    const grid = state.floors[0]!;
    expect(grid.objectId[tileIndex(grid, 4, 1)]).toBe(-1);
    expect(grid.mountId[tileIndex(grid, 4, 1)]).toBe(2);
    expect(grid.objectId[tileIndex(grid, 5, 1)]).toBe(1);
    expect(grid.mountId[tileIndex(grid, 5, 1)]).toBe(4);
    // The bed's side tiles are still standable: fixtures take no floor space.
    expect(isStandable(grid, 4, 1)).toBe(true);
    expect(isStandable(grid, 6, 1)).toBe(true);
    expect(planCommand(state, place("oxygen_point", 4, 1)).error).toBe(
      "Something is already mounted here",
    );
  });

  it("protects the wall a fixture hangs on", () => {
    const state = withTopWall();
    applyAll(state, [place("bedside_monitor", 3, 1)]);
    const expected = "Would leave the Bedside monitor with no wall";
    expect(planCommand(state, { type: "demolish", floor: 0, rect: rect(3, 0, 1, 1) }).error).toBe(
      expected,
    );
    expect(
      planCommand(state, { type: "remove_floor", floor: 0, rect: rect(3, 0, 1, 1) }).error,
    ).toBe(expected);
    // Removing the fixture's own floor takes it with it, which is fine.
    expect(planCommand(state, { type: "remove_floor", floor: 0, rect: rect(3, 0, 1, 2) }).ok).toBe(
      true,
    );
    // A wall elsewhere is fine to demolish.
    expect(planCommand(state, { type: "demolish", floor: 0, rect: rect(8, 0, 1, 1) }).ok).toBe(
      true,
    );
  });

  it("won't let a door replace a fixture's wall, or a wall be built over one", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: 0, rect: rect(0, 5, 12, 1), wall: WallType.Standard },
      place("hand_gel", 3, 6),
    ]);
    expect(planCommand(state, place("door_single", 3, 5)).error).toBe(
      "Would leave the Hand gel station with no wall",
    );
    expect(
      planCommand(state, { type: "build_walls", floor: 0, rect: rect(0, 6, 12, 1), wall: 1 }).error,
    ).toBe("Blocked by Hand gel station");
  });

  it("sells, moves and removes fixtures without disturbing what's below", () => {
    const state = withTopWall();
    applyAll(state, [place("hospital_bed", 5, 1), place("privacy_curtain", 5, 1)]);
    // Selling one item by id leaves the bed.
    applyAll(state, [{ type: "remove_object", floor: 0, id: 2 }]);
    expect(Object.values(state.objects).map((o) => o.defId)).toEqual(["hospital_bed"]);
    // Moving a fixture moves its layer.
    applyAll(state, [place("oxygen_point", 3, 1)]);
    applyAll(state, [{ type: "move_object", floor: 0, id: 3, x: 8, y: 1, rotation: 0 }]);
    const grid = state.floors[0]!;
    expect(grid.mountId[tileIndex(grid, 3, 1)]).toBe(-1);
    expect(grid.mountId[tileIndex(grid, 8, 1)]).toBe(3);
  });
});
