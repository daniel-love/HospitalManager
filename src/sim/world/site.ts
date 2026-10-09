/**
 * The hospital's surroundings (GAME_DESIGN §4.1): a council road with a
 * pavement each side, running right across the map a little south of the
 * middle, and a bus stop on the hospital-side pavement. The council owns them,
 * so they cost nothing and can't be built on. People and ambulances arrive
 * along them, and the player links the hospital to them with footpaths and an
 * access road.
 */
import type { Point } from "../agents";
import { FloorType, Land, tileIndex, type FloorGrid } from "./grid";
import type { Rect } from "./rect";

/** A two-lane road: two 3 m lanes. */
export const ROAD_WIDTH = 6;
/** Each pavement: 2 m. */
export const PAVEMENT_WIDTH = 2;
/** Pavement, road, pavement. */
export const SITE_BAND = ROAD_WIDTH + 2 * PAVEMENT_WIDTH;
/** Where the band starts, as a fraction of the map's height. */
const BAND_POSITION = 0.6;
/** Where the bus stop stands, as a fraction of the map's width. */
const BUS_STOP_POSITION = 0.4;

export interface Site {
  /** The carriageway. */
  road: Rect;
  /** North (hospital side) then south pavement. */
  pavements: [Rect, Rect];
  /** On the outer edge of the north pavement, where bus passengers get off. */
  busStop: Point;
}

/**
 * Paints the public road onto a fresh ground-floor grid and returns where it
 * is, or null if the map is too small to hold it.
 */
export function layOutSite(grid: FloorGrid): Site | null {
  const { width, height } = grid;
  if (height < SITE_BAND * 3 || width < SITE_BAND) return null;
  return paintSite(grid, Math.min(Math.round(height * BAND_POSITION), height - SITE_BAND));
}

/** Grass rows left between an existing building and a road fitted in below it. */
const FIT_GAP = 2;

/**
 * For a map built on before the road existed (an old save): lays the road
 * just south of everything built, and a free footpath from the southernmost
 * outside door down to the pavement, with the bus stop beside it. Null, with
 * nothing changed, if the map is too small or the road won't fit below the
 * building.
 */
export function fitSite(grid: FloorGrid): Site | null {
  const { width, height } = grid;
  if (height < SITE_BAND * 3 || width < SITE_BAND) return null;
  let lowest = -1;
  for (let i = 0; i < grid.floorType.length; i++) {
    const built = grid.floorType[i] !== FloorType.Grass || grid.wall[i] !== 0 || grid.door[i] !== 0;
    if (built) lowest = Math.max(lowest, Math.floor(i / width));
  }
  if (lowest < 0) return layOutSite(grid);
  const top = lowest + 1 + FIT_GAP;
  if (top + SITE_BAND > height) return null;
  const site = paintSite(grid, top);
  const door = southDoor(grid, top);
  if (door) {
    for (let y = door.y + 1; y < top; y++) {
      for (const x of door.xs) grid.floorType[tileIndex(grid, x, y)] = FloorType.Path;
    }
    site.busStop = { x: Math.min(width - 1, door.xs[door.xs.length - 1]! + 3), y: top };
  }
  return site;
}

/**
 * The southernmost door opening onto grass to its south with a clear run of
 * grass down to row `top` (a double door's tiles together), or null.
 */
function southDoor(grid: FloorGrid, top: number): { y: number; xs: number[] } | null {
  const { width } = grid;
  const clearBelow = (x: number, y: number) => {
    for (let ty = y + 1; ty < top; ty++) {
      if (grid.floorType[tileIndex(grid, x, ty)] !== FloorType.Grass) return false;
    }
    return true;
  };
  for (let y = top - 2; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      if (grid.door[tileIndex(grid, x, y)] === 0 || !clearBelow(x, y)) continue;
      const xs = [x];
      while (
        xs.length < 2 &&
        x + xs.length < width &&
        grid.door[tileIndex(grid, x + xs.length, y)] !== 0 &&
        clearBelow(x + xs.length, y)
      ) {
        xs.push(x + xs.length);
      }
      return { y, xs };
    }
  }
  return null;
}

function paintSite(grid: FloorGrid, top: number): Site {
  const { width } = grid;
  const north: Rect = { x: 0, y: top, w: width, h: PAVEMENT_WIDTH };
  const road: Rect = { x: 0, y: top + PAVEMENT_WIDTH, w: width, h: ROAD_WIDTH };
  const south: Rect = { x: 0, y: road.y + ROAD_WIDTH, w: width, h: PAVEMENT_WIDTH };
  paint(grid, north, FloorType.Path);
  paint(grid, road, FloorType.Road);
  paint(grid, south, FloorType.Path);
  return {
    road,
    pavements: [north, south],
    busStop: { x: Math.round(width * BUS_STOP_POSITION), y: top },
  };
}

/** Where to point the camera at the start: the land just north of the bus stop. */
export function siteView(site: Site): Point {
  return { x: site.busStop.x, y: site.busStop.y - 4 };
}

function paint(grid: FloorGrid, r: Rect, type: FloorType): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = tileIndex(grid, x, y);
      grid.floorType[i] = type;
      grid.land[i] = Land.Public;
    }
  }
}
