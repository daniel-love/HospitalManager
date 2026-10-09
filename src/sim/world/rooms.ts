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
import { content, equipmentById, objectDef, roomByCode, roomById } from "@data/catalogue";
import type { RoomDef } from "@data/schema";
import type { Room, RoomCheck, SimState } from "../state";
import { isWallOrDoor, tileIndex, type FloorGrid } from "./grid";
import { isStandable, objectRect, sideTiles } from "./objects";

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

  for (const room of rooms) evaluateRoom(state, room, rooms);
  state.rooms = rooms;
  state.objectRoom = objectRoom;
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

  const [minW, minH] = def.minSize;
  if (minW * minH > 1) checks.push(sizeCheck(room, minW, minH));

  if (def.enclosed) {
    const { enclosed, hasDoor } = boundary(grid, room);
    checks.push({ label: "Enclosed by walls", ok: enclosed });
    checks.push({ label: "Has a door", ok: hasDoor });
  }

  const defIds = room.objectIds.map((id) => state.objects[id]!.defId);
  for (const req of def.required) {
    const have = defIds.filter((d) => req.anyOf.includes(d)).length;
    checks.push({
      label: req.label,
      ok: have >= req.count,
      ...(req.count > 1 ? { detail: `${have} of ${req.count}` } : {}),
    });
  }

  if (def.minSeats !== undefined) {
    const seats = defIds.reduce((n, d) => n + (equipmentById.get(d)?.seats ?? 0), 0);
    checks.push({
      label: `Seating for ${def.minSeats}`,
      ok: seats >= def.minSeats,
      detail: `${seats} of ${def.minSeats}`,
    });
  }

  if (def.bothBedSides) checks.push(bedSidesCheck(state, room));

  if (def.connectedTo.length > 0) {
    const neighbours = connectedRoomTypes(grid, room, rooms);
    for (const c of def.connectedTo) {
      checks.push({ label: c.label, ok: neighbours.has(c.roomType) });
    }
  }

  room.checks = checks;
  room.valid = checks.every((c) => c.ok);
  room.capabilities = capabilitiesOf(defIds);
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

/** Enclosed = every tile's neighbours are in the room, a wall or a door. */
function boundary(grid: FloorGrid, room: Room): { enclosed: boolean; hasDoor: boolean } {
  const { width, height } = grid;
  let enclosed = true;
  let hasDoor = false;
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
      else if (grid.roomId[n] !== room.id && !isWallOrDoor(grid, n)) enclosed = false;
    }
  }
  return { enclosed, hasDoor };
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
