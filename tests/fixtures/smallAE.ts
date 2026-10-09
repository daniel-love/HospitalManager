/**
 * The M1 "done when" layout, built through commands like a player would:
 * reception, waiting area, triage, two minors cubicles, a toilet and a
 * corridor, inside one walled building with a double-door entrance.
 *
 * Tiles from (2,2) to (18,16). # wall, D door, letters are zones (w waiting,
 * l toilets, r reception, c corridor, t triage, m minors); capitals are
 * equipment (W toilet, S sink, B bench, R desk, C curtain,
 * E examination couch, O obs machine).
 *
 *   #################
 *   #WS#wwwwwcc#tOtE#
 *   #ll#wwwwwcc#tttE#
 *   ##D#wwwwwccDtttt#
 *   #wwwwwwwwcc#Sttt#
 *   #wwwBBBwwcc######
 *   #wwwwwwwwcc#CmmE#
 *   #wwwBBBwwccDmmmE#
 *   #rrrrrrrrcc#mmOm#
 *   #rrRRRrrrcc######
 *   #rrrrrrrrcc#CmmE#
 *   #rrrrrrrrccDmmmE#
 *   #rrrrrrrrcc#mmOm#
 *   #rrrrrrrrcc#mmmm#
 *   ###DD############
 */
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import { applyCommand, type Command } from "@sim/commands";
import { applyStaffCommand } from "@sim/systems/staffing";
import { createSimState, type Rotation, type SimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import { fitSite } from "@sim/world/site";

const F = 0;
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  x: x0,
  y: y0,
  w: x1 - x0 + 1,
  h: y1 - y0 + 1,
});

export const SMALL_AE_COMMANDS: Command[] = [
  { type: "build_floor", floor: F, rect: rect(2, 2, 18, 16) },
  // Shell, then internal walls.
  { type: "build_walls", floor: F, rect: rect(2, 2, 18, 16), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(13, 2, 13, 16), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(13, 7, 18, 7), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(13, 11, 18, 11), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(5, 2, 5, 5), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(2, 5, 5, 5), wall: WallType.Standard },
  // Doors.
  { type: "place_object", floor: F, defId: "door_double", x: 5, y: 16, rotation: 0 },
  { type: "place_object", floor: F, defId: "door_single", x: 4, y: 5, rotation: 0 },
  { type: "place_object", floor: F, defId: "door_single", x: 13, y: 5, rotation: 1 },
  { type: "place_object", floor: F, defId: "door_single", x: 13, y: 9, rotation: 1 },
  { type: "place_object", floor: F, defId: "door_single", x: 13, y: 13, rotation: 1 },
  // Zones.
  { type: "zone", floor: F, rect: rect(3, 3, 10, 9), roomType: "waiting_area" },
  { type: "zone", floor: F, rect: rect(3, 3, 4, 4), roomType: "toilets" },
  { type: "zone", floor: F, rect: rect(3, 10, 10, 15), roomType: "ae_reception" },
  { type: "zone", floor: F, rect: rect(11, 3, 12, 15), roomType: "corridor" },
  { type: "zone", floor: F, rect: rect(14, 3, 17, 6), roomType: "triage_room" },
  { type: "zone", floor: F, rect: rect(14, 8, 17, 10), roomType: "minors_cubicle" },
  { type: "zone", floor: F, rect: rect(14, 12, 17, 15), roomType: "minors_cubicle" },
  // Equipment.
  ...place("toilet", 3, 3),
  ...place("sink", 4, 3),
  ...place("waiting_bench", 6, 7),
  ...place("waiting_bench", 6, 9),
  ...place("reception_desk", 5, 11),
  ...place("exam_couch", 17, 3),
  ...place("obs_machine", 15, 3),
  ...place("sink", 14, 6, 2),
  ...cubicle(8),
  ...cubicle(12),
];

/** Rotation 0 faces down; 2 faces up (back against a wall below). */
function place(defId: string, x: number, y: number, rotation: Rotation = 0): Command[] {
  return [{ type: "place_object", floor: F, defId, x, y, rotation }];
}

function cubicle(y: number): Command[] {
  return [
    ...place("exam_couch", 17, y),
    ...place("privacy_curtain", 14, y),
    ...place("obs_machine", 16, y + 2, 2),
  ];
}

/**
 * A diagnostics block east of the building (M4): an annex corridor with an
 * outside door, an X-ray Room and a CT Room (lead-lined), and a Pathology
 * Lab. Patients reach it through a door in the waiting area's north wall and
 * a short walk outside.
 *
 *   x=20      29
 *   ##########   y=1
 *   #cc#xxxxx#   X-ray Room (y 2–6), door at (23, 4); unit at (26, 3)
 *   Dcc#xxxxx#   door from outside at (20, 3)
 *   #cc#######   y=7 (lead)
 *   #cc#ttttt#   CT Room (y 8–12), door at (23, 10); scanner at (25, 8)
 *   #cc#######   y=13
 *   #cc#lllll#   Pathology Lab (y 14–18), door at (23, 16); analyser at (25, 15)
 *   ##########   y=19
 */
export const DIAGNOSTICS_COMMANDS: Command[] = [
  { type: "place_object", floor: F, defId: "door_single", x: 8, y: 2, rotation: 0 },
  { type: "build_floor", floor: F, rect: rect(20, 1, 29, 19) },
  { type: "build_walls", floor: F, rect: rect(20, 1, 29, 19), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(23, 1, 23, 19), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(23, 13, 29, 13), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(23, 1, 29, 7), wall: WallType.Lead },
  { type: "build_walls", floor: F, rect: rect(23, 7, 29, 13), wall: WallType.Lead },
  { type: "place_object", floor: F, defId: "door_single", x: 20, y: 3, rotation: 1 },
  { type: "place_object", floor: F, defId: "door_double", x: 23, y: 3, rotation: 1 },
  { type: "place_object", floor: F, defId: "door_double", x: 23, y: 9, rotation: 1 },
  { type: "place_object", floor: F, defId: "door_single", x: 23, y: 16, rotation: 1 },
  { type: "zone", floor: F, rect: rect(21, 2, 22, 18), roomType: "corridor" },
  { type: "zone", floor: F, rect: rect(24, 2, 28, 6), roomType: "xray_room" },
  { type: "zone", floor: F, rect: rect(24, 8, 28, 12), roomType: "ct_room" },
  { type: "zone", floor: F, rect: rect(24, 14, 28, 18), roomType: "lab" },
  ...place("xray_unit", 26, 3),
  ...place("ct_scanner", 25, 8),
  ...place("blood_analyser", 25, 15),
];

/** Width that fits the diagnostics block. */
export const MAP_WIDTH = 32;
/** Enough to build everything, CT scanner included, with plenty left to run on. */
export const FIXTURE_MONEY = 5_000_000;

/** Applies the commands, throwing on the first that fails. */
export function applyAll(state: SimState, commands: Command[]): void {
  for (const cmd of commands) {
    const result = applyCommand(state, cmd);
    if (!result.ok) throw new Error(`${JSON.stringify(cmd)} failed: ${result.error}`);
  }
}

export interface SiteOptions {
  /** The diagnostics block: X-ray, CT and a lab (default true). */
  diagnostics?: boolean;
  /**
   * Put the public road in below the building (default false), with a
   * footpath from the front door: walk-ins then arrive along the pavement
   * or off the bus, and ambulances drive in.
   */
  site?: boolean;
}

export function buildSmallAE(seed = 1, opts: SiteOptions = {}): SimState {
  const state = createSimState({
    seed,
    width: MAP_WIDTH,
    height: opts.site ? 34 : 20,
    money: FIXTURE_MONEY,
  });
  applyAll(state, [
    ...SMALL_AE_COMMANDS,
    ...(opts.diagnostics === false ? [] : DIAGNOSTICS_COMMANDS),
  ]);
  if (opts.site) addRoad(state);
  return state;
}

/** Fits the public road in below whatever's built, as an old save gets (world/site.ts). */
export function addRoad(state: SimState): void {
  const site = fitSite(state.floors[0]!);
  if (!site) throw new Error("No room for the road below the building");
  state.site = site;
  state.layoutVersion++;
  // A footpath from the waiting area's north door round to the diagnostics block.
  if (state.rooms.some((r) => r.typeId === "lab")) {
    applyAll(state, [
      { type: "pave", floor: F, rect: rect(8, 1, 19, 1), surface: "path" },
      { type: "pave", floor: F, rect: rect(19, 2, 19, 3), surface: "path" },
    ]);
  }
}

export type StaffCounts = Partial<Record<StaffRoleId, number>>;

/** The M2 starting team for the small A&E. */
export const SMALL_AE_TEAM: StaffCounts = {
  receptionist: 1,
  nurse: 2,
  junior_doctor: 2,
  cleaner: 1,
  // M4: X-rays, CT and blood tests.
  radiographer: 1,
  biomedical_scientist: 1,
  porter: 1,
};

export function hireTeam(state: SimState, team: StaffCounts): void {
  for (const [role, n] of Object.entries(team) as [StaffRoleId, number][]) {
    for (let i = 0; i < n; i++) applyStaffCommand(state, { type: "hire_staff", role });
  }
}

/**
 * One resident registrar for each specialty, so patients who need admitting
 * can be referred and admitted rather than transferred out.
 */
export const ADMITTING_SPECIALTIES: SpecialtyId[] = [
  "general_medicine",
  "cardiology",
  "general_surgery",
];

export function hireRegistrars(
  state: SimState,
  specialties: readonly SpecialtyId[] = ADMITTING_SPECIALTIES,
): void {
  for (const specialty of specialties) {
    applyStaffCommand(state, { type: "hire_staff", role: "registrar", specialty });
  }
}

/** The small A&E with a team hired, ready to run. */
export function staffedSmallAE(
  seed = 1,
  team: StaffCounts = SMALL_AE_TEAM,
  opts: SiteOptions = {},
): SimState {
  const state = buildSmallAE(seed, opts);
  hireTeam(state, team);
  return state;
}
