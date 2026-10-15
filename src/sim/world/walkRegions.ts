/**
 * Connected areas people can walk around on the ground floor, labelled once
 * per layout. A route search that can't reach its goal explores every tile
 * it can before giving up, which on a big site takes tens of milliseconds;
 * comparing labels says up front whether there's any way there at all.
 *
 * Diagonal steps never cut a corner (world/pathfinding.ts), so tiles joined
 * by any walking route are joined by a 4-connected one: these regions are
 * exactly what findPath can reach, before patients' access rules.
 */
import type { Point } from "../agents";
import type { SimState } from "../state";
import { tileIndex } from "./grid";
import { isWalkable } from "./pathfinding";

interface WalkRegions {
  version: number;
  /** Walkable tile → connected region label (0 = not walkable). */
  label: Int32Array;
  /** Tiles in each region, by label. */
  size: number[];
}
const cache = new WeakMap<SimState, WalkRegions>();

function walkRegions(state: SimState): WalkRegions {
  const cached = cache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached;
  const grid = state.floors[0]!;
  const { width, height } = grid;
  const label = new Int32Array(width * height);
  const size = [0];
  const stack: number[] = [];
  for (let start = 0; start < label.length; start++) {
    if (label[start] !== 0 || !isWalkable(grid, start)) continue;
    const l = size.length;
    size.push(1);
    label[start] = l;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
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
        if (label[n] !== 0 || !isWalkable(grid, n)) continue;
        label[n] = l;
        size[l]!++;
        stack.push(n);
      }
    }
  }
  const regions = { version: state.layoutVersion, label, size };
  cache.set(state, regions);
  return regions;
}

/**
 * Regions a point's in: its own, or if it isn't walkable (someone getting up
 * off a couch) those of the tiles around it.
 */
function regionsAt(state: SimState, p: Point): Set<number> {
  const grid = state.floors[0]!;
  const { label } = walkRegions(state);
  const out = new Set<number>();
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return out;
  const own = label[tileIndex(grid, x, y)]!;
  if (own !== 0) return out.add(own);
  for (let ny = y - 1; ny <= y + 1; ny++) {
    for (let nx = x - 1; nx <= x + 1; nx++) {
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const l = label[tileIndex(grid, nx, ny)]!;
      if (l !== 0) out.add(l);
    }
  }
  return out;
}

/** Whether there's any walking route from `from` to `to` (ignoring patients' access rules). */
export function walkRouteExists(state: SimState, from: Point, to: Point): boolean {
  const a = regionsAt(state, from);
  for (const l of regionsAt(state, to)) if (a.has(l)) return true;
  return false;
}

/** How many tiles can be walked to from a walkable tile (0 if it isn't one). */
export function walkableArea(state: SimState, x: number, y: number): number {
  const grid = state.floors[0]!;
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 0;
  const { label, size } = walkRegions(state);
  return size[label[tileIndex(grid, x, y)]!]!;
}
