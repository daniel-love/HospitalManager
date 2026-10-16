/**
 * Ruling out patients' routes up front (world/accessRegions.ts): the
 * pre-check must agree with findPath, and never say no when it finds a way.
 */
import { describe, expect, it } from "vitest";
import type { AgentBase } from "@sim/agents";
import { applyCommand, type Command } from "@sim/commands";
import { createRng, nextInt, pick, type RngState } from "@sim/rng";
import { createSimState, type SimState } from "@sim/state";
import { headTo } from "@sim/systems/movement";
import { crewAccess, patientAccess } from "@sim/world/access";
import { accessRouteExists } from "@sim/world/accessRegions";
import { WallType } from "@sim/world/grid";
import { findPath, isWalkable } from "@sim/world/pathfinding";
import { walkRouteExists } from "@sim/world/walkRegions";
import { applyAll } from "../fixtures/smallAE";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/**
 * A corridor (x 2–5) that reaches a waiting area (x 14–17) only through a
 * ward (x 7–12), with a staff room off the ward (y 2–4, behind a wall at
 * y 5) and a door from the staff room straight outside at (9, 1).
 */
function throughAWard(floor = 0): SimState {
  const state = createSimState({ seed: 1, width: 20, height: 14, money: 10_000_000 });
  const commands: Command[] = [
    // Under an upper floor, the ground floor is open plan out to its walls.
    { type: "build_floor", floor: 0, rect: floor > 0 ? rect(1, 1, 18, 12) : rect(2, 2, 16, 10) },
    ...(floor > 0 ? [{ type: "build_floor" as const, floor, rect: rect(2, 2, 16, 10) }] : []),
    { type: "build_walls", floor, rect: rect(1, 1, 18, 12), wall: WallType.Standard },
    { type: "build_walls", floor, rect: rect(6, 1, 1, 12), wall: WallType.Standard },
    { type: "build_walls", floor, rect: rect(13, 1, 1, 12), wall: WallType.Standard },
    { type: "build_walls", floor, rect: rect(7, 5, 6, 1), wall: WallType.Standard },
    { type: "zone", floor, rect: rect(2, 2, 4, 10), roomType: "corridor" },
    { type: "zone", floor, rect: rect(7, 6, 6, 6), roomType: "ward" },
    { type: "zone", floor, rect: rect(7, 2, 6, 3), roomType: "staff_room" },
    { type: "zone", floor, rect: rect(14, 2, 4, 10), roomType: "waiting_area" },
    { type: "place_object", floor, defId: "door_single", x: 6, y: 8, rotation: 1 },
    { type: "place_object", floor, defId: "door_single", x: 13, y: 8, rotation: 1 },
    { type: "place_object", floor, defId: "door_single", x: 9, y: 5, rotation: 0 },
    { type: "place_object", floor, defId: "door_single", x: 9, y: 1, rotation: 0 },
  ];
  applyAll(state, commands);
  return state;
}

/** A random walled layout: rooms of each kind, doors (some straight outside), furniture. */
function randomLayout(rng: RngState): SimState {
  const W = 24;
  const H = 16;
  const state = createSimState({ seed: 1, width: W, height: H, money: 10_000_000 });
  const tryAll = (cmds: Command[]) => cmds.forEach((c) => applyCommand(state, c));
  tryAll([
    { type: "build_floor", floor: 0, rect: rect(2, 2, W - 4, H - 4) },
    { type: "build_walls", floor: 0, rect: rect(1, 1, W - 2, H - 2), wall: WallType.Standard },
  ]);
  const cmds: Command[] = [];
  for (let k = nextInt(rng, 2, 5); k > 0; k--) {
    const x = nextInt(rng, 3, W - 4);
    const y = nextInt(rng, 3, H - 4);
    cmds.push(
      nextInt(rng, 0, 1) === 0
        ? { type: "build_walls", floor: 0, rect: rect(x, 1, 1, H - 2), wall: WallType.Standard }
        : { type: "build_walls", floor: 0, rect: rect(1, y, W - 2, 1), wall: WallType.Standard },
    );
  }
  const kinds = ["corridor", "waiting_area", "ward", "staff_room", "resus_bay"];
  for (let k = nextInt(rng, 3, 7); k > 0; k--) {
    const x = nextInt(rng, 2, W - 6);
    const y = nextInt(rng, 2, H - 5);
    const r = rect(x, y, nextInt(rng, 2, W - 2 - x), nextInt(rng, 2, H - 2 - y));
    cmds.push({ type: "zone", floor: 0, rect: r, roomType: pick(rng, kinds) });
  }
  for (let k = nextInt(rng, 8, 16); k > 0; k--) {
    cmds.push({
      type: "place_object",
      floor: 0,
      defId: pick(rng, ["door_single", "door_double"]),
      x: nextInt(rng, 1, W - 2),
      y: nextInt(rng, 1, H - 2),
      rotation: pick(rng, [0, 1] as const),
    });
  }
  for (let k = nextInt(rng, 0, 6); k > 0; k--) {
    cmds.push({
      type: "place_object",
      floor: 0,
      defId: pick(rng, ["trolley", "waiting_chair", "desk"]),
      x: nextInt(rng, 2, W - 3),
      y: nextInt(rng, 2, H - 3),
      rotation: pick(rng, [0, 1, 2, 3] as const),
    });
  }
  tryAll(cmds);
  return state;
}

interface Tally {
  /** Pairs the walk regions join but the access rules don't. */
  ruledOut: number;
  routes: number;
}

/**
 * Compares the pre-check with findPath from every tile on a floor to a
 * sample of walkable goals: equal on foot, and never no when there's a
 * route by bed.
 */
function compare(state: SimState, floor: number, rng: RngState, goals: number): Tally {
  const grid = state.floors[floor]!;
  const walkable: number[] = [];
  for (let i = 0; i < grid.width * grid.height; i++) if (isWalkable(grid, i)) walkable.push(i);
  const tally = { ruledOut: 0, routes: 0 };
  for (const rules of ["patient", "crew"] as const) {
    const access = rules === "crew" ? crewAccess(state, floor) : patientAccess(state, floor);
    for (let s = 0; s < grid.width * grid.height; s++) {
      const from = { x: s % grid.width, y: Math.floor(s / grid.width) };
      for (let k = 0; k < goals; k++) {
        const g = pick(rng, walkable);
        const to = { x: g % grid.width, y: Math.floor(g / grid.width) };
        for (const bed of [false, true]) {
          const found =
            findPath(grid, from.x, from.y, to.x, to.y, { bed, patient: access }) !== null;
          const said = accessRouteExists(state, floor, from, to, rules, bed);
          const where = `${rules}${bed ? " bed" : ""} (${from.x},${from.y})→(${to.x},${to.y})`;
          if (found) expect(said, where).toBe(true);
          if (!bed) expect(said, where).toBe(found);
          if (!bed && found) tally.routes++;
          if (
            !bed &&
            !said &&
            walkRouteExists(state, { ...from, floor }, { ...to, floor }) &&
            findPath(grid, from.x, from.y, to.x, to.y) !== null
          ) {
            tally.ruledOut++;
          }
        }
      }
    }
  }
  return tally;
}

function patientAt(x: number, y: number, floor = 0): AgentBase {
  return {
    id: 1,
    x,
    y,
    prevX: x,
    prevY: y,
    floor,
    path: [],
    dest: null,
    pathVersion: -1,
    transit: null,
  } as unknown as AgentBase;
}

describe("access regions", () => {
  const state = throughAWard();
  const at = (x: number, y: number) => ({ x, y });
  const can = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    accessRouteExists(state, 0, a, b);

  it("lets a patient cross a room only if they start or end in it", () => {
    // Corridor to waiting area: only through the ward.
    expect(walkRouteExists(state, at(3, 8), at(15, 8))).toBe(true);
    expect(can(at(3, 8), at(15, 8))).toBe(false);
    // From or to the ward itself, either way.
    expect(can(at(3, 8), at(9, 8))).toBe(true);
    expect(can(at(9, 8), at(15, 8))).toBe(true);
    expect(can(at(15, 8), at(10, 10))).toBe(true);
  });

  it("joins private rooms at both ends", () => {
    // Staff room to ward: both private, next to each other.
    expect(can(at(9, 3), at(9, 9))).toBe(true);
    // Staff room to the corridor: through the ward, which isn't theirs.
    expect(can(at(9, 3), at(3, 8))).toBe(false);
    // Staff room to waiting area, the same.
    expect(can(at(15, 8), at(9, 3))).toBe(false);
  });

  it("never takes a patient out by a back door", () => {
    // (9, 0) is outside, beyond the staff room's door straight out.
    expect(can(at(9, 3), at(9, 0))).toBe(false);
    expect(findPath(state.floors[0]!, 9, 3, 9, 0, { patient: patientAccess(state) })).toBeNull();
    // The ambulance crew may use it.
    expect(accessRouteExists(state, 0, at(9, 0), at(9, 3), "crew")).toBe(true);
  });

  it("agrees with findPath on this layout", () => {
    const t = compare(state, 0, createRng(1), 40);
    expect(t.ruledOut).toBeGreaterThan(0);
  });

  it("works on an upper floor", () => {
    const upper = throughAWard(1);
    expect(upper.floors).toHaveLength(2);
    expect(accessRouteExists(upper, 1, at(3, 8), at(15, 8))).toBe(false);
    expect(accessRouteExists(upper, 1, at(3, 8), at(9, 8))).toBe(true);
    // The ground floor, open plan, joins them.
    expect(accessRouteExists(upper, 0, at(3, 8), at(15, 8))).toBe(true);
    const t = compare(upper, 1, createRng(2), 30);
    expect(t.ruledOut).toBeGreaterThan(0);
  });

  it("agrees with findPath on random layouts", () => {
    const rng = createRng(7);
    let ruledOut = 0;
    let routes = 0;
    for (let n = 0; n < 20; n++) {
      const t = compare(randomLayout(rng), 0, rng, 3);
      ruledOut += t.ruledOut;
      routes += t.routes;
    }
    // The layouts do exercise it.
    expect(routes).toBeGreaterThan(1000);
    expect(ruledOut).toBeGreaterThan(100);
  });

  it("stops a patient with no public way without searching", () => {
    const p = patientAt(3, 8);
    expect(headTo(state, p, at(15, 8))).toBe("no_route");
    const q = patientAt(3, 8);
    expect(headTo(state, q, at(9, 8))).toBe("moving");
  });

  it("lets the ambulance crew through clinical rooms if there's no other way", () => {
    const p = patientAt(3, 8);
    expect(headTo(state, p, at(15, 8), at(15, 8), false, true)).toBe("moving");
    expect(p.path.length).toBeGreaterThan(0);
  });
});
