/**
 * Where vehicles can drive (GAME_DESIGN §4.1): tarmac (the public road and
 * the player's access roads) and Ambulance Bays, clear of walls, doors and
 * equipment, and wide enough for an ambulance: every drivable tile is part of
 * a clear 3×3 square. Traffic drives on the left.
 */
import { roomById } from "@data/catalogue";
import type { Point } from "../agents";
import type { SimState } from "../state";
import { FloorType, tileIndex, type FloorGrid } from "./grid";
import type { Site } from "./site";

/** An ambulance is about 2.5 m wide, so it needs a 3-tile-wide way through. */
export const VEHICLE_WIDTH = 3;

export interface Drivable {
  /** 1 where a vehicle can drive. */
  tiles: Uint8Array;
  /**
   * Direction of traffic on the public road: 1 in the eastbound (north) lane,
   * -1 in the westbound (south) lane, 0 elsewhere.
   */
  lane: Int8Array;
  /** 1 where a vehicle can drive to from the public road. */
  reachable: Uint8Array;
}

const cache = new WeakMap<SimState, { version: number; drivable: Drivable }>();

/** The drivable tiles on the ground floor, cached per layout. */
export function drivable(state: SimState): Drivable {
  const cached = cache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.drivable;
  const grid = state.floors[0]!;
  const tiles = drivableTiles(grid);
  const reachable = new Uint8Array(tiles.length);
  const lane = new Int8Array(tiles.length);
  if (state.site) {
    const { road } = state.site;
    const half = Math.floor(road.h / 2);
    for (let y = road.y; y < road.y + road.h; y++) {
      for (let x = road.x; x < road.x + road.w; x++) {
        lane[tileIndex(grid, x, y)] = y < road.y + half ? 1 : -1;
      }
    }
    const starts = [...roadEnds(state.site, grid.width)].map((p) => tileIndex(grid, p.x, p.y));
    floodFill(grid, tiles, starts, reachable);
  }
  const result = { tiles, lane, reachable };
  cache.set(state, { version: state.layoutVersion, drivable: result });
  return result;
}

function drivableTiles(grid: FloorGrid): Uint8Array {
  const { width, height } = grid;
  const bay = roomById.get("ambulance_bay")!.code;
  const surface = new Uint8Array(width * height);
  for (let i = 0; i < surface.length; i++) {
    const paved = grid.floorType[i] === FloorType.Road || grid.zone[i] === bay;
    const clear = grid.wall[i] === 0 && grid.door[i] === 0 && grid.objectId[i] === -1;
    if (paved && clear) surface[i] = 1;
  }
  // Mark every tile of every clear 3×3 square.
  const out = new Uint8Array(width * height);
  const n = VEHICLE_WIDTH;
  for (let y = 0; y + n <= height; y++) {
    for (let x = 0; x + n <= width; x++) {
      let ok = true;
      for (let dy = 0; dy < n && ok; dy++) {
        for (let dx = 0; dx < n && ok; dx++) ok = surface[tileIndex(grid, x + dx, y + dy)] === 1;
      }
      if (!ok) continue;
      for (let dy = 0; dy < n; dy++) {
        for (let dx = 0; dx < n; dx++) out[tileIndex(grid, x + dx, y + dy)] = 1;
      }
    }
  }
  return out;
}

function floodFill(grid: FloorGrid, tiles: Uint8Array, starts: number[], out: Uint8Array): void {
  const queue = starts.filter((i) => tiles[i] === 1);
  for (const i of queue) out[i] = 1;
  const { width, height } = grid;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const x = cur % width;
    const y = (cur - x) / width;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = tileIndex(grid, nx, ny);
      if (tiles[n] !== 1 || out[n] === 1) continue;
      out[n] = 1;
      queue.push(n);
    }
  }
}

/**
 * Where vehicles come onto the map and leave it, keeping left: `in` from
 * each end in the lane heading inwards, `out` to each end in the lane
 * heading outwards. Index 0 is the west end, 1 the east.
 */
export function roadEnds(site: Site, width: number): Point[] {
  return [entryPoint(site, width, 0), entryPoint(site, width, 1)];
}

/** Coming on at an end: from the west heading east (north lane), or from the east heading west (south lane). */
export function entryPoint(site: Site, width: number, end: 0 | 1): Point {
  const { road } = site;
  return end === 0 ? { x: 0, y: road.y + 1 } : { x: width - 1, y: road.y + road.h - 2 };
}

/** Leaving at an end: west in the south lane, east in the north lane. */
export function exitPoint(site: Site, width: number, end: 0 | 1): Point {
  const { road } = site;
  return end === 0 ? { x: 0, y: road.y + road.h - 2 } : { x: width - 1, y: road.y + 1 };
}
