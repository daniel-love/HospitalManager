/**
 * Where agents go: seats in waiting areas, couches in triage rooms and
 * cubicles, toilets and reception desks, plus the site entrance. Only
 * equipment in valid rooms counts (GAME_DESIGN §4.2: only valid rooms
 * function).
 *
 * Reservations ("objectId:slot" → agent id) stop two agents claiming the
 * same seat or couch. They refer to object ids, which (unlike room ids)
 * survive rebuilding.
 */
import { content, equipmentById, equipmentNamesFor, roomById } from "@data/catalogue";
import { TOILET_USES_BEFORE_CLEAN } from "@data/patients";
import type { Point } from "./agents";
import type { PlacedObject, Room, SimState } from "./state";
import { OPEN, patientAccess } from "./world/access";
import { tileIndex } from "./world/grid";
import { isWalkable } from "./world/pathfinding";
import { frontDirection, isStandable, objectRect, sideTiles } from "./world/objects";
import { nearestEdgeTile, nearestTile } from "./world/pathfinding";
import { rectTiles } from "./world/rect";
import { roomOfObject } from "./world/rooms";

export type Slot = number | "staff";

export const slotKey = (objectId: number, slot: Slot) => `${objectId}:${slot}`;

export function holder(state: SimState, objectId: number, slot: Slot): number | undefined {
  return state.reserved[slotKey(objectId, slot)];
}

export function reserve(state: SimState, objectId: number, slot: Slot, agentId: number): void {
  state.reserved[slotKey(objectId, slot)] = agentId;
}

/** Releases a reservation, but only if `agentId` holds it. */
export function release(state: SimState, objectId: number, slot: Slot, agentId: number): void {
  const key = slotKey(objectId, slot);
  if (state.reserved[key] === agentId) delete state.reserved[key];
}

/** Whether an object still exists in a valid room of the given type. */
export function inValidRoom(state: SimState, objectId: number, roomType?: string): boolean {
  if (!state.objects[objectId]) return false;
  const room = roomOfObject(state, objectId);
  return !!room && room.valid && (roomType === undefined || room.typeId === roomType);
}

/** Objects of these equipment ids in valid rooms of a type, in id order. */
/** Whether some valid room of this type has all these capabilities. */
export function hasRoomWith(
  state: SimState,
  roomType: string,
  capabilities: readonly string[],
): boolean {
  return state.rooms.some(
    (r) =>
      r.valid && r.typeId === roomType && capabilities.every((c) => r.capabilities.includes(c)),
  );
}

/**
 * Why no room can take a step, for messages: "No working Majors Bay", or,
 * when the rooms exist but lack equipment, "No Majors Bay with an ECG
 * (12-lead)". Null if a room can.
 */
export function missingRoom(
  state: SimState,
  roomType: string,
  capabilities: readonly string[],
): string | null {
  if (hasRoomWith(state, roomType, capabilities)) return null;
  const name = roomById.get(roomType)?.name ?? roomType;
  if (!hasRoomWith(state, roomType, [])) return `No working ${name}`;
  const missing = capabilities.filter((c) => !hasRoomWith(state, roomType, [c]));
  const items = (missing.length > 0 ? missing : capabilities).flatMap(equipmentNamesFor);
  return `No ${name} with ${items.join(" and ")}`;
}

function objectsIn(state: SimState, roomType: string, test: (defId: string) => boolean) {
  const out: PlacedObject[] = [];
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== roomType) continue;
    for (const id of room.objectIds) {
      const obj = state.objects[id]!;
      if (test(obj.defId)) out.push(obj);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function nearest<T extends PlacedObject>(items: T[], from: Point): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const o of items) {
    const d = manhattan(o, from);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

// ---------- Seats ----------

/** Tile of seat `slot` on a seating object (benches have one seat per tile). */
export function seatTile(obj: PlacedObject, slot: number): Point {
  return rectTiles(objectRect(obj))[slot] ?? { x: obj.x, y: obj.y };
}

/** Where to stand before sitting down: in front of the seat. */
export function seatApproach(obj: PlacedObject, slot: number): Point {
  const t = seatTile(obj, slot);
  const { dx, dy } = frontDirection(obj.rotation);
  return { x: t.x + dx, y: t.y + dy };
}

/** The nearest free seat in a valid waiting area. */
export function freeSeat(state: SimState, from: Point): { objectId: number; slot: number } | null {
  let best: { objectId: number; slot: number } | null = null;
  let bestD = Infinity;
  const seating = objectsIn(state, "waiting_area", (d) => (equipmentById.get(d)?.seats ?? 0) > 0);
  for (const obj of seating) {
    const seats = equipmentById.get(obj.defId)!.seats!;
    for (let slot = 0; slot < seats; slot++) {
      if (holder(state, obj.id, slot) !== undefined) continue;
      const d = manhattan(seatTile(obj, slot), from);
      if (d < bestD) {
        best = { objectId: obj.id, slot };
        bestD = d;
      }
    }
  }
  return best;
}

/** A random standable tile in a valid room of the type, if there is one. */
export function standingSpot(
  state: SimState,
  roomType: string,
  pick: (n: number) => number,
): Point | null {
  const grid = state.floors[0]!;
  const tiles: Point[] = [];
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== roomType) continue;
    for (const i of room.tiles) {
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      if (isStandable(grid, x, y)) tiles.push({ x, y });
    }
  }
  return tiles.length === 0 ? null : tiles[pick(tiles.length)]!;
}

/** Seats in valid waiting areas, and how many are taken. */
export function seatCount(state: SimState): { total: number; taken: number } {
  let total = 0;
  let taken = 0;
  const seating = objectsIn(state, "waiting_area", (d) => (equipmentById.get(d)?.seats ?? 0) > 0);
  for (const obj of seating) {
    const seats = equipmentById.get(obj.defId)!.seats!;
    total += seats;
    for (let slot = 0; slot < seats; slot++) if (holder(state, obj.id, slot) !== undefined) taken++;
  }
  return { total, taken };
}

// ---------- Couches (triage and treatment) ----------

export function isCouch(defId: string): boolean {
  const caps = equipmentById.get(defId)?.capabilities ?? [];
  return caps.includes("examination") || caps.includes("patient_space") || caps.includes("imaging");
}

/** Centre of an item's footprint, where a patient lies. */
export function restPoint(obj: PlacedObject): Point {
  const r = objectRect(obj);
  return { x: r.x + (r.w - 1) / 2, y: r.y + (r.h - 1) / 2 };
}

/** A clear tile beside a couch: where staff work, and where a patient climbs on. */
export function bedside(state: SimState, obj: PlacedObject): Point {
  const grid = state.floors[obj.floor]!;
  const sides = sideTiles(objectRect(obj), obj.rotation, "sides");
  return sides.find((t) => isStandable(grid, t.x, t.y)) ?? sides[0]!;
}

export const MAX_COUCH_DIRT = 0;

/** Free, clean couches in valid rooms of the type with the capabilities, nearest `from` first. */
export function freeCouches(
  state: SimState,
  roomType: string,
  capabilities: readonly string[],
  from: Point,
): PlacedObject[] {
  return objectsIn(state, roomType, isCouch)
    .filter((o) => {
      if (holder(state, o.id, 0) !== undefined || (state.dirt[o.id] ?? 0) > MAX_COUCH_DIRT) {
        return false;
      }
      const room = roomOfObject(state, o.id)!;
      return capabilities.every((c) => room.capabilities.includes(c));
    })
    .sort((a, b) => manhattan(a, from) - manhattan(b, from) || a.id - b.id);
}

/** A free, clean couch in a valid room of the type with the capabilities, nearest `from`. */
export function freeCouch(
  state: SimState,
  roomType: string,
  capabilities: readonly string[],
  from: Point,
): PlacedObject | undefined {
  const couches = objectsIn(state, roomType, isCouch).filter((o) => {
    if (holder(state, o.id, 0) !== undefined || (state.dirt[o.id] ?? 0) > MAX_COUCH_DIRT) {
      return false;
    }
    const room = roomOfObject(state, o.id)!;
    return capabilities.every((c) => room.capabilities.includes(c));
  });
  return nearest(couches, from);
}

/** Couches in valid rooms of a type with the capabilities: how many, and why the rest aren't free. */
export function couchStatus(
  state: SimState,
  roomType: string,
  capabilities: readonly string[],
): { total: number; inUse: number; dirty: number; free: number } {
  let total = 0;
  let inUse = 0;
  let dirty = 0;
  for (const o of objectsIn(state, roomType, isCouch)) {
    const room = roomOfObject(state, o.id)!;
    if (!capabilities.every((c) => room.capabilities.includes(c))) continue;
    total++;
    if (holder(state, o.id, 0) !== undefined) inUse++;
    else if ((state.dirt[o.id] ?? 0) > MAX_COUCH_DIRT) dirty++;
  }
  return { total, inUse, dirty, free: total - inUse - dirty };
}

// ---------- Toilets ----------

/** A toilet is too dirty to use at twice the cleaning threshold. */
export const MAX_TOILET_DIRT = TOILET_USES_BEFORE_CLEAN * 2;

export function freeToilet(state: SimState, from: Point): PlacedObject | undefined {
  const toilets = objectsIn(state, "toilets", (d) => d === "toilet").filter(
    (o) => holder(state, o.id, 0) === undefined && (state.dirt[o.id] ?? 0) < MAX_TOILET_DIRT,
  );
  return nearest(toilets, from);
}

// ---------- Cleaning ----------

/**
 * dirty: needs cleaning and nobody's cleaning it yet (a couch, trolley or bed
 * can't be used; a toilet still can); cleaning: a cleaner is at work on it;
 * out_of_use: a toilet too dirty to use until it's cleaned.
 */
export type CleaningStatus = "dirty" | "cleaning" | "out_of_use";

/** Every item that needs (or is getting) a clean, by object id. */
export function cleaningStatuses(state: SimState): Map<number, CleaningStatus> {
  const working = new Set<number>();
  for (const j of Object.values(state.jobs)) {
    if ((j.kind === "clean_cubicle" || j.kind === "clean_toilet") && j.state === "working") {
      working.add(j.objectId!);
    }
  }
  const out = new Map<number, CleaningStatus>();
  for (const [key, uses] of Object.entries(state.dirt)) {
    const id = Number(key);
    const obj = state.objects[id];
    if (!obj) continue;
    const toilet = obj.defId === "toilet";
    if (toilet ? uses < TOILET_USES_BEFORE_CLEAN : uses <= MAX_COUCH_DIRT) continue;
    if (working.has(id)) out.set(id, "cleaning");
    else out.set(id, toilet && uses >= MAX_TOILET_DIRT ? "out_of_use" : "dirty");
  }
  return out;
}

/** Where someone stands to use (or clean) an item: in front of it. */
export function frontOf(obj: PlacedObject): Point {
  const r = objectRect(obj);
  const { dx, dy } = frontDirection(obj.rotation);
  const cx = r.x + Math.floor((r.w - 1) / 2);
  const cy = r.y + Math.floor((r.h - 1) / 2);
  if (dy !== 0) return { x: cx, y: dy > 0 ? r.y + r.h : r.y - 1 };
  return { x: dx > 0 ? r.x + r.w : r.x - 1, y: cy };
}

// ---------- Reception desks ----------

/** Behind the middle of a desk, where the receptionist sits. */
export function deskStaffSpot(obj: PlacedObject): Point {
  const r = objectRect(obj);
  const { dx, dy } = frontDirection(obj.rotation);
  const cx = r.x + Math.floor((r.w - 1) / 2);
  const cy = r.y + Math.floor((r.h - 1) / 2);
  if (dy !== 0) return { x: cx, y: dy > 0 ? r.y - 1 : r.y + r.h };
  return { x: dx > 0 ? r.x - 1 : r.x + r.w, y: cy };
}

export function receptionDesks(state: SimState): PlacedObject[] {
  return objectsIn(state, "ae_reception", (d) => d === "reception_desk");
}

/** Desks with a receptionist sitting at them. */
export function staffedDesks(state: SimState): PlacedObject[] {
  return receptionDesks(state).filter((d) => {
    const id = holder(state, d.id, "staff");
    const s = id === undefined ? undefined : state.staff[id];
    if (!s) return false;
    const spot = deskStaffSpot(d);
    return s.path.length === 0 && s.x === spot.x && s.y === spot.y;
  });
}

/**
 * Places to queue for reception, best first: in front of each desk, then
 * the tiles of the reception room in order of walking distance from the
 * desks (breadth-first).
 */
export function queueSpots(state: SimState): Point[] {
  const desks = receptionDesks(state);
  if (desks.length === 0) return [];
  const grid = state.floors[0]!;
  const roomIds = new Set(desks.map((d) => state.objectRoom[d.id]!));
  const seen = new Set<number>();
  const out: Point[] = [];
  const queue: Point[] = [];
  for (const d of desks) {
    const f = frontOf(d);
    const i = tileIndex(grid, f.x, f.y);
    if (!seen.has(i) && isStandable(grid, f.x, f.y)) {
      seen.add(i);
      queue.push(f);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head]!;
    out.push(t);
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      const nx = t.x + dx;
      const ny = t.y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const i = tileIndex(grid, nx, ny);
      if (seen.has(i) || !roomIds.has(grid.roomId[i]!) || !isStandable(grid, nx, ny)) continue;
      seen.add(i);
      queue.push({ x: nx, y: ny });
    }
  }
  return out;
}

// ---------- Site entrance ----------

const entranceCache = new WeakMap<SimState, { version: number; at: Point | null }>();

/**
 * Where people on foot arrive from the public road: both ends of the
 * hospital-side pavement, then the bus stop. Empty on a map with no road.
 */
export function arrivalPoints(state: SimState): Point[] {
  const site = state.site;
  if (!site) return [];
  const p = site.pavements[0];
  return [{ x: p.x, y: p.y }, { x: p.x + p.w - 1, y: p.y }, site.busStop];
}

/**
 * Where people leave to (and new staff turn up): the arrival point nearest
 * on foot to A&E reception (or, without one, to any room). On a map with no
 * road, the nearest edge tile. Null when the building can't be reached from
 * outside.
 */
export function siteEntrance(state: SimState): Point | null {
  const cached = entranceCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.at;
  const grid = state.floors[0]!;
  let from: Point | null = null;
  const desk = receptionDesks(state)[0];
  if (desk) from = frontOf(desk);
  else {
    const room = state.rooms.find((r) => r.floor === 0);
    const i = room?.tiles[0];
    if (i !== undefined) from = { x: i % grid.width, y: Math.floor(i / grid.width) };
  }
  const points = new Set(arrivalPoints(state).map((p) => tileIndex(grid, p.x, p.y)));
  let at: Point | null = null;
  if (from && points.size > 0) at = nearestTile(grid, from.x, from.y, (i) => points.has(i));
  else if (from) at = nearestEdgeTile(grid, from.x, from.y);
  entranceCache.set(state, { version: state.layoutVersion, at });
  return at;
}

/** Where to put new arrivals when the building is unreachable: bottom middle of the map. */
export function fallbackEntrance(state: SimState): Point {
  const grid = state.floors[0]!;
  return { x: Math.floor(grid.width / 2), y: grid.height - 1 };
}

// ---------- Rooms patients can't reach ----------

/** Room types patients walk into: reception, waiting, toilets, wards and every pathway room. */
const PATIENT_ROOMS = new Set([
  "ae_reception",
  "waiting_area",
  "toilets",
  "ward",
  ...content.conditions.flatMap((c) => c.pathway.map((s) => s.room)),
]);

const unreachableCache = new WeakMap<SimState, { version: number; rooms: Room[] }>();

/**
 * Valid rooms patients need to walk into but can't reach from outside
 * without crossing a clinical room (patients keep to public routes: see
 * world/access.ts). Cached per layout.
 */
export function roomsPatientsCantReach(state: SimState): Room[] {
  const cached = unreachableCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.rooms;
  const grid = state.floors[0]!;
  const { width, height } = grid;
  const start = siteEntrance(state);
  let rooms: Room[] = [];
  if (start) {
    // Flood from the entrance over tiles any patient may cross.
    const access = patientAccess(state);
    const open = (i: number) => access[i] === OPEN && isWalkable(grid, i);
    const reached = new Uint8Array(width * height);
    const queue = [tileIndex(grid, start.x, start.y)];
    reached[queue[0]!] = 1;
    const step = (i: number, f: (n: number) => void) => {
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0) f(i - 1);
      if (x < width - 1) f(i + 1);
      if (y > 0) f(i - width);
      if (y < height - 1) f(i + width);
    };
    for (let head = 0; head < queue.length; head++) {
      step(queue[head]!, (n) => {
        if (reached[n] || !open(n)) return;
        reached[n] = 1;
        queue.push(n);
      });
    }
    // A room is reachable if one of its tiles is, or borders a reached tile.
    rooms = state.rooms.filter((room) => {
      if (!room.valid || room.floor !== 0 || !PATIENT_ROOMS.has(room.typeId)) return false;
      return !room.tiles.some((t) => {
        if (reached[t]) return true;
        let near = false;
        step(t, (n) => (near ||= reached[n] === 1));
        return near;
      });
    });
  }
  unreachableCache.set(state, { version: state.layoutVersion, rooms });
  return rooms;
}
