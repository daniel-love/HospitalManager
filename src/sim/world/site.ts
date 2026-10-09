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
  const top = Math.min(Math.round(height * BAND_POSITION), height - SITE_BAND);
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
