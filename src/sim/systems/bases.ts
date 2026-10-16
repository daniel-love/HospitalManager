/**
 * Where staff wait between jobs. In a real hospital nobody idles where their
 * last job ended, and the staff room is for breaks: each role has a base in
 * its own department. Doctors and nurse practitioners wait at the A&E Staff
 * Base, specialty doctors in the Doctors' Office (or on their ward when it's
 * full or unbuilt), radiographers in X-ray or CT, lab
 * scientists in the lab, porters in the Porters' Lodge and cleaners in the
 * Domestic Services Room. They sit behind a free desk or on a free seat if
 * there is one, otherwise stand. Nurses wait at a nurse station (systems/staffing.ts)
 * and use the Staff Base only when every station is taken. With no base
 * built, staff wait in the Staff Room; with no Staff Room either, they stay
 * where they are.
 */
import type { StaffRoleId } from "@data/schema";
import { onSite, type Point, type Staff } from "../agents";
import { equipmentById } from "@data/catalogue";
import { deskStaffSpot, seatApproach, seatTile } from "../places";
import type { Room, SimState } from "../state";
import { tileIndex, type FloorGrid } from "../world/grid";
import { isStandable } from "../world/objects";
import { isWalkable } from "../world/pathfinding";
import { headTo } from "./movement";

/** A kind of room a role can wait in. */
type BaseKind =
  /** `seatedOnly`: full once every desk and seat is taken; nobody stands. */
  | { type: string; seatedOnly?: true }
  /** A ward given to the member of staff's specialty. */
  | { type: "ward"; ownSpecialty: true }
  /** A ward not given to any specialty. */
  | { type: "ward"; anySpecialty: true };

const STAFF_ROOM: BaseKind = { type: "staff_room" };
const STAFF_BASE: BaseKind = { type: "staff_base" };
const DOCTORS_OFFICE: BaseKind = { type: "doctors_office", seatedOnly: true };
const SPECIALTY_WARDS: BaseKind[] = [
  { type: "ward", ownSpecialty: true },
  { type: "ward", anySpecialty: true },
];

/** Where each role waits, best first. Receptionists have their desk instead. */
const BASES: Record<StaffRoleId, BaseKind[]> = {
  consultant: [DOCTORS_OFFICE, ...SPECIALTY_WARDS, STAFF_BASE, STAFF_ROOM],
  registrar: [DOCTORS_OFFICE, ...SPECIALTY_WARDS, STAFF_BASE, STAFF_ROOM],
  junior_doctor: [STAFF_BASE, STAFF_ROOM],
  nurse: [STAFF_BASE, STAFF_ROOM],
  nurse_practitioner: [STAFF_BASE, STAFF_ROOM],
  radiographer: [{ type: "xray_room" }, { type: "ct_room" }, STAFF_ROOM],
  biomedical_scientist: [{ type: "lab" }, STAFF_ROOM],
  porter: [{ type: "porters_lodge" }, STAFF_ROOM],
  cleaner: [{ type: "domestic_services_room" }, STAFF_ROOM],
  theatre_practitioner: [{ type: "recovery" }, { type: "theatre" }, STAFF_ROOM],
  receptionist: [],
  outpatient_receptionist: [],
  discharge_coordinator: [{ type: "ward", anySpecialty: true }, STAFF_BASE, STAFF_ROOM],
  clinical_engineer: [{ type: "plant_room" }, STAFF_ROOM],
};

/** Room types some role waits in, for anything that wants to name them. */
export const BASE_ROOM_TYPES = new Set(
  Object.values(BASES).flatMap((kinds) => kinds.map((k) => k.type)),
);

function fits(room: Room, kind: BaseKind, s: Staff): boolean {
  if (!room.valid || room.typeId !== kind.type) return false;
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
  const taken = takenSpots(state, s);
  goToBase(state, s, taken);
  taken.moved(s);
}

function goToBase(state: SimState, s: Staff, taken: TakenSpots): void {
  const floor = s.dest?.floor ?? s.floor;
  const grid = state.floors[floor]!;
  const current = s.dest ?? { x: Math.round(s.x), y: Math.round(s.y), floor };
  const currentRoom = state.rooms[grid.roomId[tileIndex(grid, current.x, current.y)]! - 1];

  for (const kind of BASES[s.role]) {
    const rooms = state.rooms.filter((r) => fits(r, kind, s));
    if (rooms.length === 0) continue;
    // Already there (or on the way), on a spot of their own: stay.
    const here = currentRoom && rooms.includes(currentRoom) ? currentRoom : undefined;
    const key = spotKey(grid, floor, current.x, current.y);
    const sitting =
      here !== undefined &&
      (isDeskSpot(state, here, current) ||
        seats(state, here).some((t) => t.seat.x === current.x && t.seat.y === current.y));
    const seatedOnly = "seatedOnly" in kind;
    const standing =
      !seatedOnly &&
      here !== undefined &&
      reachableTiles(state, here).has(tileIndex(grid, current.x, current.y));
    // Standing, they take a desk or seat once one comes free.
    const better = standing && !sitting ? freeSpot(state, [here!], s, taken) : null;
    if (here && !taken.has(key) && (sitting || standing) && !better?.seated) {
      const d = s.dest;
      if (d) headTo(state, s, d, { x: d.ax, y: d.ay });
      return;
    }
    const spot = better?.seated ? better : freeSpot(state, rooms, s, taken, seatedOnly);
    if (!spot) continue; // Full: try the next kind of base.
    headTo(state, s, spot.to, spot.approach);
    return;
  }
}

/** Tiles of walking a base on another floor counts as, when choosing the nearest. */
const FLOOR_AWAY = 40;

/** Tiles (keyed across floors: see spotKey) other staff are standing on or heading to. */
interface TakenSpots {
  has(tile: number): boolean;
  /** Notes where `s` is heading now, for the next to look this tick. */
  moved(s: Staff): void;
}

/**
 * Who's standing on (or heading to) each tile, counted once a tick and kept
 * up to date as staff pick their spots: counting everyone afresh for each
 * of them is slow with hundreds of staff.
 */
const spotCounts = new WeakMap<
  SimState,
  { tick: number; count: Map<number, number>; at: Map<number, number> }
>();

/** A tile's key across floors, for counting who's where. */
function spotKey(grid: FloorGrid, floor: number, x: number, y: number): number {
  return floor * grid.width * grid.height + tileIndex(grid, x, y);
}

function spotOf(state: SimState, o: Staff): number {
  const floor = o.dest?.floor ?? o.floor;
  const p = o.dest ?? { x: Math.round(o.x), y: Math.round(o.y), floor: o.floor };
  return spotKey(state.floors[floor]!, floor, p.x, p.y);
}

function takenSpots(state: SimState, self: Staff): TakenSpots {
  let c = spotCounts.get(state);
  if (c?.tick !== state.tick) {
    c = { tick: state.tick, count: new Map(), at: new Map() };
    for (const o of Object.values(state.staff)) {
      if (!onSite(o)) continue;
      const i = spotOf(state, o);
      c.at.set(o.id, i);
      c.count.set(i, (c.count.get(i) ?? 0) + 1);
    }
    spotCounts.set(state, c);
  }
  const { count, at } = c;
  const mine = at.get(self.id);
  return {
    has: (i) => (count.get(i) ?? 0) - (i === mine ? 1 : 0) > 0,
    moved: (s) => {
      const was = at.get(s.id);
      const now = spotOf(state, s);
      if (was === now) return;
      if (was !== undefined) count.set(was, count.get(was)! - 1);
      count.set(now, (count.get(now) ?? 0) + 1);
      at.set(s.id, now);
    },
  };
}

/** Where to wait, and the tile to walk to first (in front of a seat, say). */
interface Spot {
  to: Point;
  approach: Point;
  /** Behind a desk or on a seat. */
  seated: boolean;
}

function isDeskSpot(state: SimState, room: Room, p: Point): boolean {
  return room.objectIds.some((id) => {
    const obj = state.objects[id]!;
    if (obj.defId !== "desk") return false;
    const spot = deskStaffSpot(obj);
    return spot.x === p.x && spot.y === p.y;
  });
}

/** Every seat in a room that can be reached: the seat itself, and where to stand to sit down. */
function seats(state: SimState, room: Room): { seat: Point; approach: Point }[] {
  const grid = state.floors[room.floor]!;
  const open = reachableTiles(state, room);
  const out: { seat: Point; approach: Point }[] = [];
  for (const id of room.objectIds) {
    const obj = state.objects[id]!;
    const n = equipmentById.get(obj.defId)?.seats ?? 0;
    for (let slot = 0; slot < n; slot++) {
      const approach = seatApproach(obj, slot);
      if (!open.has(tileIndex(grid, approach.x, approach.y))) continue;
      out.push({ seat: seatTile(obj, slot), approach });
    }
  }
  return out;
}

/**
 * A free spot in the nearest of the rooms with one: behind a desk, then on
 * a seat, otherwise (unless `seatedOnly`) the free tile nearest the middle
 * of the room. Only spots
 * that can be walked to from the room's way in count.
 */
function freeSpot(
  state: SimState,
  rooms: Room[],
  s: Staff,
  taken: TakenSpots,
  seatedOnly = false,
): Spot | null {
  const centre = (r: Room) => ({ x: r.bounds.x + r.bounds.w / 2, y: r.bounds.y + r.bounds.h / 2 });
  const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  // A base on another floor is as good as one this far away on their own.
  const away = (r: Room) => dist(centre(r), s) + Math.abs(r.floor - s.floor) * FLOOR_AWAY;
  const byDistance = [...rooms].sort((a, b) => away(a) - away(b) || a.id - b.id);

  for (const room of byDistance) {
    const grid = state.floors[room.floor]!;
    const key = (p: Point) => spotKey(grid, room.floor, p.x, p.y);
    const open = reachableTiles(state, room);
    const free = (p: Point) => open.has(tileIndex(grid, p.x, p.y)) && !taken.has(key(p));
    for (const id of room.objectIds) {
      const obj = state.objects[id]!;
      if (obj.defId !== "desk") continue;
      const spot = deskStaffSpot(obj);
      if (free(spot)) return { to: spot, approach: spot, seated: true };
    }
    const c = centre(room);
    const seat = seats(state, room)
      .filter((t) => !taken.has(key(t.seat)))
      .sort((a, b) => dist(a.seat, c) - dist(b.seat, c))[0];
    if (seat) return { to: seat.seat, approach: seat.approach, seated: true };
    if (seatedOnly) continue;
    let best: Point | null = null;
    let bestD = Infinity;
    for (const i of open) {
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      const d = dist({ x: x + 0.5, y: y + 0.5 }, c);
      if (d < bestD && !taken.has(key({ x, y }))) {
        best = { x, y, floor: room.floor };
        bestD = d;
      }
    }
    if (best) return { to: best, approach: best, seated: false };
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
