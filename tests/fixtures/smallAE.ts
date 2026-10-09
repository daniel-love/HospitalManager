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
import type { StaffRoleId } from "@data/schema";
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

/** Applies the commands, throwing on the first that fails. */
export function applyAll(state: SimState, commands: Command[]): void {
  for (const cmd of commands) {
    const result = applyCommand(state, cmd);
    if (!result.ok) throw new Error(`${JSON.stringify(cmd)} failed: ${result.error}`);
  }
}

export interface SiteOptions {
  /**
   * Put the public road in below the building (default false), with a
   * footpath from the front door: walk-ins then arrive along the pavement
   * or off the bus, and ambulances drive in.
   */
  site?: boolean;
}

export function buildSmallAE(seed = 1, opts: SiteOptions = {}): SimState {
  const state = createSimState({ seed, width: 24, height: opts.site ? 30 : 20 });
  applyAll(state, SMALL_AE_COMMANDS);
  if (opts.site) addRoad(state);
  return state;
}

/** Fits the public road in below whatever's built, as an old save gets (world/site.ts). */
export function addRoad(state: SimState): void {
  const site = fitSite(state.floors[0]!);
  if (!site) throw new Error("No room for the road below the building");
  state.site = site;
  state.layoutVersion++;
}

export type StaffCounts = Partial<Record<StaffRoleId, number>>;

/** The M2 starting team for the small A&E. */
export const SMALL_AE_TEAM: StaffCounts = {
  receptionist: 1,
  nurse: 2,
  junior_doctor: 2,
  cleaner: 1,
};

export function hireTeam(state: SimState, team: StaffCounts): void {
  for (const [role, n] of Object.entries(team) as [StaffRoleId, number][]) {
    for (let i = 0; i < n; i++) applyStaffCommand(state, { type: "hire_staff", role });
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
