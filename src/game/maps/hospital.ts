/**
 * (Building blocks for scenario hospitals and tests: tests/fixtures re-exports this.)
 *
 * A whole small hospital for balance checks and whole-hospital tests: the
 * majors A&E (with Resus, an ambulance bay, diagnostics and its six-bed
 * ward) on the west, the outpatients department north-east and the
 * surgical block (Day Surgery Unit, eight-bed ward, two theatres, Recovery)
 * south-east, each its own building on grass, reached from the bottom of
 * the map. Built by shifting the other fixtures' commands.
 *
 *   x=0        31 34            59
 *   A&E + ward     | Outpatients   y 1–13
 *   (y 0–35)       | Surgical block y 17–39
 */
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { Command } from "@sim/commands";
import { createSimState, type SimState } from "@sim/state";
import { applyStaffCommand } from "@sim/systems/staffing";
import { roomAt, setRoomSpecialty } from "@sim/world/rooms";
import {
  MAJORS_WING_COMMANDS,
  NURSE_STATION,
  RESUS_AND_BAY_COMMANDS,
  wardCommands,
} from "./majorsAE";
import { CLINIC_A, OUTPATIENTS_COMMANDS } from "./outpatients";
import {
  applyAll,
  DIAGNOSTICS_COMMANDS,
  FIXTURE_MONEY,
  hireRegistrars,
  SMALL_AE_COMMANDS,
} from "./smallAE";
import { THEATRE_A, THEATRES_COMMANDS } from "./theatres";

const F = 0;
const OUTPATIENTS_AT = { x: 34, y: 0 };
const SURGICAL_AT = { x: 34, y: 16 };

/** The same commands, `by` tiles further east and south. */
export function shift(commands: Command[], by: { x: number; y: number }): Command[] {
  return commands.map((c) => {
    if ("rect" in c) return { ...c, rect: { ...c.rect, x: c.rect.x + by.x, y: c.rect.y + by.y } };
    if (c.type === "place_object") return { ...c, x: c.x + by.x, y: c.y + by.y };
    return c;
  });
}

export function buildHospital(seed = 1): SimState {
  const state = createSimState({ seed, width: 60, height: 42, money: FIXTURE_MONEY });
  applyAll(state, [
    ...SMALL_AE_COMMANDS,
    ...DIAGNOSTICS_COMMANDS,
    ...MAJORS_WING_COMMANDS,
    ...NURSE_STATION,
    ...RESUS_AND_BAY_COMMANDS,
    ...wardCommands("door_double"),
    ...shift(OUTPATIENTS_COMMANDS, OUTPATIENTS_AT),
    ...shift(THEATRES_COMMANDS, SURGICAL_AT),
  ]);
  const at = (p: { x: number; y: number }, by: { x: number; y: number }) =>
    roomAt(state, F, p.x + by.x, p.y + by.y)!;
  setRoomSpecialty(state, at(CLINIC_A, OUTPATIENTS_AT), "cardiology");
  setRoomSpecialty(state, at(THEATRE_A, SURGICAL_AT), "trauma_orthopaedics");
  return state;
}

/** Everyone the fixture needs at once (per shift, with rotas). */
export const HOSPITAL_TEAM: Partial<Record<StaffRoleId, number>> = {
  receptionist: 2,
  nurse: 7,
  junior_doctor: 4,
  cleaner: 2,
  radiographer: 1,
  biomedical_scientist: 1,
  porter: 2,
  theatre_practitioner: 2,
};

/**
 * The hospital with a team: medical registrars, a cardiologist running
 * clinics, a T&O surgeon with clinics and theatre lists, and an anaesthetist.
 */
export function staffedHospital(seed = 1, team = HOSPITAL_TEAM): SimState {
  const state = buildHospital(seed);
  for (const [role, n] of Object.entries(team) as [StaffRoleId, number][]) {
    for (let i = 0; i < n; i++) applyStaffCommand(state, { type: "hire_staff", role });
  }
  hireRegistrars(state, [
    "general_medicine",
    "cardiology",
    "general_surgery",
    "trauma_orthopaedics",
  ]);
  const consultant = (specialty: SpecialtyId, clinics: number, lists: number) => {
    const r = applyStaffCommand(state, { type: "hire_staff", role: "consultant", specialty });
    if (!r.ok) throw new Error(r.error);
    const id = r.staff.id;
    if (clinics) applyStaffCommand(state, { type: "set_clinic_sessions", id, sessions: clinics });
    if (lists) applyStaffCommand(state, { type: "set_theatre_sessions", id, sessions: lists });
  };
  consultant("cardiology", 4, 0);
  consultant("trauma_orthopaedics", 3, 3);
  consultant("anaesthetics", 0, 3);
  return state;
}
