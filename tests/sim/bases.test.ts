/**
 * Idle staff wait at their role's base (systems/bases.ts), falling back to
 * the Staff Room, rather than standing where their last job ended.
 */
import { describe, expect, it } from "vitest";
import type { StaffRoleId } from "@data/schema";
import type { Staff } from "@sim/agents";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_MINUTE } from "@sim/time";
import { tileIndex, WallType } from "@sim/world/grid";
import { applyAll } from "../fixtures/smallAE";

const F = 0;
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const place = (defId: string, x: number, y: number) =>
  ({ type: "place_object", floor: F, defId, x, y, rotation: 0 }) as const;

/**
 * Four bases along the top of an open floor, with no reception, so no
 * patients come: a Porters' Lodge, a Domestic Services Room, an open A&E
 * Staff Base and a Staff Room. Staff arrive at the bottom of the map.
 */
function bases(opts: { staffRoom?: boolean } = {}): SimState {
  const state = createSimState({ seed: 1, width: 24, height: 12, money: 2_000_000 });
  applyAll(state, [
    { type: "build_floor", floor: F, rect: rect(0, 0, 24, 12) },
    // Porters' Lodge: inside (1,1)–(4,4), desk with its staff side at the top.
    { type: "build_walls", floor: F, rect: rect(0, 0, 6, 6), wall: WallType.Standard },
    place("door_single", 2, 5),
    { type: "zone", floor: F, rect: rect(1, 1, 4, 4), roomType: "porters_lodge" },
    place("desk", 1, 2),
    // Domestic Services Room: inside (7,1)–(8,4).
    { type: "build_walls", floor: F, rect: rect(6, 0, 4, 6), wall: WallType.Standard },
    place("door_single", 7, 5),
    { type: "zone", floor: F, rect: rect(7, 1, 2, 4), roomType: "domestic_services_room" },
    place("sink", 8, 1),
    // A&E Staff Base: open plan, (11,1)–(14,4).
    { type: "zone", floor: F, rect: rect(11, 1, 4, 4), roomType: "staff_base" },
    place("desk", 12, 2),
  ]);
  if (opts.staffRoom !== false) {
    applyAll(state, [
      { type: "build_walls", floor: F, rect: rect(16, 0, 6, 6), wall: WallType.Standard },
      place("door_single", 18, 5),
      { type: "zone", floor: F, rect: rect(17, 1, 4, 4), roomType: "staff_room" },
      place("kitchenette", 17, 1),
      ...[1, 2, 3, 4].map((y) => ({ ...place("waiting_chair", 20, y), rotation: 1 as const })),
    ]);
  }
  expect(state.rooms.every((r) => r.valid)).toBe(true);
  return state;
}

function hire(state: SimState, role: StaffRoleId, n = 1): Staff[] {
  const out: Staff[] = [];
  for (let i = 0; i < n; i++) {
    const specialist = role === "registrar" || role === "consultant";
    const r = applyStaffCommand(state, {
      type: "hire_staff",
      role,
      ...(specialist ? { specialty: "general_medicine" as const } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    out.push(r.staff);
  }
  return out;
}

function settle(state: SimState): void {
  for (let i = 0; i < 60 * TICKS_PER_MINUTE; i++) tick(state);
}

function roomAt(state: SimState, s: Staff): string | undefined {
  const grid = state.floors[0]!;
  const id = grid.roomId[tileIndex(grid, Math.round(s.x), Math.round(s.y))]!;
  return state.rooms[id - 1]?.typeId;
}

describe("idle staff", () => {
  it("wait at their role's base", () => {
    const state = bases();
    const [porter] = hire(state, "porter");
    const [cleaner] = hire(state, "cleaner");
    const [doctor] = hire(state, "junior_doctor");
    const [enp] = hire(state, "nurse_practitioner");
    settle(state);
    expect(roomAt(state, porter!)).toBe("porters_lodge");
    expect(roomAt(state, cleaner!)).toBe("domestic_services_room");
    expect(roomAt(state, doctor!)).toBe("staff_base");
    expect(roomAt(state, enp!)).toBe("staff_base");
    // One of them sits at the desk.
    const atDesk = [doctor!, enp!].filter((s) => s.x === 12 && s.y === 1);
    expect(atDesk).toHaveLength(1);
  });

  it("use the Staff Base for nurses with no nurse station, and specialty doctors with no ward", () => {
    const state = bases();
    const [nurse] = hire(state, "nurse");
    const [registrar] = hire(state, "registrar");
    settle(state);
    expect(roomAt(state, nurse!)).toBe("staff_base");
    expect(roomAt(state, registrar!)).toBe("staff_base");
  });

  it("with no base of their own, wait in the Staff Room", () => {
    const state = bases();
    const [radiographer] = hire(state, "radiographer");
    const [scientist] = hire(state, "biomedical_scientist");
    settle(state);
    expect(roomAt(state, radiographer!)).toBe("staff_room");
    expect(roomAt(state, scientist!)).toBe("staff_room");
  });

  it("sit on the Staff Room chairs, and stand once they're all taken", () => {
    const state = bases();
    const staff = hire(state, "radiographer", 5);
    settle(state);
    // The chairs are along the room's east wall, at x = 20.
    const seated = staff.filter((s) => s.x === 20);
    expect(seated.map((s) => s.y).sort()).toEqual([1, 2, 3, 4]);
    const standing = staff.filter((s) => s.x !== 20);
    expect(standing).toHaveLength(1);
    expect(roomAt(state, standing[0]!)).toBe("staff_room");
  });

  it("with nowhere at all, stay where they are", () => {
    const state = bases({ staffRoom: false });
    const [radiographer] = hire(state, "radiographer");
    const start = { x: radiographer!.x, y: radiographer!.y };
    settle(state);
    expect({ x: radiographer!.x, y: radiographer!.y }).toEqual(start);
  });

  it("each stand on a tile of their own, and overflow to the Staff Room when the base is full", () => {
    const state = bases();
    // The lodge has 4×4 tiles, less the desk's two: 14 spots.
    const porters = hire(state, "porter", 16);
    settle(state);
    const grid = state.floors[0]!;
    const spots = porters.map((p) => tileIndex(grid, p.x, p.y));
    expect(new Set(spots).size).toBe(porters.length);
    const rooms = porters.map((p) => roomAt(state, p));
    expect(rooms.filter((r) => r === "porters_lodge")).toHaveLength(14);
    expect(rooms.filter((r) => r === "staff_room")).toHaveLength(2);
  });

  it("move to a better base once it's built", () => {
    const state = bases();
    const [scientist] = hire(state, "biomedical_scientist");
    settle(state);
    expect(roomAt(state, scientist!)).toBe("staff_room");
    applyAll(state, [
      { type: "build_walls", floor: F, rect: rect(10, 6, 5, 5), wall: WallType.Standard },
      place("door_single", 12, 10),
      { type: "zone", floor: F, rect: rect(11, 7, 3, 3), roomType: "lab" },
      place("blood_analyser", 11, 7),
    ]);
    expect(state.rooms.find((r) => r.typeId === "lab")?.valid).toBe(true);
    settle(state);
    expect(roomAt(state, scientist!)).toBe("lab");
  });
});
