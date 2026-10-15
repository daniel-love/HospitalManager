/**
 * Planned care without an A&E, for private hospitals: the outpatients
 * department (north) and the surgical block (south-west) from their own
 * fixtures, and a block of three side rooms (south-east) for inpatients who
 * need a room of their own. Each is its own building on grass.
 *
 * The side-room block, tiles (1,1)–(13,11) in its own coordinates:
 *
 *   #############   y=1
 *   #A  #B  #C  #   rooms y 2–5: bed against the top wall, sink by the door
 *   ##DD##DD##DD#   y=6, double doors
 *   # corridor  #   y 7–10, 2+ wide for beds
 *   #####DD######   y=11, entrance
 */
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { Command } from "@sim/commands";
import { createSimState, type Funding, type SimState } from "@sim/state";
import { applyStaffCommand } from "@sim/systems/staffing";
import { WallType } from "@sim/world/grid";
import { roomAt, setPrivateRoom, setRoomSpecialty } from "@sim/world/rooms";
import { shift } from "./hospital";
import { CLINIC_A, OUTPATIENTS_COMMANDS } from "./outpatients";
import { applyAll, FIXTURE_MONEY } from "./smallAE";
import { THEATRE_A, THEATRES_COMMANDS } from "./theatres";

const F = 0;
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  x: x0,
  y: y0,
  w: x1 - x0 + 1,
  h: y1 - y0 + 1,
});
const place = (defId: string, x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0): Command => ({
  type: "place_object",
  floor: F,
  defId,
  x,
  y,
  rotation,
});

/** Three side rooms off a bed-width corridor. */
export const SIDE_ROOMS_COMMANDS: Command[] = [
  { type: "build_floor", floor: F, rect: rect(1, 1, 13, 11) },
  { type: "build_walls", floor: F, rect: rect(1, 1, 13, 11), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(1, 6, 13, 6), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(5, 1, 5, 6), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(9, 1, 9, 6), wall: WallType.Standard },
  { type: "zone", floor: F, rect: rect(2, 7, 12, 10), roomType: "corridor" },
  place("door_double", 6, 11),
  ...[2, 6, 10].flatMap((x) => [
    { type: "zone", floor: F, rect: rect(x, 2, x + 2, 5), roomType: "side_room" } as Command,
    place("door_double", x, 6),
    place("hospital_bed", x + 2, 2),
    place("sink", x, 2),
  ]),
];

const OUTPATIENTS_AT = { x: 0, y: 0 };
const SURGICAL_AT = { x: 0, y: 16 };
export const SIDE_ROOMS_AT = { x: 26, y: 26 };

/** Clinics, theatres and side rooms, under a funding model. */
export function buildPlannedCare(seed = 1, funding: Funding = "private"): SimState {
  const state = createSimState({ seed, width: 42, height: 42, money: FIXTURE_MONEY, funding });
  applyAll(state, [
    ...shift(OUTPATIENTS_COMMANDS, OUTPATIENTS_AT),
    ...shift(THEATRES_COMMANDS, SURGICAL_AT),
    ...shift(SIDE_ROOMS_COMMANDS, SIDE_ROOMS_AT),
  ]);
  setRoomSpecialty(state, roomAt(state, F, CLINIC_A.x, CLINIC_A.y)!, "cardiology");
  setRoomSpecialty(
    state,
    roomAt(state, F, THEATRE_A.x + SURGICAL_AT.x, THEATRE_A.y + SURGICAL_AT.y)!,
    "trauma_orthopaedics",
  );
  return state;
}

/** The side rooms, for checks. */
export function sideRooms(state: SimState, at = SIDE_ROOMS_AT) {
  return [3, 7, 11].map((x) => roomAt(state, F, x + at.x, 4 + at.y)!);
}

/** Puts the side rooms in a Hybrid trust's Private Patient Unit. */
export function privateSideRooms(state: SimState, at = SIDE_ROOMS_AT): void {
  for (const r of sideRooms(state, at)) setPrivateRoom(state, r, true);
}

export type Team = Partial<Record<StaffRoleId, number>>;

/** A private hospital's consultants with practising privileges: clinics and lists. */
export function grantPrivileges(
  state: SimState,
  consultants: { specialty: SpecialtyId; clinics: number; lists: number }[],
): void {
  for (const c of consultants) {
    const r = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: c.specialty,
      privileges: true,
    });
    if (!r.ok) throw new Error(r.error);
    const id = r.staff.id;
    applyStaffCommand(state, { type: "set_clinic_sessions", id, sessions: c.clinics });
    if (c.lists) applyStaffCommand(state, { type: "set_theatre_sessions", id, sessions: c.lists });
  }
}
