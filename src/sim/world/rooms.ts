/**
 * Room detection and validation (ARCHITECTURE §5.2).
 *
 * The player paints zones (room types) onto floor tiles. A room is a
 * 4-connected area of one zone type; walls and doors are never zoned, so they
 * split zones into separate rooms. Each room is then checked against its
 * definition in data/rooms.ts to produce a checklist and capability set.
 *
 * Rooms are derived data: detectRooms() rebuilds them all from the grid. At
 * 200×200 that is a few milliseconds, cheap enough to run after every build.
 */
import { POWER } from "@data/maintenance";
import { computeSupply, inService } from "./service";
import {
  conditionEquipment,
  content,
  equipmentById,
  objectDef,
  roomByCode,
  roomById,
} from "@data/catalogue";
import type { RoomDef, SpecialtyId } from "@data/schema";
import type { Room, RoomCheck, SimState, WaitingFor } from "../state";
import { isSolidWall, isWallOrDoor, tileIndex, WallType, type FloorGrid } from "./grid";
import { accessRequirements, isStandable, objectRect, sideTiles } from "./objects";
import { shareKit } from "./sharedKit";

export function detectRooms(state: SimState): void {
  const rooms: Room[] = [];
  state.floors.forEach((grid, floor) => {
    grid.roomId.fill(0);
    for (let start = 0; start < grid.zone.length; start++) {
      const code = grid.zone[start]!;
      if (code === 0 || grid.roomId[start] !== 0 || isWallOrDoor(grid, start)) continue;
      const def = roomByCode.get(code);
      if (!def) continue;
      const id = rooms.length + 1;
      const tiles = floodFill(grid, start, code, id);
      rooms.push({
        id,
        floor,
        typeId: def.id,
        tiles,
        bounds: boundsOf(grid, tiles),
        objectIds: [],
        capabilities: [],
        checks: [],
        valid: false,
        specialty: null,
        emergency: false,
        private: false,
        closed: false,
        essential: POWER.essential.includes(def.id),
        waitingFor: null,
        forConditions: [],
      });
    }
  });

  // An object belongs to a room only if it is wholly inside it.
  const objectRoom: Record<number, number> = {};
  for (const obj of Object.values(state.objects)) {
    const grid = state.floors[obj.floor]!;
    const r = objectRect(obj);
    const first = grid.roomId[tileIndex(grid, r.x, r.y)]!;
    if (first === 0) continue;
    let inside = true;
    for (let y = r.y; y < r.y + r.h && inside; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (grid.roomId[tileIndex(grid, x, y)] !== first) {
          inside = false;
          break;
        }
      }
    }
    if (inside) {
      rooms[first - 1]!.objectIds.push(obj.id);
      objectRoom[obj.id] = first;
    }
  }

  // The essential supply, as the player has changed it; then, in a power cut, what has power.
  for (const [key, on] of Object.entries(state.essentialRooms)) {
    const [floor, tile] = key.split(":").map(Number);
    const id = state.floors[floor!]?.roomId[tile!] ?? 0;
    const room = id === 0 ? undefined : rooms[id - 1];
    if (room) room.essential = on;
  }
  computeSupply(state, rooms, objectRoom);
  for (const room of rooms) evaluateRoom(state, room, rooms);
  shareKit(state, rooms);
  for (const room of rooms) {
    room.forConditions = conditionEquipment(room.typeId).map((e) => ({
      label: e.items.join(" and "),
      ok: room.capabilities.includes(e.capability),
      detail: `for ${e.conditions.join(", ").toLowerCase()}`,
    }));
  }
  // Ward specialties, found again from the tile each is pinned to.
  for (const [key, specialty] of Object.entries(state.roomSpecialties)) {
    const [floor, tile] = key.split(":").map(Number);
    const id = state.floors[floor!]?.roomId[tile!] ?? 0;
    const room = id === 0 ? undefined : rooms[id - 1];
    const def = room && roomById.get(room.typeId);
    if (room && def?.specialty && room.specialty === null) room.specialty = specialty;
  }
  for (const key of Object.keys(state.emergencyTheatres)) {
    const [floor, tile] = key.split(":").map(Number);
    const id = state.floors[floor!]?.roomId[tile!] ?? 0;
    const room = id === 0 ? undefined : rooms[id - 1];
    if (room?.typeId === "theatre") room.emergency = true;
  }
  for (const key of Object.keys(state.privateRooms)) {
    const [floor, tile] = key.split(":").map(Number);
    const id = state.floors[floor!]?.roomId[tile!] ?? 0;
    const room = id === 0 ? undefined : rooms[id - 1];
    if (room && PRIVATE_ROOM_TYPES.has(room.typeId)) room.private = true;
  }
  for (const key of Object.keys(state.closedRooms)) {
    const [floor, tile] = key.split(":").map(Number);
    const id = state.floors[floor!]?.roomId[tile!] ?? 0;
    const room = id === 0 ? undefined : rooms[id - 1];
    if (room && (room.typeId === "ward" || room.typeId === "side_room")) room.closed = true;
  }
  for (const [key, who] of Object.entries(state.waitingAreas)) {
    const [floor, tile] = key.split(":").map(Number);
    const id = state.floors[floor!]?.roomId[tile!] ?? 0;
    const room = id === 0 ? undefined : rooms[id - 1];
    if (room?.typeId === "waiting_area") room.waitingFor = who;
  }
  state.rooms = rooms;
  state.objectRoom = objectRoom;
}

/** Keeps a Waiting Area for A&E patients or outpatients, or opens it to anyone (null). */
export function setWaitingFor(state: SimState, room: Room, who: WaitingFor | null): void {
  const grid = state.floors[room.floor]!;
  for (const key of Object.keys(state.waitingAreas)) {
    const [floor, tile] = key.split(":").map(Number);
    if (floor === room.floor && grid.roomId[tile!] === room.id) delete state.waitingAreas[key];
  }
  if (who !== null) state.waitingAreas[`${room.floor}:${room.tiles[0]!}`] = who;
  room.waitingFor = who;
}

/**
 * Rooms a Hybrid trust can put in its Private Patient Unit: clinic rooms
 * for private clinics, theatres for private lists, and wards and side rooms
 * for private inpatients.
 */
export const PRIVATE_ROOM_TYPES = new Set(["outpatient_clinic", "theatre", "ward", "side_room"]);

/** Puts a room in the Private Patient Unit, or takes it out. */
export function setPrivateRoom(state: SimState, room: Room, on: boolean): void {
  const grid = state.floors[room.floor]!;
  for (const key of Object.keys(state.privateRooms)) {
    const [floor, tile] = key.split(":").map(Number);
    if (floor === room.floor && grid.roomId[tile!] === room.id) delete state.privateRooms[key];
  }
  if (on) state.privateRooms[`${room.floor}:${room.tiles[0]!}`] = true;
  room.private = on;
}

/** Keeps a theatre for emergencies, or opens it to planned lists again. */
export function setEmergencyTheatre(state: SimState, room: Room, on: boolean): void {
  const grid = state.floors[room.floor]!;
  for (const key of Object.keys(state.emergencyTheatres)) {
    const [floor, tile] = key.split(":").map(Number);
    if (floor === room.floor && grid.roomId[tile!] === room.id) delete state.emergencyTheatres[key];
  }
  if (on) state.emergencyTheatres[`${room.floor}:${room.tiles[0]!}`] = true;
  room.emergency = on;
}

/**
 * Gives a ward or clinic room to a specialty (null: any). Pinned to one of its tiles; any
 * older setting for the same room is dropped.
 */
export function setRoomSpecialty(state: SimState, room: Room, specialty: SpecialtyId | null): void {
  const grid = state.floors[room.floor]!;
  for (const key of Object.keys(state.roomSpecialties)) {
    const [floor, tile] = key.split(":").map(Number);
    if (floor === room.floor && grid.roomId[tile!] === room.id) delete state.roomSpecialties[key];
  }
  if (specialty !== null) state.roomSpecialties[`${room.floor}:${room.tiles[0]!}`] = specialty;
  room.specialty = specialty;
}

/** The room an object is wholly inside, if any. */
export function roomOfObject(state: SimState, objectId: number): Room | undefined {
  const id = state.objectRoom[objectId];
  return id === undefined ? undefined : state.rooms[id - 1];
}

/** Room containing tile (x, y) on a floor, if any. */
export function roomAt(state: SimState, floor: number, x: number, y: number): Room | undefined {
  const grid = state.floors[floor];
  if (!grid || x < 0 || y < 0 || x >= grid.width || y >= grid.height) return undefined;
  const id = grid.roomId[tileIndex(grid, x, y)]!;
  return id === 0 ? undefined : state.rooms[id - 1];
}

function floodFill(grid: FloorGrid, start: number, code: number, id: number): number[] {
  const { width, height } = grid;
  const tiles: number[] = [];
  const stack = [start];
  grid.roomId[start] = id;
  while (stack.length > 0) {
    const i = stack.pop()!;
    tiles.push(i);
    const x = i % width;
    const y = (i - x) / width;
    const visit = (n: number) => {
      if (grid.roomId[n] === 0 && grid.zone[n] === code && !isWallOrDoor(grid, n)) {
        grid.roomId[n] = id;
        stack.push(n);
      }
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (y > 0) visit(i - width);
    if (y < height - 1) visit(i + width);
  }
  return tiles;
}

function boundsOf(grid: FloorGrid, tiles: number[]): Room["bounds"] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of tiles) {
    const x = i % grid.width;
    const y = (i - x) / grid.width;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function evaluateRoom(state: SimState, room: Room, rooms: Room[]): void {
  const def = roomDef(room);
  const grid = state.floors[room.floor]!;
  const checks: RoomCheck[] = [];

  // A&E and the mortuary need the street and vehicles: shown only when upstairs.
  if (def.groundOnly && room.floor > 0) {
    checks.push({
      label: "On the ground floor",
      ok: false,
      detail: "it needs street and vehicle access",
    });
  }

  const [minW, minH] = def.minSize;
  if (minW * minH > 1) checks.push(sizeCheck(room, minW, minH));

  if (def.enclosed) {
    const { enclosed, hasDoor, shielded } = boundary(grid, room);
    checks.push({ label: "Enclosed by walls", ok: enclosed });
    checks.push({ label: "Has a door", ok: hasDoor });
    if (def.shielded)
      checks.push({ label: "Lead-lined walls all round", ok: enclosed && shielded });
  }

  // Broken or unpowered kit doesn't count until it's working again.
  const allIds = room.objectIds.map((id) => state.objects[id]!.defId);
  const working = room.objectIds.filter((id) => inService(state, id));
  const defIds = working.map((id) => state.objects[id]!.defId);
  for (const req of def.required) {
    const have = defIds.filter((d) => req.anyOf.includes(d)).length;
    const out = allIds.filter((d) => req.anyOf.includes(d)).length - have;
    const detail = [
      req.count > 1 ? `${have} of ${req.count}` : "",
      out > 0 ? `${out} out of service` : "",
    ]
      .filter(Boolean)
      .join(", ");
    checks.push({ label: req.label, ok: have >= req.count, ...(detail ? { detail } : {}) });
  }

  if (def.minSeats !== undefined) {
    const seats = allIds.reduce((n, d) => n + (equipmentById.get(d)?.seats ?? 0), 0);
    checks.push({
      label: `Seating for ${def.minSeats}`,
      ok: seats >= def.minSeats,
      detail: `${seats} of ${def.minSeats}`,
    });
  }

  if (def.bothBedSides) checks.push(bedSidesCheck(state, room));
  const reach = reachCheck(state, room);
  if (reach) checks.push(reach);

  if (def.connectedTo.length > 0) {
    const neighbours = connectedRoomTypes(grid, room, rooms);
    for (const c of def.connectedTo) {
      checks.push({ label: c.label, ok: neighbours.has(c.roomType) });
    }
  }

  if (room.typeId === "mortuary") checks.push(mortuaryDoorCheck(grid, room, rooms));

  room.checks = checks;
  room.valid = checks.every((c) => c.ok || c.advisory);
  room.capabilities = capabilitiesOf(defIds);
}

/**
 * Rooms where patients, visitors and families are: a mortuary opening onto
 * one means every transfer, and every funeral director, passes them.
 */
const PUBLIC_ROOMS = [
  "ae_reception",
  "waiting_area",
  "outpatients_reception",
  "ward",
  "relatives_room",
  "discharge_lounge",
];

/**
 * A mortuary should open onto a corridor, away from where the public are. It
 * still works if it doesn't (only an advisory), but transfers will be seen.
 */
function mortuaryDoorCheck(grid: FloorGrid, room: Room, rooms: Room[]): RoomCheck {
  const neighbours = connectedRoomTypes(grid, room, rooms);
  const seen = PUBLIC_ROOMS.filter((t) => neighbours.has(t)).map((t) => roomById.get(t)?.name ?? t);
  return {
    label: "Opens away from public areas",
    ok: seen.length === 0,
    advisory: true,
    ...(seen.length > 0
      ? { detail: `opens onto the ${seen.join(" and ")}: transfers will be seen` }
      : {}),
  };
}

/**
 * Types of the rooms this one opens onto: rooms whose tiles touch it directly
 * (no wall between), or that share a door with it.
 */
function connectedRoomTypes(grid: FloorGrid, room: Room, rooms: Room[]): Set<string> {
  const types = new Set<string>();
  const { width, height } = grid;
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
  const note = (i: number) => {
    const id = grid.roomId[i]!;
    if (id !== 0 && id !== room.id) types.add(rooms[id - 1]!.typeId);
  };
  for (const i of room.tiles) {
    for (const n of neighbours(i)) {
      note(n);
      // Look through doors to whatever is on the other side.
      if (grid.door[n] !== 0) for (const m of neighbours(n)) note(m);
    }
  }
  return types;
}

/**
 * Everything in the room can be got at: where staff and patients stand to
 * use each item can be walked to from the way in. Kit can have its own sides
 * clear yet still be boxed in by other kit (a clinic desk's chair penned in
 * by the couch, say), and then nobody can use it. Null for a room with no
 * way in yet (other checks cover that).
 */
function reachCheck(state: SimState, room: Room): RoomCheck | null {
  const grid = state.floors[room.floor]!;
  const { width } = grid;
  const inRoom = new Set(room.tiles);
  const open = (i: number) => isStandable(grid, i % width, Math.floor(i / width));
  const neighbours = (i: number): number[] => {
    const x = i % width;
    const y = (i - x) / width;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < width - 1) out.push(i + 1);
    if (y > 0) out.push(i - width);
    if (y < grid.height - 1) out.push(i + width);
    return out;
  };
  // In through a door, or across an open side from somewhere walkable.
  const reached = new Set<number>();
  const stack: number[] = [];
  for (const i of room.tiles) {
    if (!open(i)) continue;
    const entry = neighbours(i).some(
      (n) => grid.door[n] !== 0 || (!inRoom.has(n) && !isWallOrDoor(grid, n) && open(n)),
    );
    if (entry) {
      reached.add(i);
      stack.push(i);
    }
  }
  if (stack.length === 0) return null;
  while (stack.length > 0) {
    for (const n of neighbours(stack.pop()!)) {
      if (inRoom.has(n) && !reached.has(n) && open(n)) {
        reached.add(n);
        stack.push(n);
      }
    }
  }
  // Tiles outside the room are left to the rest of the layout.
  const ok = (t: { x: number; y: number }) => {
    if (!isStandable(grid, t.x, t.y)) return false;
    const i = tileIndex(grid, t.x, t.y);
    return !inRoom.has(i) || reached.has(i);
  };
  const cut: string[] = [];
  for (const id of room.objectIds) {
    const obj = state.objects[id]!;
    const reqs = accessRequirements(obj.defId, objectRect(obj), obj.rotation);
    if (reqs.some((req) => !req.options.some((option) => option.every(ok)))) {
      const name = objectDef(obj.defId)?.def.name ?? obj.defId;
      if (!cut.includes(name)) cut.push(name);
    }
  }
  return {
    label: "Every item can be reached",
    ok: cut.length === 0,
    ...(cut.length > 0 ? { detail: `boxed in: ${cut.join(", ")}` } : {}),
  };
}

/** Majors/Resus: every bed or trolley needs clear space down both long sides. */
function bedSidesCheck(state: SimState, room: Room): RoomCheck {
  const grid = state.floors[room.floor]!;
  const beds = room.objectIds
    .map((id) => state.objects[id]!)
    .filter((o) => equipmentById.get(o.defId)?.capabilities.includes("patient_space"));
  const clear = beds.filter((o) =>
    sideTiles(objectRect(o), o.rotation, "sides").every((t) => isStandable(grid, t.x, t.y)),
  );
  return {
    label: "Clear space both sides of each bed",
    ok: clear.length === beds.length,
    ...(beds.length > 0 ? { detail: `${clear.length} of ${beds.length}` } : {}),
  };
}

function sizeCheck(room: Room, minW: number, minH: number): RoomCheck {
  const short = Math.min(room.bounds.w, room.bounds.h);
  const long = Math.max(room.bounds.w, room.bounds.h);
  const ok =
    short >= Math.min(minW, minH) &&
    long >= Math.max(minW, minH) &&
    room.tiles.length >= minW * minH;
  return { label: `At least ${minW}×${minH}`, ok, detail: `${room.bounds.w}×${room.bounds.h}` };
}

/**
 * Enclosed = every tile's neighbours are in the room, a solid wall or a
 * door. A curtain divider separates rooms but doesn't enclose one.
 */
function boundary(
  grid: FloorGrid,
  room: Room,
): { enclosed: boolean; hasDoor: boolean; shielded: boolean } {
  const { width, height } = grid;
  let enclosed = true;
  let hasDoor = false;
  let shielded = true;
  for (const i of room.tiles) {
    const x = i % width;
    const y = (i - x) / width;
    const neighbours: [number, boolean][] = [
      [i - 1, x > 0],
      [i + 1, x < width - 1],
      [i - width, y > 0],
      [i + width, y < height - 1],
    ];
    for (const [n, valid] of neighbours) {
      if (!valid) {
        enclosed = false;
        continue;
      }
      if (grid.door[n] !== 0) hasDoor = true;
      else if (grid.roomId[n] !== room.id && !isSolidWall(grid, n)) enclosed = false;
      else if (grid.wall[n] !== WallType.None && grid.wall[n] !== WallType.Lead) shielded = false;
    }
  }
  return { enclosed, hasDoor, shielded };
}

/** Union of the items' capabilities, plus any combos they complete. */
export function capabilitiesOf(defIds: string[]): string[] {
  const caps = new Set<string>();
  for (const d of defIds) {
    const o = objectDef(d);
    if (o?.kind === "equipment") for (const c of o.def.capabilities) caps.add(c);
  }
  for (const combo of content.capabilityCombos) {
    if (combo.requires.every((c) => caps.has(c))) caps.add(combo.capability);
  }
  return [...caps].sort();
}

export function roomDef(room: Room): RoomDef {
  return roomById.get(room.typeId)!;
}
