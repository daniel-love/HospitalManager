/**
 * Player actions as plain command objects (ARCHITECTURE §2). Every build tool
 * produces a Command; the UI previews it with planCommand() (a dry run that
 * reports cost and problems) and commits it with applyCommand().
 *
 * Construction is instant (GAME_DESIGN §3.1): the cost is paid up front and
 * the change takes effect immediately, even while paused. Removing things
 * refunds RESALE_FRACTION of what they cost.
 */
import { objectDef, roomById, wallByType } from "@data/catalogue";
import { RESALE_FRACTION } from "@data/economy";
import { FOUNDATION_COST_PER_TILE } from "@data/structures";
import type { PlacedObject, Rotation, SimState } from "./state";
import { FloorType, tileIndex, WallType, type FloorGrid } from "./world/grid";
import {
  accessBlockedBy,
  blockedMessage,
  footprintRect,
  layerOf,
  mountsRelyingOn,
  noWallMessage,
  objectRect,
  placementProblem,
} from "./world/objects";
import { clipRect, outlineTiles, rectTiles, unionRect, type Rect } from "./world/rect";
import { detectRooms } from "./world/rooms";

export type Command =
  /** Lay foundations: grass → floor. */
  | { type: "build_floor"; floor: number; rect: Rect }
  /** Back to grass, removing everything on those tiles. */
  | { type: "remove_floor"; floor: number; rect: Rect }
  /** Walls around the rect's outline (a 1-wide rect is a straight line). */
  | { type: "build_walls"; floor: number; rect: Rect; wall: WallType }
  /** Removes walls and doors in the rect. */
  | { type: "demolish"; floor: number; rect: Rect }
  /** Paints a room type onto floor tiles; null clears zoning. Free. */
  | { type: "zone"; floor: number; rect: Rect; roomType: string | null }
  /** Places equipment, or a door into a wall. */
  | {
      type: "place_object";
      floor: number;
      defId: string;
      x: number;
      y: number;
      rotation: Rotation;
    }
  /** Sells equipment (not doors) touching the rect. */
  | { type: "remove_objects"; floor: number; rect: Rect }
  /** Sells one piece of equipment by id, leaving anything sharing its tiles. */
  | { type: "remove_object"; floor: number; id: number }
  /** Moves (and/or rotates) a piece of equipment. Free. */
  | {
      type: "move_object";
      floor: number;
      id: number;
      x: number;
      y: number;
      rotation: Rotation;
    };

export interface CommandResult {
  ok: boolean;
  /** £ spent; negative means a refund. */
  cost: number;
  /** How many tiles or items the command affects. */
  count: number;
  /** Why the command can't be applied (set whenever ok is false). */
  error?: string;
  /** Area that changed (or would), for redrawing. */
  changed: Rect | null;
}

/** Dry run: what would happen, without changing anything. */
export function planCommand(state: SimState, cmd: Command): CommandResult {
  return finish(state, run(state, cmd, false));
}

/** Applies the command if it's valid and affordable. */
export function applyCommand(state: SimState, cmd: Command): CommandResult {
  const plan = planCommand(state, cmd);
  if (!plan.ok) return plan;
  run(state, cmd, true);
  state.money -= plan.cost;
  state.layoutVersion++;
  detectRooms(state);
  return plan;
}

interface Outcome {
  cost: number;
  count: number;
  changed: Rect | null;
  error?: string;
}

function finish(state: SimState, o: Outcome): CommandResult {
  const base = { cost: o.cost, count: o.count, changed: o.changed };
  if (o.error) return { ...base, ok: false, error: o.error };
  if (o.count === 0) return { ...base, ok: false, error: NOTHING_TO_CHANGE };
  if (o.cost > state.money) return { ...base, ok: false, error: "Not enough money" };
  return { ...base, ok: true };
}

/** Error for a command that would change nothing (e.g. walling over walls). */
export const NOTHING_TO_CHANGE = "Nothing to change here";

const refund = (cost: number) => Math.round(cost * RESALE_FRACTION);

function run(state: SimState, cmd: Command, commit: boolean): Outcome {
  const grid = state.floors[cmd.floor];
  if (!grid) return { cost: 0, count: 0, changed: null, error: "No such floor" };
  switch (cmd.type) {
    case "build_floor":
      return buildFloor(grid, clip(grid, cmd.rect), commit);
    case "remove_floor":
      return removeFloor(state, grid, cmd.floor, clip(grid, cmd.rect), commit);
    case "build_walls":
      return buildWalls(state, grid, cmd.floor, clip(grid, cmd.rect), cmd.wall, commit);
    case "demolish":
      return demolish(state, grid, cmd.floor, clip(grid, cmd.rect), commit);
    case "zone":
      return zone(grid, clip(grid, cmd.rect), cmd.roomType, commit);
    case "place_object":
      return placeObject(state, grid, cmd, commit);
    case "remove_objects":
      return removeObjects(state, grid, cmd.floor, clip(grid, cmd.rect), commit);
    case "remove_object":
      return removeOne(state, cmd.floor, cmd.id, commit);
    case "move_object":
      return moveObject(state, grid, cmd, commit);
  }
}

function clip(grid: FloorGrid, r: Rect): Rect {
  return clipRect(r, grid.width, grid.height);
}

function buildFloor(grid: FloorGrid, rect: Rect, commit: boolean): Outcome {
  let count = 0;
  for (const { x, y } of rectTiles(rect)) {
    const i = tileIndex(grid, x, y);
    if (grid.floorType[i] !== FloorType.Grass) continue;
    count++;
    if (commit) grid.floorType[i] = FloorType.Floor;
  }
  return { cost: count * FOUNDATION_COST_PER_TILE, count, changed: rect };
}

function removeFloor(
  state: SimState,
  grid: FloorGrid,
  floor: number,
  rect: Rect,
  commit: boolean,
): Outcome {
  // Everything standing on the floor goes too, objects in full.
  const objs = objectsTouching(state, grid, floor, rect, () => true);
  let cost = objs.reduce((sum, o) => sum - refund(objectCost(o)), 0);
  let changed: Rect | null = rect;
  for (const o of objs) changed = unionRect(changed, objectRect(o));
  let count = objs.length;
  for (const { x, y } of rectTiles(rect)) {
    const i = tileIndex(grid, x, y);
    if (grid.floorType[i] === FloorType.Grass) continue;
    count++;
    cost -= refund(FOUNDATION_COST_PER_TILE + wallCost(grid.wall[i]!));
  }
  // Grass isn't standable, so neighbouring items mustn't face it.
  const removed = new Set(objs.map((o) => o.id));
  const victim = accessBlockedBy(state, floor, rectTiles(rect), removed);
  if (victim) return { cost: 0, count: 0, changed: null, error: blockedMessage(victim) };
  const fixture = mountsRelyingOn(state, floor, rectTiles(rect), removed);
  if (fixture) return { cost: 0, count: 0, changed: null, error: noWallMessage(fixture) };
  if (commit) {
    for (const o of objs) removeObject(state, o);
    for (const { x, y } of rectTiles(rect)) {
      const i = tileIndex(grid, x, y);
      grid.floorType[i] = FloorType.Grass;
      grid.wall[i] = WallType.None;
      grid.zone[i] = 0;
    }
  }
  return { cost, count, changed };
}

function buildWalls(
  state: SimState,
  grid: FloorGrid,
  floor: number,
  rect: Rect,
  wall: WallType,
  commit: boolean,
): Outcome {
  const def = wallByType.get(wall);
  if (!def) return { cost: 0, count: 0, changed: null, error: "Unknown wall type" };
  let cost = 0;
  let count = 0;
  const tiles = outlineTiles(rect);
  for (const { x, y } of tiles) {
    const i = tileIndex(grid, x, y);
    // Redrawing a room outline over its doors keeps the doors.
    if (grid.door[i] !== 0 || grid.wall[i] === wall) continue;
    const objId = grid.objectId[i] !== -1 ? grid.objectId[i]! : grid.mountId[i]!;
    if (objId !== -1) {
      const name = objectDef(state.objects[objId]!.defId)?.def.name ?? "equipment";
      return { cost: 0, count: 0, changed: null, error: `Blocked by ${name}` };
    }
    count++;
    cost += def.costPerTile - refund(wallCost(grid.wall[i]!));
    if (grid.floorType[i] === FloorType.Grass) cost += FOUNDATION_COST_PER_TILE;
  }
  const victim = accessBlockedBy(state, floor, tiles, new Set());
  if (victim) return { cost: 0, count: 0, changed: null, error: blockedMessage(victim) };
  if (commit) {
    for (const { x, y } of tiles) {
      const i = tileIndex(grid, x, y);
      if (grid.door[i] !== 0) continue;
      grid.wall[i] = wall;
      grid.floorType[i] = FloorType.Floor;
      grid.zone[i] = 0;
    }
  }
  return { cost, count, changed: rect };
}

function demolish(
  state: SimState,
  grid: FloorGrid,
  floor: number,
  rect: Rect,
  commit: boolean,
): Outcome {
  const doors = objectsTouching(state, grid, floor, rect, (o) => o.kind === "door");
  let cost = doors.reduce((sum, o) => sum - refund(objectCost(o)), 0);
  let count = doors.length;
  let changed: Rect | null = rect;
  for (const o of doors) changed = unionRect(changed, objectRect(o));
  const walls: { x: number; y: number }[] = [];
  for (const { x, y } of rectTiles(rect)) {
    const w = grid.wall[tileIndex(grid, x, y)]!;
    if (w === WallType.None) continue;
    walls.push({ x, y });
    count++;
    cost -= refund(wallCost(w));
  }
  const fixture = mountsRelyingOn(state, floor, walls, new Set());
  if (fixture) return { cost: 0, count: 0, changed: null, error: noWallMessage(fixture) };
  if (commit) {
    for (const o of doors) removeObject(state, o);
    for (const { x, y } of rectTiles(rect)) grid.wall[tileIndex(grid, x, y)] = WallType.None;
  }
  return { cost, count, changed };
}

function zone(grid: FloorGrid, rect: Rect, roomType: string | null, commit: boolean): Outcome {
  let code = 0;
  if (roomType !== null) {
    const def = roomById.get(roomType);
    if (!def) return { cost: 0, count: 0, changed: null, error: "Unknown room type" };
    code = def.code;
  }
  let count = 0;
  let skipped = 0;
  for (const { x, y } of rectTiles(rect)) {
    const i = tileIndex(grid, x, y);
    if (grid.floorType[i] !== FloorType.Floor || grid.wall[i] !== 0 || grid.door[i] !== 0) {
      skipped++;
      continue;
    }
    if (grid.zone[i] === code) continue;
    count++;
    if (commit) grid.zone[i] = code;
  }
  const error = count === 0 && skipped > 0 && code !== 0 ? "Rooms need floor" : undefined;
  return { cost: 0, count, changed: rect, ...(error ? { error } : {}) };
}

function placeObject(
  state: SimState,
  grid: FloorGrid,
  cmd: Extract<Command, { type: "place_object" }>,
  commit: boolean,
): Outcome {
  const def = objectDef(cmd.defId);
  const rect = footprintRect(cmd.defId, cmd.x, cmd.y, cmd.rotation);
  const problem = placementProblem(state, cmd.floor, cmd.defId, cmd.x, cmd.y, cmd.rotation);
  if (!def || problem)
    return { cost: 0, count: 0, changed: rect, error: problem ?? "Unknown item" };
  if (commit) {
    const obj: PlacedObject = {
      id: state.nextObjectId++,
      defId: cmd.defId,
      floor: cmd.floor,
      x: cmd.x,
      y: cmd.y,
      rotation: cmd.rotation,
    };
    state.objects[obj.id] = obj;
    const layer = layerOf(grid, cmd.defId);
    for (const { x, y } of rectTiles(rect)) {
      const i = tileIndex(grid, x, y);
      layer[i] = obj.id;
      if (def.kind === "door") {
        grid.wall[i] = WallType.None;
        grid.door[i] = def.def.code;
        grid.zone[i] = 0;
      }
    }
  }
  return { cost: def.def.cost, count: 1, changed: rect };
}

function moveObject(
  state: SimState,
  grid: FloorGrid,
  cmd: Extract<Command, { type: "move_object" }>,
  commit: boolean,
): Outcome {
  const obj = state.objects[cmd.id];
  const none = { cost: 0, count: 0, changed: null };
  if (!obj || obj.floor !== cmd.floor) return { ...none, error: "That item no longer exists" };
  if (objectDef(obj.defId)?.kind !== "equipment") {
    return { ...none, error: "Only equipment can be moved" };
  }
  const from = objectRect(obj);
  const to = footprintRect(obj.defId, cmd.x, cmd.y, cmd.rotation);
  const changed = unionRect(from, to);
  if (obj.x === cmd.x && obj.y === cmd.y && obj.rotation === cmd.rotation) {
    return { cost: 0, count: 0, changed };
  }
  const problem = placementProblem(state, cmd.floor, obj.defId, cmd.x, cmd.y, cmd.rotation, obj.id);
  if (problem) return { cost: 0, count: 0, changed: to, error: problem };
  if (commit) {
    const layer = layerOf(grid, obj.defId);
    for (const { x, y } of rectTiles(from)) layer[tileIndex(grid, x, y)] = -1;
    for (const { x, y } of rectTiles(to)) layer[tileIndex(grid, x, y)] = obj.id;
    obj.x = cmd.x;
    obj.y = cmd.y;
    obj.rotation = cmd.rotation;
  }
  return { cost: 0, count: 1, changed };
}

function removeObjects(
  state: SimState,
  grid: FloorGrid,
  floor: number,
  rect: Rect,
  commit: boolean,
): Outcome {
  const objs = objectsTouching(state, grid, floor, rect, (o) => o.kind === "equipment");
  let changed: Rect | null = null;
  for (const o of objs) changed = unionRect(changed, objectRect(o));
  if (commit) for (const o of objs) removeObject(state, o);
  return {
    cost: objs.reduce((sum, o) => sum - refund(objectCost(o)), 0),
    count: objs.length,
    changed,
  };
}

function removeOne(state: SimState, floor: number, id: number, commit: boolean): Outcome {
  const obj = state.objects[id];
  if (!obj || obj.floor !== floor || objectDef(obj.defId)?.kind !== "equipment") {
    return { cost: 0, count: 0, changed: null, error: "No such equipment" };
  }
  const changed = objectRect(obj);
  if (commit) removeObject(state, obj);
  return { cost: -refund(objectCost(obj)), count: 1, changed };
}

function objectsTouching(
  state: SimState,
  grid: FloorGrid,
  floor: number,
  rect: Rect,
  filter: (o: NonNullable<ReturnType<typeof objectDef>>) => boolean,
): PlacedObject[] {
  const found = new Set<number>();
  for (const { x, y } of rectTiles(rect)) {
    const i = tileIndex(grid, x, y);
    for (const id of [grid.objectId[i]!, grid.mountId[i]!]) if (id !== -1) found.add(id);
  }
  return [...found]
    .map((id) => state.objects[id]!)
    .filter((o) => o.floor === floor && filter(objectDef(o.defId)!));
}

/** Removes an object. A removed door leaves an opening, not a wall. */
function removeObject(state: SimState, obj: PlacedObject): void {
  const grid = state.floors[obj.floor]!;
  const isDoor = objectDef(obj.defId)?.kind === "door";
  const layer = layerOf(grid, obj.defId);
  for (const { x, y } of rectTiles(objectRect(obj))) {
    const i = tileIndex(grid, x, y);
    layer[i] = -1;
    if (isDoor) grid.door[i] = 0;
  }
  delete state.objects[obj.id];
}

function objectCost(obj: PlacedObject): number {
  return objectDef(obj.defId)?.def.cost ?? 0;
}

function wallCost(wall: number): number {
  return wallByType.get(wall)?.costPerTile ?? 0;
}
