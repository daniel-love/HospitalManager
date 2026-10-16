/**
 * Connected areas a patient may walk, labelled once per floor and layout,
 * so a route search that could only fail because of their access rules
 * (world/access.ts) can be ruled out up front. walkRegions.ts does the same
 * for walking in general; on a big site the walk regions often connect
 * while the public routes don't (the only way through is a clinical room),
 * and then findPath explores the whole floor before failing.
 *
 * OPEN tiles are labelled together; a room that isn't a public route is
 * labelled on its own (each connected part of it), with the labels it
 * touches. A patient may cross only the rooms they start or end in, so
 * whether they can get from A to B is a walk over a handful of labels.
 *
 * As with walk regions, diagonal steps never cut a corner, so tiles joined
 * by a route are joined 4-connected. The answer is exact for findPath on
 * foot, before its door and diagonal rules (which only ever rule out
 * more): it never says no when findPath would find a way.
 */
import type { Point } from "../agents";
import type { SimState } from "../state";
import { crewAccess, OPEN, patientAccess, PRIVATE } from "./access";
import { tileIndex, type FloorGrid } from "./grid";
import { isWalkable } from "./pathfinding";

interface FloorLabels {
  /** Tile → label (0: never on a patient's route). */
  label: Int32Array;
  /** Each label's room id: 0 for public routes, else the room it's part of. */
  room: number[];
  /** For each room's label, the labels next to it. */
  next: number[][];
  /** Room id → its labels. */
  byRoom: Map<number, number[]>;
}

type Rules = "patient" | "crew";
interface Cache {
  version: number;
  floors: Record<Rules, FloorLabels[]>;
}
const cache = new WeakMap<SimState, Cache>();

function labelsFor(state: SimState, rules: Rules, floor: number): FloorLabels {
  let entry = cache.get(state);
  if (!entry || entry.version !== state.layoutVersion) {
    entry = { version: state.layoutVersion, floors: { patient: [], crew: [] } };
    cache.set(state, entry);
  }
  const known = entry.floors[rules][floor];
  if (known) return known;
  const access = rules === "crew" ? crewAccess(state, floor) : patientAccess(state, floor);
  const labels = labelFloor(state.floors[floor]!, access);
  entry.floors[rules][floor] = labels;
  return labels;
}

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function labelFloor(grid: FloorGrid, access: Uint8Array): FloorLabels {
  const { width, height } = grid;
  const label = new Int32Array(width * height);
  // The room a tile counts as (0: public route), or -1 if never on a route.
  const roomOf = (i: number): number => {
    if (!isWalkable(grid, i)) return -1;
    const a = access[i]!;
    if (a === OPEN) return 0;
    // A room tile with no room is in nobody's own room.
    if (a === PRIVATE && grid.roomId[i] !== 0) return grid.roomId[i]!;
    return -1;
  };
  const room = [0];
  const stack: number[] = [];
  for (let start = 0; start < label.length; start++) {
    if (label[start] !== 0) continue;
    const r = roomOf(start);
    if (r === -1) continue;
    const l = room.length;
    room.push(r);
    label[start] = l;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of STEPS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = tileIndex(grid, nx, ny);
        if (label[n] !== 0 || roomOf(n) !== r) continue;
        label[n] = l;
        stack.push(n);
      }
    }
  }
  const next: number[][] = room.map(() => []);
  const byRoom = new Map<number, number[]>();
  for (let l = 1; l < room.length; l++) {
    const r = room[l]!;
    if (r !== 0) byRoom.set(r, [...(byRoom.get(r) ?? []), l]);
  }
  // Labels meet only where a room does (two public areas next to each other are one).
  for (let i = 0; i < label.length; i++) {
    const l = label[i]!;
    if (l === 0) continue;
    const x = i % width;
    if (x + 1 < width) meet(next, room, l, label[i + 1]!);
    if (i + width < label.length) meet(next, room, l, label[i + width]!);
  }
  return { label, room, next, byRoom };
}

function meet(next: number[][], room: number[], a: number, b: number): void {
  if (b === 0 || a === b) return;
  if (room[a] !== 0 && !next[a]!.includes(b)) next[a]!.push(b);
  if (room[b] !== 0 && !next[b]!.includes(a)) next[b]!.push(a);
}

/**
 * Whether a route on one floor from `from` to `to` may exist for a patient
 * on foot, or (`crew`) one the ambulance crew are bringing in, as findPath
 * searches it with that access. `bed`: they're on a trolley, which they can
 * roll along first (see findPath). False only if findPath would fail.
 */
export function accessRouteExists(
  state: SimState,
  floor: number,
  from: Point,
  to: Point,
  rules: Rules = "patient",
  bed = false,
): boolean {
  const grid = state.floors[floor];
  if (!grid) return true;
  const { width, height } = grid;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(from.x, from.y) || !inside(to.x, to.y)) return true;
  const start = tileIndex(grid, from.x, from.y);
  const goal = tileIndex(grid, to.x, to.y);
  if (start === goal) return true;
  const { label, room, next, byRoom } = labelsFor(state, rules, floor);
  const target = label[goal]!;
  if (target === 0) return false;
  const own = [grid.roomId[start]!, grid.roomId[goal]!].filter((r) => r !== 0);
  const allowed = (l: number) => room[l] === 0 || own.includes(room[l]!);
  if (!allowed(target)) return false;

  // Where the search can step first: off the start tile (walkable or not),
  // or off the trolley it starts on.
  const seen = new Set<number>();
  const queue: number[] = [];
  const reach = (i: number) => {
    const l = label[i]!;
    if (l !== 0 && allowed(l) && !seen.has(l)) {
      seen.add(l);
      queue.push(l);
    }
  };
  const object = bed ? grid.objectId[start]! : -1;
  const firsts = [start];
  const onTrolley = new Set(firsts);
  for (let k = 0; k < firsts.length; k++) {
    const i = firsts[k]!;
    reach(i);
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of STEPS) {
      if (!inside(x + dx, y + dy)) continue;
      const n = tileIndex(grid, x + dx, y + dy);
      reach(n);
      if (object !== -1 && grid.objectId[n] === object && !onTrolley.has(n)) {
        onTrolley.add(n);
        firsts.push(n);
      }
    }
  }

  // Public areas join up only through the rooms they may cross.
  const rooms = own.flatMap((r) => byRoom.get(r) ?? []);
  while (queue.length > 0) {
    const l = queue.pop()!;
    if (l === target) return true;
    if (room[l] !== 0) {
      for (const n of next[l]!) {
        if (!seen.has(n) && allowed(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    } else {
      for (const r of rooms) {
        if (!seen.has(r) && next[r]!.includes(l)) {
          seen.add(r);
          queue.push(r);
        }
      }
    }
  }
  return false;
}
