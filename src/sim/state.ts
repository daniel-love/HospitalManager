/**
 * SimState is the whole simulation as plain, serialisable data: no class
 * instances, no Pixi objects, no functions. It doubles as the save schema
 * (see save/codec.ts), except for fields marked "derived", which are rebuilt
 * after loading.
 */
import { STARTING_CASH } from "@data/economy";
import { DEFAULT_CATCHMENT } from "@data/patients";
import {
  type Ambulance,
  emptyLedger,
  emptyStats,
  type DayReport,
  type FlowStats,
  type Incident,
  type Job,
  type Ledger,
  type Patient,
  type SimEvent,
  type Staff,
} from "./agents";
import type { PlanEntry } from "./plan";
import { createRng, type RngState } from "./rng";
import { createFloorGrid, type FloorGrid } from "./world/grid";
import type { Rect } from "./world/rect";
import { layOutSite, type Site } from "./world/site";

export const SIM_STATE_VERSION = 12;

/** Quarter turns clockwise. */
export type Rotation = 0 | 1 | 2 | 3;

/** A placed piece of equipment or a door. Covers every tile of its footprint. */
export interface PlacedObject {
  id: number;
  defId: string;
  floor: number;
  /** Top-left tile of the rotated footprint. */
  x: number;
  y: number;
  rotation: Rotation;
}

export interface RoomCheck {
  label: string;
  ok: boolean;
  /** Extra detail, e.g. "4 of 6". */
  detail?: string;
}

/** A detected room: a connected area of one zone type, bounded by walls and doors. */
export interface Room {
  /** Matches FloorGrid.roomId. Reassigned whenever rooms are re-detected. */
  id: number;
  floor: number;
  typeId: string;
  /** Tile indices into the floor grid. */
  tiles: number[];
  bounds: Rect;
  /** Objects wholly inside the room. */
  objectIds: number[];
  capabilities: string[];
  checks: RoomCheck[];
  valid: boolean;
}

export interface SimState {
  version: number;
  seed: number;
  rng: RngState;
  /** Ticks elapsed since the game started. */
  tick: number;
  /** Cash in £. Can't go below zero through building. */
  money: number;
  /** One grid per floor; index 0 is the ground floor. */
  floors: FloorGrid[];
  /** The public road and pavements (world/site.ts); null on a blank map. */
  site: Site | null;
  /** Keyed by object id. */
  objects: Record<number, PlacedObject>;
  nextObjectId: number;
  /** Build plan (blueprint) not yet built or paid for. See plan.ts. */
  plan: PlanEntry[];
  /** Bumped by every layout change, so agents know to re-plan their routes. */
  layoutVersion: number;

  patients: Record<number, Patient>;
  staff: Record<number, Staff>;
  /** Shared id sequence for patients and staff. */
  nextAgentId: number;
  jobs: Record<number, Job>;
  nextJobId: number;
  /** Ambulances parked or waiting outside, keyed by id. */
  ambulances: Record<number, Ambulance>;
  nextAmbulanceId: number;
  /**
   * Who has claimed what: "objectId:slot" → agent id. Slots are seats on a
   * bench, 0 for a couch or toilet, "staff" for the staff side of a desk.
   */
  reserved: Record<string, number>;
  /** Uses since last cleaned, by object id (couches and toilets). */
  dirt: Record<number, number>;

  /** Money and patient flow so far today, and reports for past days (newest last). */
  today: { ledger: Ledger; stats: FlowStats };
  history: DayReport[];
  settings: SimSettings;
  /** Tick each kind of warning was last raised, so they aren't repeated constantly. */
  alerts: Record<string, number>;
  /** Patient safety incidents, oldest first (capped; see MAX_INCIDENTS). */
  incidents: Incident[];
  nextIncidentId: number;

  /** Not saved: messages for the notifications feed, drained by the game each frame. */
  events: SimEvent[];
  /** Derived (not saved): rebuilt by detectRooms() after every layout change. */
  rooms: Room[];
  /** Derived (not saved): room id holding each object wholly inside a room. */
  objectRoom: Record<number, number>;
}

/** Sandbox difficulty knobs (GAME_DESIGN §2.4). */
export interface SimSettings {
  /** People the hospital serves (see data/patients.ts CATCHMENTS): sets demand. */
  catchment: number;
  /** Multiplies arrival rates on top of the catchment's: 1 = real-world per-person rates. */
  patientVolume: number;
}

export interface NewGameOptions {
  seed: number;
  width?: number;
  height?: number;
  money?: number;
  /** Lay out the public road (world/site.ts). Off for blank test maps. */
  site?: boolean;
}

export const DEFAULT_MAP_SIZE = 200;

export function createSimState(opts: NewGameOptions): SimState {
  const width = opts.width ?? DEFAULT_MAP_SIZE;
  const height = opts.height ?? DEFAULT_MAP_SIZE;
  const ground = createFloorGrid(width, height);
  return {
    version: SIM_STATE_VERSION,
    seed: opts.seed >>> 0,
    rng: createRng(opts.seed),
    tick: 0,
    money: opts.money ?? STARTING_CASH,
    floors: [ground],
    site: opts.site ? layOutSite(ground) : null,
    objects: {},
    nextObjectId: 1,
    plan: [],
    layoutVersion: 0,
    patients: {},
    staff: {},
    nextAgentId: 1,
    jobs: {},
    nextJobId: 1,
    ambulances: {},
    nextAmbulanceId: 1,
    reserved: {},
    dirt: {},
    today: { ledger: emptyLedger(), stats: emptyStats() },
    history: [],
    settings: { catchment: DEFAULT_CATCHMENT, patientVolume: 1 },
    alerts: {},
    incidents: [],
    nextIncidentId: 1,
    events: [],
    rooms: [],
    objectRoom: {},
  };
}
