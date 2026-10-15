/**
 * (Building blocks for scenario hospitals and tests: tests/fixtures re-exports this.)
 *
 * A small surgical block on its own, built through commands: a Day Surgery
 * Unit and an eight-bed ward west of a 2-wide corridor, and two operating
 * theatres and Recovery east of it, all through double doors (bed-width).
 * Theatre A is Trauma & Orthopaedics'; B is open to any specialty.
 *
 * Tiles from (1,1) to (23,23). The corridor is x 13–14; the entrance is a
 * double door at the bottom of it.
 *
 *   x=1         12 15      23
 *   DSU   y 2–7   |  | Theatre A y 2–8 (table 19,4)
 *   Ward  y 9–22  |  | Theatre B y 10–16 (table 19,12)
 *                 |  | Recovery  y 18–22 (trolleys 18,18 and 21,18)
 */
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { Command } from "@sim/commands";
import { createSimState, type Rotation, type SimState } from "@sim/state";
import { applyStaffCommand } from "@sim/systems/staffing";
import { WallType } from "@sim/world/grid";
import { roomAt, setRoomSpecialty } from "@sim/world/rooms";
import { applyAll, FIXTURE_MONEY } from "./smallAE";

const F = 0;
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  x: x0,
  y: y0,
  w: x1 - x0 + 1,
  h: y1 - y0 + 1,
});

function place(defId: string, x: number, y: number, rotation: Rotation = 0): Command[] {
  return [{ type: "place_object", floor: F, defId, x, y, rotation }];
}

/** A theatre with its top row at `y`: x 16–22, 7 rows, double door in the corridor wall. */
function theatre(y: number): Command[] {
  return [
    { type: "zone", floor: F, rect: rect(16, y, 22, y + 6), roomType: "theatre" },
    { type: "place_object", floor: F, defId: "door_double", x: 15, y: y + 3, rotation: 1 },
    ...place("anaesthetic_machine", 19, y),
    ...place("operating_table", 19, y + 2),
    ...place("operating_light", 19, y + 2),
    ...place("sink", 16, y + 6, 2),
  ];
}

/** A recovery trolley with its monitor and oxygen on the wall above. */
function recoveryBay(x: number): Command[] {
  return [
    ...place("trolley", x, 18),
    ...place("bedside_monitor", x - 1, 18),
    ...place("oxygen_point", x + 1, 18),
  ];
}

export const THEATRES_COMMANDS: Command[] = [
  { type: "build_floor", floor: F, rect: rect(1, 1, 23, 23) },
  { type: "build_walls", floor: F, rect: rect(1, 1, 23, 23), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(12, 1, 12, 23), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(15, 1, 15, 23), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(1, 8, 12, 8), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(15, 9, 23, 9), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(15, 17, 23, 17), wall: WallType.Standard },
  { type: "place_object", floor: F, defId: "door_double", x: 13, y: 23, rotation: 0 },
  { type: "zone", floor: F, rect: rect(13, 2, 14, 22), roomType: "corridor" },
  // Day Surgery Unit: a nurses' desk and six seats.
  { type: "zone", floor: F, rect: rect(2, 2, 11, 7), roomType: "day_surgery_unit" },
  { type: "place_object", floor: F, defId: "door_double", x: 12, y: 4, rotation: 1 },
  ...place("desk", 3, 3),
  ...place("waiting_bench", 3, 6),
  ...place("waiting_bench", 7, 6),
  // Ward: eight beds.
  { type: "zone", floor: F, rect: rect(2, 9, 11, 22), roomType: "ward" },
  { type: "place_object", floor: F, defId: "door_double", x: 12, y: 15, rotation: 1 },
  ...[3, 5, 7, 9].flatMap((x) => [
    ...place("hospital_bed", x, 10),
    ...place("hospital_bed", x, 17),
  ]),
  ...place("sink", 2, 22, 2),
  ...theatre(2),
  ...theatre(10),
  // Recovery: two trolleys.
  { type: "zone", floor: F, rect: rect(16, 18, 22, 22), roomType: "recovery" },
  { type: "place_object", floor: F, defId: "door_double", x: 15, y: 19, rotation: 1 },
  ...recoveryBay(18),
  ...recoveryBay(21),
];

export const THEATRE_A = { x: 17, y: 5 };
export const THEATRE_B = { x: 17, y: 13 };

export const THEATRE_TEAM: Partial<Record<StaffRoleId, number>> = {
  theatre_practitioner: 2,
  nurse: 2,
  porter: 1,
  cleaner: 1,
  junior_doctor: 1,
};

/**
 * The block with a theatre team and, for each surgeon given, a resident
 * consultant with `lists` theatre lists a week, and an anaesthetist with
 * enough lists to cover them.
 */
export function buildTheatres(
  seed = 1,
  surgeons: { specialty: SpecialtyId; lists: number }[] = [
    { specialty: "trauma_orthopaedics", lists: 2 },
  ],
  team = THEATRE_TEAM,
): SimState {
  const state = createSimState({ seed, width: 26, height: 26, money: FIXTURE_MONEY });
  applyAll(state, THEATRES_COMMANDS);
  setRoomSpecialty(state, roomAt(state, F, THEATRE_A.x, THEATRE_A.y)!, "trauma_orthopaedics");
  for (const [role, n] of Object.entries(team) as [StaffRoleId, number][]) {
    for (let i = 0; i < n; i++) applyStaffCommand(state, { type: "hire_staff", role });
  }
  const consultant = (specialty: SpecialtyId) => {
    const r = applyStaffCommand(state, { type: "hire_staff", role: "consultant", specialty });
    if (!r.ok) throw new Error(r.error);
    return r.staff;
  };
  let lists = 0;
  for (const s of surgeons) {
    const id = consultant(s.specialty).id;
    applyStaffCommand(state, { type: "set_theatre_sessions", id, sessions: s.lists });
    lists += s.lists;
  }
  if (lists > 0) {
    const id = consultant("anaesthetics").id;
    applyStaffCommand(state, { type: "set_theatre_sessions", id, sessions: Math.min(4, lists) });
  }
  return state;
}
