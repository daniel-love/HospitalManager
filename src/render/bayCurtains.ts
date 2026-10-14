/**
 * Privacy curtains drawn across a bay's open side. A cubicle with one bed or
 * couch, open to the corridor or department (its other sides walls or
 * curtain dividers), is screened by pulling its curtain across the opening,
 * as in a real Minors or Majors cubicle: so that's where it's drawn, with the
 * whole bay faintly shaded. A bed in an enclosed room, or one of several in a
 * shared bay or ward, has its curtain drawn round the bed instead
 * (drawBedCurtains in deathMarks.ts).
 */
import type { Graphics } from "pixi.js";
import type { PlacedObject, SimState } from "@sim/state";
import { isCouch } from "@sim/places";
import { isWallOrDoor, tileIndex } from "@sim/world/grid";
import { roomOfObject } from "@sim/world/rooms";
import { TILE_SIZE } from "./constants";
import { CURTAIN_COLOUR } from "./palette";

/** One tile edge of a bay that's open: the tile inside, and the way out. */
export interface Opening {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface BayScreen {
  /** The bay's tiles, as indices into a grid this wide. */
  tiles: number[];
  width: number;
  openings: Opening[];
}

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * The bay a bed's curtain closes off, or null if it's drawn round the bed:
 * the room holds other beds or couches, or it has no open side.
 */
export function bayScreen(state: SimState, bed: PlacedObject): BayScreen | null {
  const room = roomOfObject(state, bed.id);
  if (!room) return null;
  const couches = room.objectIds.filter((id) => {
    const o = state.objects[id];
    return o !== undefined && isCouch(o.defId);
  });
  if (couches.length !== 1) return null;
  const grid = state.floors[room.floor]!;
  const openings: Opening[] = [];
  for (const i of room.tiles) {
    const x = i % grid.width;
    const y = Math.floor(i / grid.width);
    for (const [dx, dy] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const n = tileIndex(grid, nx, ny);
      if (grid.roomId[n] === room.id || isWallOrDoor(grid, n)) continue;
      openings.push({ x, y, dx, dy });
    }
  }
  return openings.length > 0 ? { tiles: room.tiles, width: grid.width, openings } : null;
}

/** A bay screened off: faint shade over it, and a pleated curtain across each opening. */
export function drawBayScreen(g: Graphics, screen: BayScreen): void {
  const T = TILE_SIZE;
  const { width } = screen;
  for (const i of screen.tiles) {
    g.rect((i % width) * T, Math.floor(i / width) * T, T, T).fill({
      color: CURTAIN_COLOUR,
      alpha: 0.14,
    });
  }
  // Hung just inside the edge, pleats offset like a curtain divider's.
  const pleat = 6;
  const inset = 3;
  for (const { x, y, dx, dy } of screen.openings) {
    const px = x * T;
    const py = y * T;
    if (dy !== 0) {
      const cy = dy > 0 ? py + T - inset : py + inset;
      for (let k = 0; k < T; k += pleat) {
        g.rect(px + k, cy - 2 + ((k / pleat) % 2), pleat - 1, 4).fill(CURTAIN_COLOUR);
      }
    } else {
      const cx = dx > 0 ? px + T - inset : px + inset;
      for (let k = 0; k < T; k += pleat) {
        g.rect(cx - 2 + ((k / pleat) % 2), py + k, 4, pleat - 1).fill(CURTAIN_COLOUR);
      }
    }
  }
}
