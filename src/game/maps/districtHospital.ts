/**
 * A pre-built district general hospital for scenarios (data/scenarios.ts
 * `start`): the whole small hospital (A&E with Resus and an ambulance bay,
 * diagnostics, a medical ward, outpatients and a surgical block with two
 * theatres) on a plot with room to grow east, the public road fitted below
 * it, an access road down to the ambulance bay, and footpaths to each
 * block's door. Staffed on a lean, safe rota, with everyone hired.
 */
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { NurseBand } from "@data/staff";
import type { SimState } from "@sim/state";
import { setCover } from "@sim/systems/rota";
import { applyStaffCommand } from "@sim/systems/staffing";
import { fitSite } from "@sim/world/site";
import { roomAt, setRoomSpecialty } from "@sim/world/rooms";
import {
  MAJORS_WING_COMMANDS,
  NURSE_STATION,
  RESUS_AND_BAY_COMMANDS,
  wardCommands,
} from "./majorsAE";
import { CLINIC_A, OUTPATIENTS_COMMANDS } from "./outpatients";
import { applyAll, DIAGNOSTICS_COMMANDS, SMALL_AE_COMMANDS } from "./smallAE";
import { shift } from "./hospital";
import { THEATRE_A, THEATRES_COMMANDS } from "./theatres";

const F = 0;
const OUTPATIENTS_AT = { x: 34, y: 0 };
const SURGICAL_AT = { x: 34, y: 16 };
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  x: x0,
  y: y0,
  w: x1 - x0 + 1,
  h: y1 - y0 + 1,
});

/** The plot: the hospital in the north-west corner, room to grow east and south. */
export const DISTRICT_MAP = { width: 110, height: 80 };

type Cover = [StaffRoleId, number, number, { band?: NurseBand; specialty?: SpecialtyId }?];

/** People wanted on each day and night shift. */
const COVER: Cover[] = [
  ["nurse", 6, 5],
  ["nurse", 1, 1, { band: 7 }],
  ["junior_doctor", 4, 2],
  ["receptionist", 2, 1],
  ["cleaner", 2, 1],
  ["porter", 2, 1],
  ["radiographer", 1, 1],
  ["biomedical_scientist", 1, 1],
  ["theatre_practitioner", 2, 1],
  ["registrar", 1, 1, { specialty: "general_medicine" }],
  ["registrar", 1, 1, { specialty: "trauma_orthopaedics" }],
];

/**
 * Builds the hospital onto a fresh, empty state of DISTRICT_MAP's size
 * (no site yet): buildings, the road, access road and paths, specialties,
 * staff and rota. The cost is not charged: it's the hospital you inherit.
 */
export function buildDistrictHospital(state: SimState): void {
  // An inherited hospital: built and staffed, not bought or recruited.
  const money = state.money;
  const recruiting = state.settings.recruitment;
  state.money = Number.MAX_SAFE_INTEGER;
  state.settings.recruitment = false;
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
  const site = fitSite(state.floors[F]!);
  if (!site) throw new Error("No room for the road below the district hospital");
  state.site = site;
  state.layoutVersion++;
  const pavement = site.pavements[0]!;
  const bottom = pavement.y + pavement.h - 1;
  applyAll(state, [
    // An access road from the ambulance bay down to the road.
    { type: "pave", floor: F, rect: rect(15, 35, 17, bottom), surface: "road" },
    // Footpaths from the outpatients and surgical blocks' doors down to the pavement.
    { type: "pave", floor: F, rect: rect(39, 14, 40, 15), surface: "path" },
    { type: "pave", floor: F, rect: rect(33, 15, 40, 15), surface: "path" },
    { type: "pave", floor: F, rect: rect(32, 15, 32, bottom), surface: "path" },
  ]);
  const at = (p: { x: number; y: number }, by: { x: number; y: number }) =>
    roomAt(state, F, p.x + by.x, p.y + by.y)!;
  setRoomSpecialty(state, at(CLINIC_A, OUTPATIENTS_AT), "cardiology");
  setRoomSpecialty(state, at(THEATRE_A, SURGICAL_AT), "trauma_orthopaedics");
  staff(state);
  state.money = money;
  state.month.flows.building = 0;
  state.settings.recruitment = recruiting;
  // Not a hundred "joined" messages: they were already here.
  state.events.length = 0;
}

function staff(state: SimState): void {
  const wanted = new Map<
    string,
    { role: StaffRoleId; extra: object; day: number; night: number }
  >();
  for (const [role, day, night, extra = {}] of COVER) {
    const key = `${role}:${JSON.stringify(extra)}`;
    const w = wanted.get(key) ?? { role, extra, day: 0, night: 0 };
    w.day += day;
    w.night += night;
    wanted.set(key, w);
  }
  for (const w of wanted.values()) {
    const e = w.extra as { band?: NurseBand; specialty?: SpecialtyId };
    const group =
      w.role === "nurse"
        ? `nurse:band${e.band ?? 5}`
        : e.specialty
          ? `${w.role}:${e.specialty}`
          : w.role;
    setCover(state, group, { day: w.day, night: w.night });
    const n = Math.ceil(((w.day + w.night) * 7) / 3);
    for (let i = 0; i < n; i++)
      applyStaffCommand(state, { type: "hire_staff", role: w.role, ...e });
  }
  const consultant = (specialty: SpecialtyId, clinics: number, lists: number, onCall = false) => {
    const r = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty,
      onCall,
    });
    if (!r.ok) return;
    const id = r.staff.id;
    if (clinics) applyStaffCommand(state, { type: "set_clinic_sessions", id, sessions: clinics });
    if (lists) applyStaffCommand(state, { type: "set_theatre_sessions", id, sessions: lists });
  };
  consultant("general_medicine", 0, 0);
  consultant("cardiology", 4, 0);
  consultant("trauma_orthopaedics", 3, 3);
  consultant("trauma_orthopaedics", 0, 0, true);
  consultant("anaesthetics", 0, 3);
  consultant("general_surgery", 0, 0, true);
  applyStaffCommand(state, { type: "hire_staff", role: "discharge_coordinator" });
  applyStaffCommand(state, { type: "hire_staff", role: "clinical_engineer" });
}
