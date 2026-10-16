/**
 * Upper floors (ROADMAP M7 step 2). A tile on an upper floor needs built
 * floor directly beneath it on every storey below, as a building's frame
 * stacks on its footprint. The exception is a link bridge: a first-floor
 * corridor spanning up to BRIDGE_MAX_SPAN tiles of open ground (an access
 * road, a path or grass between two buildings, on the hospital's own land)
 * in a straight line, with supported floor at both ends. Traffic passes
 * underneath.
 */
import { BRIDGE_MAX_SPAN } from "@data/structures";
import type { SimState } from "../state";
import { createUpperFloor, FloorType, inBounds, isPublic, tileIndex, type FloorGrid } from "./grid";

/** Whether every storey below a tile has floor built there (always, on the ground floor). */
export function supported(state: SimState, floor: number, x: number, y: number): boolean {
  for (let f = 0; f < floor; f++) {
    const g = state.floors[f];
    if (!g || g.floorType[tileIndex(g, x, y)] !== FloorType.Floor) return false;
  }
  return true;
}

/** Ground-floor foundations at a tile: what a link bridge needs at each end. */
function groundFloorAt(state: SimState, x: number, y: number): boolean {
  const g = state.floors[0]!;
  return inBounds(g, x, y) && g.floorType[tileIndex(g, x, y)] === FloorType.Floor;
}

/**
 * Whether a first-floor tile with no floor beneath it can be part of a link
 * bridge: over the hospital's own land, in a gap of at most BRIDGE_MAX_SPAN
 * tiles, along a row or a column, with ground-floor building at both ends.
 */
export function bridgeable(state: SimState, floor: number, x: number, y: number): boolean {
  if (floor !== 1) return false;
  const ground = state.floors[0]!;
  if (!inBounds(ground, x, y) || isPublic(ground, tileIndex(ground, x, y))) return false;
  if (groundFloorAt(state, x, y)) return false;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
  ] as const) {
    // Unsupported tiles each way to the nearest building, if within the span.
    const run = (sx: number, sy: number): number | null => {
      for (let n = 1; n <= BRIDGE_MAX_SPAN; n++) {
        const tx = x + sx * n;
        const ty = y + sy * n;
        if (!inBounds(ground, tx, ty) || isPublic(ground, tileIndex(ground, tx, ty))) return null;
        if (groundFloorAt(state, tx, ty)) return n - 1;
      }
      return null;
    };
    const a = run(dx, dy);
    const b = run(-dx, -dy);
    if (a !== null && b !== null && a + b + 1 <= BRIDGE_MAX_SPAN) return true;
  }
  return false;
}

/** Whether a tile on this floor can have floor built: supported, or part of a link bridge. */
export function canHoldFloor(state: SimState, floor: number, x: number, y: number): boolean {
  return supported(state, floor, x, y) || bridgeable(state, floor, x, y);
}

/** A built first-floor tile with nothing beneath: part of a link bridge. */
export function isBridge(state: SimState, floor: number, x: number, y: number): boolean {
  return floor > 0 && !supported(state, floor, x, y);
}

/** Whether the floor above has anything built over this tile. */
export function builtAbove(state: SimState, floor: number, x: number, y: number): boolean {
  const g = state.floors[floor + 1];
  return !!g && g.floorType[tileIndex(g, x, y)] !== FloorType.Void;
}

/** Error for building upstairs with nothing to hold it up. */
export const NO_SUPPORT = `Needs floor beneath it (or a first-floor link bridge of up to ${BRIDGE_MAX_SPAN} tiles between buildings)`;
/** Error for taking away floor that holds up the storey above. */
export const HOLDS_UP_FLOOR_ABOVE = "Remove what's built on the floor above first";
/** Error for zoning a room on a link bridge. */
export const BRIDGE_CORRIDOR_ONLY = "A link bridge can only be a corridor";

const blanks = new WeakMap<SimState, FloorGrid>();

/**
 * A floor's grid, or (for the storey above the top one, before anything's
 * built there) a blank one of open air, for build tools to work against.
 */
export function gridOrBlank(state: SimState, floor: number): FloorGrid {
  const grid = state.floors[floor];
  if (grid) return grid;
  const g0 = state.floors[0]!;
  let blank = blanks.get(state);
  if (!blank || blank.width !== g0.width || blank.height !== g0.height) {
    blank = createUpperFloor(g0.width, g0.height);
    blanks.set(state, blank);
  }
  return blank;
}
