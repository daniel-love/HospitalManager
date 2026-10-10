/**
 * A small outpatients department on its own, built through commands like a
 * player would: Outpatients Reception opening onto a Waiting Area, a 2-wide
 * corridor, and two clinic rooms (the north one given to Cardiology, the
 * south one open to any specialty).
 *
 * Tiles from (1,1) to (15,13). r reception, w waiting, c corridor,
 * A/B clinic rooms; R reception desk, B benches, D desk, E couch, S sink.
 *
 *   x=1         11   15
 *   ###############       y=1
 *   #rrrRRRrcc#AAA#       clinic A: desk (13,3), couch (13,5) across, sink (12,5)
 *   #rrrrrrrcc#ADD#
 *   #rrrrrrrccdAAA#       door (11,4)
 *   #wwwwwwwcc#SEE#
 *   #wBBBwwwcc#####       y=6
 *   ...
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

/** Clinic room interior x 12–14, from row `y` (4 rows), door in the corridor wall. */
function clinic(y: number): Command[] {
  return [
    { type: "zone", floor: F, rect: rect(12, y, 14, y + 3), roomType: "outpatient_clinic" },
    { type: "place_object", floor: F, defId: "door_single", x: 11, y: y + 2, rotation: 1 },
    // The clinician sits behind the desk (north), the patient in front; the
    // gap at its west end is the way round to the clinician's side.
    ...place("desk", 13, y + 1),
    ...place("exam_couch", 13, y + 3, 1),
    ...place("sink", 12, y + 3, 2),
  ];
}

export const OUTPATIENTS_COMMANDS: Command[] = [
  { type: "build_floor", floor: F, rect: rect(1, 1, 15, 13) },
  { type: "build_walls", floor: F, rect: rect(1, 1, 15, 13), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(11, 1, 11, 11), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(11, 6, 15, 6), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(11, 11, 15, 11), wall: WallType.Standard },
  { type: "place_object", floor: F, defId: "door_double", x: 5, y: 13, rotation: 0 },
  { type: "zone", floor: F, rect: rect(2, 2, 8, 4), roomType: "outpatients_reception" },
  { type: "zone", floor: F, rect: rect(2, 5, 8, 12), roomType: "waiting_area" },
  { type: "zone", floor: F, rect: rect(9, 2, 10, 12), roomType: "corridor" },
  ...place("reception_desk", 4, 3),
  ...place("waiting_bench", 3, 7),
  ...place("waiting_bench", 3, 10),
  ...clinic(2),
  ...clinic(7),
];

export const CLINIC_A = { x: 13, y: 4 };
export const CLINIC_B = { x: 13, y: 9 };

export type ClinicTeam = Partial<Record<StaffRoleId, number>>;

/**
 * The department with a receptionist and, for each specialty given, a
 * resident consultant with `sessions` clinics a week. Clinic A is
 * Cardiology's; B is open to any specialty.
 */
export function buildOutpatients(
  seed = 1,
  clinicians: { specialty: SpecialtyId; sessions: number }[] = [
    { specialty: "cardiology", sessions: 4 },
  ],
): SimState {
  const state = createSimState({ seed, width: 20, height: 16, money: FIXTURE_MONEY });
  applyAll(state, OUTPATIENTS_COMMANDS);
  setRoomSpecialty(state, roomAt(state, F, CLINIC_A.x, CLINIC_A.y)!, "cardiology");
  applyStaffCommand(state, { type: "hire_staff", role: "receptionist" });
  for (const c of clinicians) {
    const r = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: c.specialty,
    });
    if (!r.ok) throw new Error(r.error);
    applyStaffCommand(state, { type: "set_clinic_sessions", id: r.staff.id, sessions: c.sessions });
  }
  return state;
}
