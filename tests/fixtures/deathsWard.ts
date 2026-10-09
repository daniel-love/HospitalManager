/**
 * A small inpatient block for testing the process after a death: a 3-wide
 * corridor with a four-bed ward, a side room, a relatives' room and an office
 * (with a desk for the Medical Examiner) above it, and a mortuary below.
 *
 *   ############################   y=1
 *   #B B B B  #B  #S   #  Dk   #   ward | side room | relatives' room | office
 *   #...    S #  S#    #       #
 *   ####DD#######DD#####D###D###   y=8
 *   #cccccccccccccccccccccccccc#   corridor y 9–11
 *   ##DD#########DD#############   y=12, mortuary door at x 3–4, lobby door at x 14–15
 *   #     #
 *   #  FF #                        mortuary fridge at x 3–4, y 17
 *   #############DD#############   y=18, way in at x 14–15
 */
import type { Command } from "@sim/commands";
import { createSimState, type Rotation, type SimState } from "@sim/state";
import { applyStaffCommand } from "@sim/systems/staffing";
import { WallType } from "@sim/world/grid";
import { addRoad, applyAll, hireTeam, type StaffCounts } from "./smallAE";

const F = 0;
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  x: x0,
  y: y0,
  w: x1 - x0 + 1,
  h: y1 - y0 + 1,
});
const place = (defId: string, x: number, y: number, rotation: Rotation = 0): Command => ({
  type: "place_object",
  floor: F,
  defId,
  x,
  y,
  rotation,
});
const wall = (x0: number, y0: number, x1: number, y1: number): Command => ({
  type: "build_walls",
  floor: F,
  rect: rect(x0, y0, x1, y1),
  wall: WallType.Standard,
});

export interface DeathsOptions {
  /** Include the relatives' room (default true). */
  relativesRoom?: boolean;
  /** Include the mortuary (default true). */
  mortuary?: boolean;
  /** The mortuary's door: a single door is too narrow for a trolley. */
  mortuaryDoor?: "door_double" | "door_single";
  /** Put the public road in below the building (default false), so funeral directors drive in. */
  site?: boolean;
}

export function buildDeathsWard(seed = 1, opts: DeathsOptions = {}): SimState {
  const state = createSimState({ seed, width: 30, height: opts.site ? 34 : 20 });
  applyAll(state, [
    { type: "build_floor", floor: F, rect: rect(1, 1, 28, 18) },
    wall(1, 1, 28, 18),
    wall(1, 8, 28, 8),
    wall(1, 12, 28, 12),
    wall(11, 1, 11, 8),
    wall(16, 1, 16, 8),
    wall(21, 1, 21, 8),
    wall(7, 12, 7, 18),
    { type: "place_object", floor: F, defId: "door_double", x: 14, y: 18, rotation: 0 },
    { type: "place_object", floor: F, defId: "door_double", x: 14, y: 12, rotation: 0 },
    { type: "place_object", floor: F, defId: "door_double", x: 5, y: 8, rotation: 0 },
    { type: "place_object", floor: F, defId: "door_double", x: 13, y: 8, rotation: 0 },
    { type: "place_object", floor: F, defId: "door_single", x: 18, y: 8, rotation: 0 },
    { type: "place_object", floor: F, defId: "door_single", x: 24, y: 8, rotation: 0 },
    { type: "zone", floor: F, rect: rect(2, 9, 27, 11), roomType: "corridor" },
    { type: "zone", floor: F, rect: rect(2, 2, 10, 7), roomType: "ward" },
    ...[3, 5, 7, 9].map((x) => place("hospital_bed", x, 2)),
    place("sink", 10, 7, 2),
    { type: "zone", floor: F, rect: rect(12, 2, 15, 7), roomType: "side_room" },
    place("hospital_bed", 13, 2),
    place("sink", 15, 7, 2),
    ...(opts.relativesRoom === false
      ? []
      : [
          { type: "zone" as const, floor: F, rect: rect(17, 2, 20, 7), roomType: "relatives_room" },
          place("sofa", 18, 2),
        ]),
    place("desk", 24, 3),
    ...(opts.mortuary === false
      ? []
      : [
          {
            type: "place_object" as const,
            floor: F,
            defId: opts.mortuaryDoor ?? "door_double",
            x: 3,
            y: 12,
            rotation: 0 as Rotation,
          },
          { type: "zone" as const, floor: F, rect: rect(2, 13, 6, 17), roomType: "mortuary" },
          place("mortuary_fridge", 3, 17, 2),
        ]),
  ]);
  if (opts.site) addRoad(state);
  return state;
}

export const DEATHS_TEAM: StaffCounts = {
  nurse: 2,
  junior_doctor: 1,
  porter: 1,
  cleaner: 1,
};

/** The deaths ward with a team, and (unless `medicalExaminer` is false) a consultant Medical Examiner. */
export function staffedDeathsWard(
  seed = 1,
  team: StaffCounts = DEATHS_TEAM,
  opts: DeathsOptions & { medicalExaminer?: boolean } = {},
): SimState {
  const state = buildDeathsWard(seed, opts);
  hireTeam(state, team);
  if (opts.medicalExaminer !== false) {
    const r = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: "general_medicine",
    });
    if (r.ok) applyStaffCommand(state, { type: "set_me_duty", id: r.staff.id, on: true });
  }
  state.settings.patientVolume = 0;
  return state;
}
