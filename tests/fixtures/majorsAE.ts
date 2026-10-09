/**
 * The small A&E plus a Majors wing below it, reached through a double door
 * from the corridor: three Majors Bays off a wide corridor, with a nurse
 * station in the corridor. The station can see the first two bays; the wall
 * between bays 2 and 3 hides the third (a deliberate blind spot).
 *
 * Wing tiles from (8,16) to (18,28). c corridor, m majors bay, N nurse
 * station (staff stand on n), T trolley, M monitor, O oxygen, C curtain,
 * E 12-lead ECG.
 *
 *   ###DD######   y=16 (the small A&E's bottom wall)
 *   #ccccCMTO#    bay 1 (y 17–19)
 *   #cccccmTm#
 *   #cccccEmm#
 *   #ccn######    y=20
 *   #cNNNCMTO#    bay 2 (y 21–23)
 *   #cccccmTm#
 *   #cccccEmm#
 *   #ccccc####    y=24
 *   #ccccCMTO#    bay 3 (y 25–27): out of the station's sight
 *   #cccccmTm#
 *   #cccccEmm#
 *   ###########   y=28
 */
import type { Command } from "@sim/commands";
import { createSimState, type Rotation, type SimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import {
  addRoad,
  applyAll,
  hireTeam,
  SMALL_AE_COMMANDS,
  type SiteOptions,
  type StaffCounts,
} from "./smallAE";

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

/** Top row of each bay. */
export const BAY_ROWS = [17, 21, 25] as const;
/** Where the station nurse stands (and watches from). */
export const STATION_SPOT = { x: 11, y: 20 };

function bay(y: number): Command[] {
  return [
    ...place("trolley", 16, y),
    ...place("bedside_monitor", 15, y),
    ...place("oxygen_point", 17, y),
    ...place("privacy_curtain", 14, y),
    // Faces right, into the bay.
    ...place("ecg_12lead", 14, y + 2, 3),
  ];
}

export const MAJORS_WING_COMMANDS: Command[] = [
  { type: "build_floor", floor: F, rect: rect(8, 17, 18, 28) },
  { type: "build_walls", floor: F, rect: rect(8, 16, 18, 28), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(14, 20, 17, 20), wall: WallType.Standard },
  { type: "build_walls", floor: F, rect: rect(14, 24, 17, 24), wall: WallType.Standard },
  { type: "place_object", floor: F, defId: "door_double", x: 11, y: 16, rotation: 0 },
  { type: "zone", floor: F, rect: rect(9, 17, 13, 27), roomType: "corridor" },
  ...BAY_ROWS.map((y) => ({
    type: "zone" as const,
    floor: F,
    rect: rect(14, y, 17, y + 2),
    roomType: "majors_bay",
  })),
  ...BAY_ROWS.flatMap(bay),
];

export const NURSE_STATION: Command[] = place("nurse_station", 10, 21);

/**
 * Resus below the wing, through a double door from the corridor, and a
 * one-ambulance bay beside Resus, through a double door in its east wall.
 *
 *   #DD#####     y=28 (the wing's bottom wall; door at x 10–11)
 *   #S  MO#      suction, monitor, oxygen (top wall)
 *   #   T D  b   trolley (x 12); door at x 14, y 30–31; bay x 15–17, y 29–34
 *   #V  T D  b   ventilator
 *   #     #  b
 *   #F   R#  b   defibrillator, resus trolley
 *   #######  b   y=34
 */
export const RESUS_AND_BAY_COMMANDS: Command[] = [
  { type: "build_floor", floor: F, rect: rect(9, 29, 13, 33) },
  { type: "build_walls", floor: F, rect: rect(8, 28, 14, 34), wall: WallType.Standard },
  { type: "place_object", floor: F, defId: "door_double", x: 10, y: 28, rotation: 0 },
  { type: "zone", floor: F, rect: rect(9, 29, 13, 33), roomType: "resus_bay" },
  ...place("trolley", 12, 30),
  ...place("bedside_monitor", 12, 29),
  ...place("oxygen_point", 13, 29),
  ...place("suction_unit", 9, 29),
  ...place("ventilator", 9, 31, 3),
  ...place("defibrillator", 9, 33, 2),
  ...place("resus_trolley", 13, 33, 2),
  { type: "build_floor", floor: F, rect: rect(15, 29, 17, 34) },
  { type: "place_object", floor: F, defId: "door_double", x: 14, y: 30, rotation: 1 },
  { type: "zone", floor: F, rect: rect(15, 29, 17, 34), roomType: "ambulance_bay" },
];

/**
 * A six-bed ward west of the wing, through a door in the wing's west wall
 * (a double door unless `door` says otherwise). Clear of the main entrance,
 * which still opens onto grass at y 17.
 *
 *   ########     y=18
 *   #B B B #     beds at x 2, 4, 6 (y 19–20)
 *   #B B B #
 *   #      D     door at x 8, y 22–23
 *   #      D
 *   #      #
 *   #B B B #     beds at x 2, 4, 6 (y 25–26)
 *   #B B B #
 *   #     S#     sink
 *   ########     y=28
 */
export function wardCommands(door: "door_double" | "door_single" = "door_double"): Command[] {
  return [
    { type: "build_floor", floor: F, rect: rect(1, 18, 7, 28) },
    { type: "build_walls", floor: F, rect: rect(1, 18, 8, 28), wall: WallType.Standard },
    { type: "place_object", floor: F, defId: door, x: 8, y: 22, rotation: 1 },
    { type: "zone", floor: F, rect: rect(2, 19, 7, 27), roomType: "ward" },
    ...[2, 4, 6].flatMap((x) => [...place("hospital_bed", x, 19), ...place("hospital_bed", x, 25)]),
    ...place("sink", 7, 27, 2),
  ];
}

export interface MajorsOptions extends SiteOptions {
  /** Include the nurse station (default true). */
  station?: boolean;
  /** A central monitoring station in its place (default false). */
  centralMonitor?: boolean;
  /** Include Resus and an ambulance bay (default false). */
  ambulance?: boolean;
  /** Include a ward, through this kind of door (default: none). */
  ward?: "door_double" | "door_single";
}

export function buildMajorsAE(seed = 1, opts: MajorsOptions = {}): SimState {
  const height = (opts.ambulance ? 36 : 32) + (opts.site ? 12 : 0);
  const state = createSimState({ seed, width: 24, height });
  applyAll(state, [
    ...SMALL_AE_COMMANDS,
    ...MAJORS_WING_COMMANDS,
    ...(opts.centralMonitor
      ? place("central_monitor", 10, 21)
      : opts.station === false
        ? []
        : NURSE_STATION),
    ...(opts.ambulance ? RESUS_AND_BAY_COMMANDS : []),
    ...(opts.ward ? wardCommands(opts.ward) : []),
  ]);
  if (opts.site) {
    addRoad(state);
    // The main entrance's footpath comes with the road; the ambulance bay
    // needs an access road down to it, across the pavement.
    if (opts.ambulance) {
      const pavement = state.site!.pavements[0];
      applyAll(state, [
        {
          type: "pave",
          floor: F,
          rect: rect(15, 35, 17, pavement.y + pavement.h - 1),
          surface: "road",
        },
      ]);
    }
  }
  return state;
}

export const MAJORS_TEAM: StaffCounts = {
  receptionist: 1,
  nurse: 4,
  junior_doctor: 3,
  cleaner: 1,
};

export function staffedMajorsAE(
  seed = 1,
  team: StaffCounts = MAJORS_TEAM,
  opts: MajorsOptions = {},
): SimState {
  const state = buildMajorsAE(seed, opts);
  hireTeam(state, team);
  return state;
}
