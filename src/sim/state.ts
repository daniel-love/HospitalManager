/**
 * SimState is the whole simulation as plain, serialisable data: no class
 * instances, no Pixi objects, no functions. It doubles as the save schema
 * (see save/codec.ts), except for fields marked "derived", which are rebuilt
 * after loading.
 */
import { STARTING_CASH } from "@data/economy";
import type { PlanEntry } from "./plan";
import { createRng, type RngState } from "./rng";
import { createFloorGrid, type FloorGrid } from "./world/grid";
import type { Rect } from "./world/rect";

export const SIM_STATE_VERSION = 2;

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
  /** Keyed by object id. */
  objects: Record<number, PlacedObject>;
  nextObjectId: number;
  /** Build plan (blueprint) not yet built or paid for. See plan.ts. */
  plan: PlanEntry[];
  /** Derived (not saved): rebuilt by detectRooms() after every layout change. */
  rooms: Room[];
}

export interface NewGameOptions {
  seed: number;
  width?: number;
  height?: number;
  money?: number;
}

export const DEFAULT_MAP_SIZE = 200;

export function createSimState(opts: NewGameOptions): SimState {
  const width = opts.width ?? DEFAULT_MAP_SIZE;
  const height = opts.height ?? DEFAULT_MAP_SIZE;
  return {
    version: SIM_STATE_VERSION,
    seed: opts.seed >>> 0,
    rng: createRng(opts.seed),
    tick: 0,
    money: opts.money ?? STARTING_CASH,
    floors: [createFloorGrid(width, height)],
    objects: {},
    nextObjectId: 1,
    plan: [],
    rooms: [],
  };
}
