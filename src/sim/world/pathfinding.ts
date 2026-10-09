/**
 * Route finding on one floor (ARCHITECTURE §5.3): A* over the 8-connected
 * tile grid.
 *
 * Walkable tiles are floor or grass with no wall and no floor-standing item;
 * doors are walkable but slower, and must be walked straight through (no
 * diagonal steps into or out of a doorway). Diagonal steps can't cut the
 * corner of a wall or item.
 *
 * Bed mode (a patient being wheeled on a bed or trolley) also needs
 * bed-width doors and room to manoeuvre: every tile on the route must be part
 * of a clear 2×2 square, which rules out 1-tile corridors and single doors.
 *
 * Search buffers are reused between calls, and stamped with a generation
 * number so they never need clearing.
 */
import { doorByCode } from "@data/catalogue";
import { tileIndex, type FloorGrid } from "./grid";

/** Extra cost of stepping onto a door tile (opening it, waiting for others). */
const DOOR_COST = 0.6;
const SQRT2 = Math.SQRT2;

export function isWalkable(grid: FloorGrid, i: number): boolean {
  if (grid.wall[i] !== 0) return false;
  return grid.door[i] !== 0 || grid.objectId[i] === -1;
}

/** Whether a bed fits on this tile: no narrow door, and a clear 2×2 square around it. */
export function isBedPassable(grid: FloorGrid, i: number): boolean {
  if (!isWalkable(grid, i)) return false;
  const door = grid.door[i]!;
  if (door !== 0 && !doorByCode.get(door)?.bedAccess) return false;
  const { width, height } = grid;
  const x = i % width;
  const y = (i - x) / width;
  for (const [ox, oy] of [
    [0, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
  ] as const) {
    const x0 = x + ox;
    const y0 = y + oy;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
    const j = tileIndex(grid, x0, y0);
    if (
      isWalkable(grid, j) &&
      isWalkable(grid, j + 1) &&
      isWalkable(grid, j + width) &&
      isWalkable(grid, j + width + 1)
    ) {
      return true;
    }
  }
  return false;
}

interface Buffers {
  size: number;
  generation: number;
  seen: Uint32Array;
  closed: Uint32Array;
  g: Float64Array;
  from: Int32Array;
  heap: Int32Array;
  heapF: Float64Array;
}

let buffers: Buffers | null = null;

function getBuffers(size: number): Buffers {
  if (!buffers || buffers.size !== size) {
    buffers = {
      size,
      generation: 0,
      seen: new Uint32Array(size),
      closed: new Uint32Array(size),
      g: new Float64Array(size),
      from: new Int32Array(size),
      heap: new Int32Array(size * 8 + 8),
      heapF: new Float64Array(size * 8 + 8),
    };
  }
  buffers.generation++;
  if (buffers.generation === 0xffffffff) {
    buffers.seen.fill(0);
    buffers.closed.fill(0);
    buffers.generation = 1;
  }
  return buffers;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/**
 * Shortest route from (sx, sy) to (gx, gy) as tile indices, excluding the
 * start and including the goal. The start tile may be unwalkable (someone
 * getting up off a couch); the goal must be walkable. Null if unreachable.
 * `bed`: route for a bed (see isBedPassable); the goal itself need only be
 * walkable, as it's the last step beside the destination bed.
 */
export function findPath(
  grid: FloorGrid,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  bed = false,
): number[] | null {
  const { width, height } = grid;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(sx, sy) || !inside(gx, gy)) return null;
  const start = tileIndex(grid, sx, sy);
  const goal = tileIndex(grid, gx, gy);
  if (start === goal) return [];
  if (!isWalkable(grid, goal)) return null;

  const b = getBuffers(width * height);
  const gen = b.generation;
  let heapSize = 0;
  const push = (node: number, f: number) => {
    let i = heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (b.heapF[parent]! <= f) break;
      b.heap[i] = b.heap[parent]!;
      b.heapF[i] = b.heapF[parent]!;
      i = parent;
    }
    b.heap[i] = node;
    b.heapF[i] = f;
  };
  const pop = (): number => {
    const top = b.heap[0]!;
    const node = b.heap[--heapSize]!;
    const f = b.heapF[heapSize]!;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= heapSize) break;
      if (child + 1 < heapSize && b.heapF[child + 1]! < b.heapF[child]!) child++;
      if (b.heapF[child]! >= f) break;
      b.heap[i] = b.heap[child]!;
      b.heapF[i] = b.heapF[child]!;
      i = child;
    }
    b.heap[i] = node;
    b.heapF[i] = f;
    return top;
  };
  // Octile distance: exact on an open 8-connected grid.
  const h = (i: number) => {
    const x = i % width;
    const dx = Math.abs(x - gx);
    const dy = Math.abs((i - x) / width - gy);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };

  b.seen[start] = gen;
  b.g[start] = 0;
  b.from[start] = -1;
  push(start, h(start));

  while (heapSize > 0) {
    const cur = pop();
    if (b.closed[cur] === gen) continue;
    if (cur === goal) return unwind(b, goal);
    b.closed[cur] = gen;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const curIsDoor = grid.door[cur] !== 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inside(nx, ny)) continue;
      const n = tileIndex(grid, nx, ny);
      if (b.closed[n] === gen || !isWalkable(grid, n)) continue;
      if (bed && n !== goal && !isBedPassable(grid, n)) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal) {
        if (curIsDoor || grid.door[n] !== 0) continue;
        if (!isWalkable(grid, tileIndex(grid, cx + dx, cy))) continue;
        if (!isWalkable(grid, tileIndex(grid, cx, cy + dy))) continue;
      }
      const step = (diagonal ? SQRT2 : 1) + (grid.door[n] !== 0 ? DOOR_COST : 0);
      const g = b.g[cur]! + step;
      if (b.seen[n] === gen && g >= b.g[n]!) continue;
      b.seen[n] = gen;
      b.g[n] = g;
      b.from[n] = cur;
      push(n, g + h(n));
    }
  }
  return null;
}

function unwind(b: Buffers, goal: number): number[] {
  const out: number[] = [];
  for (let i = goal; b.from[i] !== -1; i = b.from[i]!) out.push(i);
  return out.reverse();
}

/**
 * The nearest tile on the map's edge reachable on foot from (x, y), by
 * breadth-first search. That's where people arrive from and leave to.
 */
export function nearestEdgeTile(
  grid: FloorGrid,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const { width, height } = grid;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const b = getBuffers(width * height);
  const gen = b.generation;
  const start = tileIndex(grid, x, y);
  // b.heap doubles as the BFS queue.
  let head = 0;
  let tail = 0;
  b.heap[tail++] = start;
  b.seen[start] = gen;
  while (head < tail) {
    const cur = b.heap[head++]!;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) {
      if (isWalkable(grid, cur)) return { x: cx, y: cy };
    }
    for (const [dx, dy] of DIRS.slice(0, 4)) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = tileIndex(grid, nx, ny);
      if (b.seen[n] === gen || !isWalkable(grid, n)) continue;
      b.seen[n] = gen;
      b.heap[tail++] = n;
    }
  }
  return null;
}
