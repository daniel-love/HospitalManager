/**
 * Where staff wait between jobs. In a real hospital nobody idles where their
 * last job ended, and the staff room is for breaks: each role has a base in
 * its own department. Doctors and nurse practitioners wait at the A&E Staff
 * Base, specialty doctors on their ward, radiographers in X-ray or CT, lab
 * scientists in the lab, porters in the Porters' Lodge and cleaners in the
 * Domestic Services Room. Nurses wait at a nurse station (systems/staffing.ts)
 * and use the Staff Base only when every station is taken. With no base
 * built, staff wait in the Staff Room; with no Staff Room either, they stay
 * where they are.
 */
import type { StaffRoleId } from "@data/schema";
import type { Point, Staff } from "../agents";
import { deskStaffSpot } from "../places";
import type { Room, SimState } from "../state";
import { tileIndex } from "../world/grid";
import { isStandable } from "../world/objects";
import { isWalkable } from "../world/pathfinding";
import { headTo } from "./movement";

/** A kind of room a role can wait in. */
type BaseKind =
  | { type: string }
  /** A ward given to the member of staff's specialty. */
  | { type: "ward"; ownSpecialty: true }
  /** A ward not given to any specialty. */
  | { type: "ward"; anySpecialty: true };

const STAFF_ROOM: BaseKind = { type: "staff_room" };
const STAFF_BASE: BaseKind = { type: "staff_base" };
const SPECIALTY_WARDS: BaseKind[] = [
  { type: "ward", ownSpecialty: true },
  { type: "ward", anySpecialty: true },
];

/** Where each role waits, best first. Receptionists have their desk instead. */
const BASES: Record<StaffRoleId, BaseKind[]> = {
  consultant: [...SPECIALTY_WARDS, STAFF_BASE, STAFF_ROOM],
  registrar: [...SPECIALTY_WARDS, STAFF_BASE, STAFF_ROOM],
  junior_doctor: [STAFF_BASE, STAFF_ROOM],
  nurse: [STAFF_BASE, STAFF_ROOM],
  nurse_practitioner: [STAFF_BASE, STAFF_ROOM],
  radiographer: [{ type: "xray_room" }, { type: "ct_room" }, STAFF_ROOM],
  biomedical_scientist: [{ type: "lab" }, STAFF_ROOM],
  porter: [{ type: "porters_lodge" }, STAFF_ROOM],
  cleaner: [{ type: "domestic_services_room" }, STAFF_ROOM],
  receptionist: [],
};

/** Room types some role waits in, for anything that wants to name them. */
export const BASE_ROOM_TYPES = new Set(
  Object.values(BASES).flatMap((kinds) => kinds.map((k) => k.type)),
);

function fits(room: Room, kind: BaseKind, s: Staff): boolean {
  if (!room.valid || room.typeId !== kind.type || room.floor !== 0) return false;
  if ("ownSpecialty" in kind) return s.specialty !== null && room.specialty === s.specialty;
  if ("anySpecialty" in kind) return room.specialty === null;
  return true;
}

/**
 * Sends an idle member of staff to their base, or keeps them there. Call
 * every tick for staff with no job; it only looks for a spot now and then.
 */
export function waitAtBase(state: SimState, s: Staff): void {
  if (s.jobId !== null) return;
  // Staggered: finding a spot isn't urgent.
  if ((state.tick + s.id) % 10 !== 0) return;
  const grid = state.floors[0]!;
  const taken = takenSpots(state, s);
  const current = s.dest ?? { x: Math.round(s.x), y: Math.round(s.y) };
  const currentRoom = state.rooms[grid.roomId[tileIndex(grid, current.x, current.y)]! - 1];

  for (const kind of BASES[s.role]) {
    const rooms = state.rooms.filter((r) => fits(r, kind, s));
    if (rooms.length === 0) continue;
    // Already there (or on the way), on a spot of their own: stay.
    const here = currentRoom && rooms.includes(currentRoom) ? currentRoom : undefined;
    const key = tileIndex(grid, current.x, current.y);
    if (here && !taken.has(key) && reachableTiles(state, here).has(key)) {
      if (s.dest) headTo(state, s, s.dest);
      return;
    }
    const spot = freeSpot(state, rooms, s, taken);
    if (!spot) continue; // Full: try the next kind of base.
    headTo(state, s, spot);
    return;
  }
}

/** Tiles other staff are standing on or heading to. */
function takenSpots(state: SimState, self: Staff): Set<number> {
  const grid = state.floors[0]!;
  const out = new Set<number>();
  for (const o of Object.values(state.staff)) {
    if (o.id === self.id) continue;
    const p = o.dest ?? { x: Math.round(o.x), y: Math.round(o.y) };
    out.add(tileIndex(grid, p.x, p.y));
  }
  return out;
}

/**
 * A free spot in the nearest of the rooms with one: behind a desk if one is
 * free, otherwise the free tile nearest the middle of the room. Only tiles
 * that can be walked to from the room's way in count.
 */
function freeSpot(state: SimState, rooms: Room[], s: Staff, taken: Set<number>): Point | null {
  const grid = state.floors[0]!;
  const centre = (r: Room) => ({ x: r.bounds.x + r.bounds.w / 2, y: r.bounds.y + r.bounds.h / 2 });
  const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const byDistance = [...rooms].sort(
    (a, b) => dist(centre(a), s) - dist(centre(b), s) || a.id - b.id,
  );

  for (const room of byDistance) {
    const open = reachableTiles(state, room);
    const free = (p: Point) => {
      const i = tileIndex(grid, p.x, p.y);
      return open.has(i) && !taken.has(i);
    };
    for (const id of room.objectIds) {
      const obj = state.objects[id]!;
      if (obj.defId !== "desk") continue;
      const spot = deskStaffSpot(obj);
      if (free(spot)) return spot;
    }
    const c = centre(room);
    let best: Point | null = null;
    let bestD = Infinity;
    for (const i of open) {
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      const d = dist({ x: x + 0.5, y: y + 0.5 }, c);
      if (d < bestD && !taken.has(i)) {
        best = { x, y };
        bestD = d;
      }
    }
    if (best) return best;
  }
  return null;
}

const reachableCache = new WeakMap<
  SimState,
  { version: number; byRoom: Map<number, Set<number>> }
>();

/**
 * A room's standable tiles that can be walked to from outside it: through a
 * door, or straight in for an open room. Cached per layout.
 */
function reachableTiles(state: SimState, room: Room): Set<number> {
  let cache = reachableCache.get(state);
  if (!cache || cache.version !== state.layoutVersion) {
    cache = { version: state.layoutVersion, byRoom: new Map() };
    reachableCache.set(state, cache);
  }
  const cached = cache.byRoom.get(room.id);
  if (cached) return cached;

  const grid = state.floors[room.floor]!;
  const { width, height } = grid;
  const inRoom = (i: number) => grid.roomId[i] === room.id;
  const standable = (i: number) => isStandable(grid, i % width, Math.floor(i / width));
  const neighbours = (i: number): number[] => {
    const x = i % width;
    const y = (i - x) / width;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < width - 1) out.push(i + 1);
    if (y > 0) out.push(i - width);
    if (y < height - 1) out.push(i + width);
    return out;
  };
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const i of room.tiles) {
    if (!standable(i)) continue;
    if (neighbours(i).some((n) => !inRoom(n) && isWalkable(grid, n))) {
      seen.add(i);
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const n of neighbours(queue[head]!)) {
      if (seen.has(n) || !inRoom(n) || !standable(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  cache.byRoom.set(room.id, seen);
  return seen;
}
