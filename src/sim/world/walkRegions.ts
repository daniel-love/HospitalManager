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
import { tileIndex, type FloorGrid } from "./grid";
import { isWalkable } from "./pathfinding";
import { portals, portalStop, type Portal } from "./portals";

interface WalkRegions {
  version: number;
  /**
   * Walkable tile → connected region label (0 = not walkable), one array per
   * floor. Labels are unique across floors.
   */
  label: Int32Array[];
  /** Tiles in each region, by label. */
  size: number[];
  /** Each label's representative, once regions joined by stairs and lifts are merged. */
  root: Int32Array;
}
const cache = new WeakMap<SimState, WalkRegions>();

function walkRegions(state: SimState): WalkRegions {
  const cached = cache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached;
  const size = [0];
  const labels = state.floors.map((grid) => labelFloor(grid, size));
  const root = joinFloors(state, labels, size.length, () => true);
  const regions = { version: state.layoutVersion, label: labels, size, root };
  cache.set(state, regions);
  return regions;
}

/** Labels one floor's connected walkable areas, numbering on from `size`. */
function labelFloor(grid: FloorGrid, size: number[]): Int32Array {
  const { width, height } = grid;
  const label = new Int32Array(width * height);
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
  return label;
}

/**
 * Regions a point's in (on its floor, the ground floor if it doesn't say):
 * its own, or if it isn't walkable (someone getting up off a couch) those of
 * the tiles around it.
 */
function regionsAt(state: SimState, p: Point): Set<number> {
  const floor = p.floor ?? 0;
  const grid = state.floors[floor];
  const out = new Set<number>();
  if (!grid) return out;
  const label = walkRegions(state).label[floor]!;
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return out;
  const { root } = walkRegions(state);
  const own = label[tileIndex(grid, x, y)]!;
  if (own !== 0) return out.add(root[own]!);
  for (let ny = y - 1; ny <= y + 1; ny++) {
    for (let nx = x - 1; nx <= x + 1; nx++) {
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const l = label[tileIndex(grid, nx, ny)]!;
      if (l !== 0) out.add(root[l]!);
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
export function walkableArea(state: SimState, x: number, y: number, floor = 0): number {
  const grid = state.floors[floor];
  if (!grid || x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 0;
  const { label, size } = walkRegions(state);
  return size[label[floor]![tileIndex(grid, x, y)]!]!;
}

/**
 * Merges regions on different floors that a portal joins (stairs and lifts
 * for walking; `use` picks which), so a route search can be ruled out across
 * floors too. Returns each label's representative.
 */
export function joinFloors(
  state: SimState,
  labels: Int32Array[],
  count: number,
  use: (p: Portal) => boolean,
): Int32Array {
  const root = new Int32Array(count);
  for (let i = 0; i < count; i++) root[i] = i;
  const find = (a: number): number => {
    while (root[a] !== a) {
      root[a] = root[root[a]!]!;
      a = root[a]!;
    }
    return a;
  };
  const labelAt = (floor: number, p: Point): number => {
    const grid = state.floors[floor]!;
    if (p.x < 0 || p.y < 0 || p.x >= grid.width || p.y >= grid.height) return 0;
    return labels[floor]![tileIndex(grid, p.x, p.y)]!;
  };
  for (const portal of portals(state)) {
    if (!use(portal)) continue;
    for (let k = 1; k < portal.floors.length; k++) {
      const a = labelAt(portal.floors[k - 1]!, portalStop(portal, portal.floors[k - 1]!));
      const b = labelAt(portal.floors[k]!, portalStop(portal, portal.floors[k]!));
      if (a === 0 || b === 0) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) root[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
  for (let i = 0; i < count; i++) root[i] = find(i);
  return root;
}
