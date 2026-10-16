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
  LIFT,
  MAX_FLOORS,
  STAIRS_TILES_PER_FLOOR,
  UPPER_FLOOR_COST_FACTOR,
} from "@data/structures";
import { decodeSave, encodeSave } from "@save/codec";
import { migrate } from "@save/migrations";
import type { AgentBase, Point } from "@sim/agents";
import { applyCommand, planCommand, type Command } from "@sim/commands";
import { createSimState, type SimState } from "@sim/state";
import { bedRouteExists, decideToAdmit } from "@sim/systems/admissions";
import { spawnPatient } from "@sim/systems/arrivals";
import { removeJob } from "@sim/systems/jobBoard";
import { tick } from "@sim/sim";
import { siteEntrance } from "@sim/places";
import { headTo, moveAgents } from "@sim/systems/movement";
import { updatePortals } from "@sim/systems/portals";
import { FloorType, tileIndex, WallType } from "@sim/world/grid";
import { roomAt } from "@sim/world/rooms";
import { BRIDGE_CORRIDOR_ONLY, HOLDS_UP_FLOOR_ABOVE, NO_SUPPORT } from "@sim/world/storeys";
import { walkRouteExists } from "@sim/world/walkRegions";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { applyAll, hireRegistrars } from "../fixtures/smallAE";

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

  it("can't get to another floor with no stairs or lift", () => {
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
  it("puts everyone on the ground floor, with no lift cars", () => {
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

// ---------- Part 2: stairs and lifts ----------

/**
 * A two-storey block, 16×10, with stairs at (1, 1) and a bed lift at (6, 1)
 * on both floors (each opening downwards), unless left out.
 */
function block(opts: { stairs?: boolean; lift?: boolean } = {}): SimState {
  const state = createSimState({ seed: 1, width: 18, height: 12, money: 10_000_000 });
  const cmds: Command[] = [];
  for (const floor of [0, 1]) {
    cmds.push({ type: "build_floor", floor, rect: rect(0, 0, 16, 10) });
    if (opts.stairs !== false) {
      cmds.push({ type: "place_object", floor, defId: "stairs", x: 1, y: 1, rotation: 0 });
    }
    if (opts.lift !== false) {
      cmds.push({ type: "place_object", floor, defId: "lift", x: 6, y: 1, rotation: 0 });
    }
  }
  applyAll(state, cmds);
  return state;
}

let nextId = 5000;
function person(state: SimState, x: number, y: number, floor: number, staff = false): AgentBase {
  const base = { id: nextId++, name: "Someone", x, y, floor, prevX: x, prevY: y };
  const a = { ...base, path: [], dest: null, pathVersion: 0 };
  if (staff) {
    // Only "role" matters to movement: staff go their own way.
    state.staff[a.id] = { ...a, role: "porter" } as unknown as SimState["staff"][number];
    return state.staff[a.id]!;
  }
  state.visitors[a.id] = { ...a, patientId: 1, stage: "visiting", until: 1e9 };
  return state.visitors[a.id]!;
}

/** Ticks movement for everyone heading where they're sent, until all arrive. */
function go(
  state: SimState,
  trips: { a: AgentBase; to: Point; bed?: boolean }[],
  limit = 3000,
): { ticks: number; phases: Set<string> } {
  const phases = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const done = trips.map(({ a, to, bed }) => headTo(state, a, to, to, bed ?? false));
    if (done.every((d) => d === "arrived")) return { ticks: i, phases };
    if (done.some((d) => d === "no_route")) throw new Error("no route");
    state.tick++;
    moveAgents(state);
    updatePortals(state);
    for (const { a } of trips) if (a.transit) phases.add(`${a.transit.kind}:${a.transit.phase}`);
  }
  throw new Error("timed out");
}

describe("stairs", () => {
  it("take staff up a floor, as long a walk as a corridor's length", () => {
    const state = block({ lift: false });
    const a = person(state, 12, 8, 0, true);
    const { ticks, phases } = go(state, [{ a, to: { x: 12, y: 8, floor: 1 } }]);
    expect(a.floor).toBe(1);
    expect(phases).toEqual(new Set(["stairs:walking", "stairs:climbing"]));
    expect(ticks).toBeGreaterThan(Math.ceil(STAIRS_TILES_PER_FLOOR / 0.7));
  });

  it("join the floors for working out whether there's a way", () => {
    const state = block({ lift: false });
    expect(walkRouteExists(state, { x: 12, y: 8, floor: 0 }, { x: 12, y: 8, floor: 1 })).toBe(true);
    // But not for a bed.
    expect(bedRouteExists(state, { x: 12, y: 8, floor: 0 }, { x: 12, y: 8, floor: 1 })).toBe(false);
  });

  it("aren't for beds", () => {
    const state = block({ lift: false });
    const a = person(state, 12, 8, 0);
    expect(headTo(state, a, { x: 12, y: 8, floor: 1 }, { x: 12, y: 8, floor: 1 }, true)).toBe(
      "no_route",
    );
  });
});

describe("a bed lift", () => {
  it("takes a bed up, and joins the floors for beds", () => {
    const state = block({ stairs: false });
    expect(bedRouteExists(state, { x: 12, y: 8, floor: 0 }, { x: 12, y: 8, floor: 1 })).toBe(true);
    const a = person(state, 12, 8, 0);
    const { phases } = go(state, [{ a, to: { x: 12, y: 8, floor: 1 }, bed: true }]);
    expect(a.floor).toBe(1);
    expect(phases.has("lift:riding")).toBe(true);
    expect(Object.values(state.lifts)[0]).toMatchObject({ floor: 1 });
  });

  it("is what visitors take, while staff take the stairs", () => {
    const state = block();
    const visitor = person(state, 8, 8, 0);
    const porter = person(state, 8, 8, 0, true);
    const phases = { visitor: new Set<string>(), porter: new Set<string>() };
    const to = { x: 12, y: 8, floor: 1 };
    for (let i = 0; i < 3000 && (visitor.floor === 0 || porter.floor === 0); i++) {
      headTo(state, visitor, to);
      headTo(state, porter, to);
      state.tick++;
      moveAgents(state);
      updatePortals(state);
      if (visitor.transit) phases.visitor.add(visitor.transit.kind);
      if (porter.transit) phases.porter.add(porter.transit.kind);
    }
    expect(phases.visitor).toEqual(new Set(["lift"]));
    expect(phases.porter).toEqual(new Set(["stairs"]));
  });

  it("carries a bed and two more, and the rest wait for the next trip", () => {
    const state = block({ stairs: false });
    const to = { x: 12, y: 8, floor: 1 };
    const bed = person(state, 7, 5, 0);
    const walkers = [0, 1, 2, 3].map((i) => person(state, 9 + i, 5, 0));
    const trips: { a: AgentBase; to: Point; bed?: boolean }[] = [
      { a: bed, to, bed: true },
      ...walkers.map((a) => ({ a, to })),
    ];
    let most = 0;
    for (let i = 0; i < 3000 && trips.some((t) => t.a.floor === 0); i++) {
      for (const t of trips) headTo(state, t.a, t.to, t.to, t.bed ?? false);
      state.tick++;
      moveAgents(state);
      updatePortals(state);
      const car = Object.values(state.lifts)[0];
      const load = (car?.riders ?? []).reduce(
        (n, id) => n + (state.visitors[id]?.transit?.load ?? 0),
        0,
      );
      most = Math.max(most, load);
    }
    expect(trips.every((t) => t.a.floor === 1)).toBe(true);
    expect(most).toBeLessThanOrEqual(LIFT.capacity);
    expect(most).toBeGreaterThanOrEqual(LIFT.bedLoad);
  });

  it("out of service, sends those waiting to the stairs instead", () => {
    const state = block();
    const lift = Object.values(state.objects).find((o) => o.defId === "lift" && o.floor === 0)!;
    state.maintenance[lift.id] = { wear: 100, broken: state.tick };
    const a = person(state, 8, 8, 0);
    const { phases } = go(state, [{ a, to: { x: 12, y: 8, floor: 1 } }]);
    expect(a.floor).toBe(1);
    expect([...phases].some((p) => p.startsWith("lift"))).toBe(false);
  });

  it("is saved with whoever's in it", () => {
    const state = block({ stairs: false });
    const a = person(state, 12, 8, 0);
    const to = { x: 12, y: 8, floor: 1 };
    for (let i = 0; i < 3000 && a.transit?.phase !== "riding"; i++) {
      headTo(state, a, to);
      state.tick++;
      moveAgents(state);
      updatePortals(state);
    }
    expect(a.transit?.phase).toBe("riding");
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "test")))).state;
    expect(loaded.visitors[a.id]!.transit).toEqual(a.transit);
    expect(loaded.lifts).toEqual(state.lifts);
  });
});

describe("a ward upstairs", () => {
  /**
   * The majors fixture with its ward block lifted to the first floor: on the
   * ground, the shell is a corridor off Majors with a bed lift; upstairs,
   * the same lift opens onto the ward.
   */
  function wardUpstairs(): SimState {
    const state = staffedMajorsAE(1, { ...MAJORS_TEAM, porter: 1 });
    hireRegistrars(state);
    state.settings.patientVolume = 0;
    // The lift, opening east, in the north-west corner of the block on both floors.
    const shell = (floor: number): Command[] => [
      { type: "build_floor", floor, rect: rect(1, 18, 8, 11) },
      { type: "build_walls", floor, rect: rect(1, 18, 8, 11), wall: WallType.Standard },
      { type: "place_object", floor, defId: "lift", x: 2, y: 19, rotation: 3 },
    ];
    const bed = (x: number): Command => ({
      type: "place_object",
      floor: 1,
      defId: "hospital_bed",
      x,
      y: 24,
      rotation: 0,
    });
    applyAll(state, [
      ...shell(0),
      { type: "place_object", floor: 0, defId: "door_double", x: 8, y: 22, rotation: 1 },
      { type: "zone", floor: 0, rect: rect(2, 19, 6, 9), roomType: "corridor" },
      ...shell(1),
      // Upstairs: a lift lobby, then a wall with double doors into the ward.
      { type: "build_walls", floor: 1, rect: rect(1, 22, 8, 1), wall: WallType.Standard },
      { type: "place_object", floor: 1, defId: "door_double", x: 5, y: 22, rotation: 0 },
      { type: "zone", floor: 1, rect: rect(2, 19, 6, 3), roomType: "corridor" },
      { type: "zone", floor: 1, rect: rect(2, 23, 6, 5), roomType: "ward" },
      bed(2),
      bed(4),
      bed(7),
      { type: "place_object", floor: 1, defId: "sink", x: 5, y: 27, rotation: 2 },
    ]);
    return state;
  }

  it("is valid, and a porter takes an admitted patient up to it by lift", () => {
    const state = wardUpstairs();
    const ward = state.rooms.find((r) => r.typeId === "ward")!;
    expect(ward.floor).toBe(1);
    expect(ward.checks.filter((c) => !c.ok && !c.advisory)).toEqual([]);
    for (let i = 0; i < 20 * 10; i++) tick(state); // Staff walk in.

    const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
    p.deterioration = null;
    for (let i = 0; i < 6 * 600 && !(p.stage === "in_cubicle" && p.path.length === 0); i++) {
      tick(state);
    }
    expect(p.stage).toBe("in_cubicle");
    for (const j of Object.values(state.jobs)) if (j.patientId === p.id) removeJob(state, j);
    decideToAdmit(state, p);
    let rode = false;
    for (let i = 0; i < 6 * 600 && p.stage !== "on_ward"; i++) {
      tick(state);
      if (p.transit?.phase === "riding") rode = true;
    }
    expect(p.stage).toBe("on_ward");
    expect(p.floor).toBe(1);
    expect(rode).toBe(true);
    expect(state.objects[p.bed!]!.floor).toBe(1);
  });
});
