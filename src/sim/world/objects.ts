/** Footprints and placement rules for equipment and doors. */
import { baseFootprint, objectDef } from "@data/catalogue";
import type { Access, AccessSide } from "@data/schema";
import type { PlacedObject, Rotation, SimState } from "../state";
import { FloorType, inBounds, isWallOrDoor, tileIndex, WallType, type FloorGrid } from "./grid";
import { rectTiles, type Rect } from "./rect";

/** Footprint rect for a def placed with its top-left at (x, y). */
export function footprintRect(defId: string, x: number, y: number, rotation: Rotation): Rect {
  const def = objectDef(defId);
  const [w, h] = def ? baseFootprint(def) : [1, 1];
  return rotation % 2 === 0 ? { x, y, w, h } : { x, y, w: h, h: w };
}

export function objectRect(obj: PlacedObject): Rect {
  return footprintRect(obj.defId, obj.x, obj.y, obj.rotation);
}

/** Unit vector an item's front faces. Rotation 0 faces down; turns are clockwise. */
export function frontDirection(rotation: Rotation): { dx: number; dy: number } {
  return [
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
  ][rotation]!;
}

type Tile = { x: number; y: number };

/** The row of tiles just outside one edge of a footprint, in direction (dx, dy). */
function edgeTiles(r: Rect, dx: number, dy: number): Tile[] {
  const out: Tile[] = [];
  if (dy !== 0) {
    const y = dy > 0 ? r.y + r.h : r.y - 1;
    for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  } else {
    const x = dx > 0 ? r.x + r.w : r.x - 1;
    for (let y = r.y; y < r.y + r.h; y++) out.push({ x, y });
  }
  return out;
}

/** Tiles just outside a side of a rotated footprint. May lie off the map. */
export function sideTiles(r: Rect, rotation: Rotation, side: AccessSide): Tile[] {
  return sideEdges(r, rotation, side).flat();
}

/** Like sideTiles, but "sides" keeps its two edges separate. */
function sideEdges(r: Rect, rotation: Rotation, side: AccessSide): Tile[][] {
  const { dx, dy } = frontDirection(rotation);
  if (side === "front") return [edgeTiles(r, dx, dy)];
  if (side === "back") return [edgeTiles(r, -dx, -dy)];
  return [edgeTiles(r, -dy, dx), edgeTiles(r, dy, -dx)];
}

/**
 * The row of tiles directly in front of a footprint: where someone stands or
 * sits to use the item.
 */
export function frontTiles(r: Rect, rotation: Rotation): Tile[] {
  return sideTiles(r, rotation, "front");
}

export interface AccessTile extends Tile {
  side: AccessSide;
  who: Access["who"];
}

/**
 * One access rule of a placed item: met when every tile of at least one of
 * `options` is clear. "all" rules have a single option; "either" (sides only)
 * has one option per side.
 */
export interface AccessRequirement extends Access {
  options: Tile[][];
}

export function accessRequirements(
  defId: string,
  r: Rect,
  rotation: Rotation,
): AccessRequirement[] {
  const def = objectDef(defId);
  if (def?.kind !== "equipment") return [];
  return def.def.access.map((a) => {
    const edges = sideEdges(r, rotation, a.side);
    return { ...a, options: a.need === "either" ? edges : [edges.flat()] };
  });
}

/** Every tile an item's access rules mention, e.g. where staff might stand. */
export function accessTiles(defId: string, r: Rect, rotation: Rotation): AccessTile[] {
  return accessRequirements(defId, r, rotation).flatMap(({ side, who, options }) =>
    options.flat().map((t) => ({ ...t, side, who })),
  );
}

export function isMet(req: AccessRequirement, isClear: (t: Tile) => boolean): boolean {
  return req.options.some((option) => option.every(isClear));
}

/** The first access rule that isn't met, given which tiles count as clear. */
export function unmetAccess(
  defId: string,
  r: Rect,
  rotation: Rotation,
  isClear: (t: Tile) => boolean,
): AccessRequirement | undefined {
  return accessRequirements(defId, r, rotation).find((req) => !isMet(req, isClear));
}

function accessProblem(req: AccessRequirement): string {
  if (req.who === "staff") {
    if (req.side !== "sides") return "No room for staff on its blue side";
    return req.need === "either"
      ? "Staff need one long side clear"
      : "Staff need both long sides clear";
  }
  return req.side === "front"
    ? "Its front (arrow side) is blocked"
    : "It needs clear space around it";
}

/** Whether someone could stand on a tile: floor or paving, no wall, door or object. */
export function isStandable(grid: FloorGrid, x: number, y: number, ignoreId = -1): boolean {
  if (!inBounds(grid, x, y)) return false;
  const i = tileIndex(grid, x, y);
  const occupant = grid.objectId[i];
  return (
    grid.floorType[i] !== FloorType.Grass &&
    !isWallOrDoor(grid, i) &&
    (occupant === -1 || occupant === ignoreId)
  );
}

/**
 * The natural rotation for a door at (x, y): along the wall it sits in.
 * 0 = wall runs left–right, 1 = wall runs up–down.
 */
export function doorRotationAt(grid: FloorGrid, x: number, y: number): Rotation {
  const wallAt = (tx: number, ty: number) =>
    inBounds(grid, tx, ty) && isWallOrDoor(grid, tileIndex(grid, tx, ty));
  if (wallAt(x - 1, y) || wallAt(x + 1, y)) return 0;
  if (wallAt(x, y - 1) || wallAt(x, y + 1)) return 1;
  return 0;
}

/** Returns why the object can't go here, or null if it can. Ignores cost. */
export function placementProblem(
  state: SimState,
  floor: number,
  defId: string,
  x: number,
  y: number,
  rotation: Rotation,
  /** An object to treat as absent, so it can be moved onto its own tiles. */
  ignoreId = -1,
): string | null {
  const grid = state.floors[floor];
  const def = objectDef(defId);
  if (!grid || !def) return "Unknown item";
  const r = footprintRect(defId, x, y, rotation);
  const mount = mountOf(defId);
  if (mount !== "floor") return mountProblem(grid, r, rotation, mount, ignoreId);
  for (let ty = r.y; ty < r.y + r.h; ty++) {
    for (let tx = r.x; tx < r.x + r.w; tx++) {
      if (!inBounds(grid, tx, ty)) return "Off the map";
      const i = tileIndex(grid, tx, ty);
      const occupant = grid.objectId[i];
      if (occupant !== -1 && occupant !== ignoreId) return "Something is already here";
      if (def.kind === "door") {
        if (grid.wall[i] === WallType.None) return "Doors go in walls";
        const fixture = mountsRelyingOn(state, floor, [{ x: tx, y: ty }], new Set());
        if (fixture) return noWallMessage(fixture);
        // Both faces of the door must open onto something walkable.
        const [ax, ay] = rotation % 2 === 0 ? [0, 1] : [1, 0];
        for (const s of [-1, 1]) {
          const sx = tx + ax * s;
          const sy = ty + ay * s;
          if (!inBounds(grid, sx, sy) || isWallOrDoor(grid, tileIndex(grid, sx, sy))) {
            return "A door needs open space on both sides";
          }
        }
      } else {
        if (isWallOrDoor(grid, i)) return "Blocked by a wall";
        if (grid.floorType[i] !== FloorType.Floor) return "Needs floor (foundations)";
      }
    }
  }
  if (def.kind === "equipment") {
    // People must be able to reach the item...
    const unmet = unmetAccess(defId, r, rotation, (t) => isStandable(grid, t.x, t.y, ignoreId));
    if (unmet) return accessProblem(unmet);
    // ...and it mustn't block anyone else's.
    const victim = accessBlockedBy(state, floor, rectTiles(r), new Set([ignoreId]));
    if (victim) return blockedMessage(victim);
  }
  return null;
}

/**
 * The first item whose access would stop being met if these tiles stopped
 * being standable, ignoring items in `exclude` (e.g. ones being removed or
 * moved). Covering one side of a bed is fine while its other side is clear.
 */
export function accessBlockedBy(
  state: SimState,
  floor: number,
  tiles: { x: number; y: number }[],
  exclude: ReadonlySet<number>,
): PlacedObject | undefined {
  const grid = state.floors[floor];
  if (!grid) return undefined;
  const covered = new Set(tiles.map((t) => tileIndex(grid, t.x, t.y)));
  for (const t of tiles) {
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = t.x + dx;
      const ny = t.y + dy;
      if (!inBounds(grid, nx, ny)) continue;
      const id = grid.objectId[tileIndex(grid, nx, ny)]!;
      if (id === -1 || exclude.has(id)) continue;
      const obj = state.objects[id]!;
      const r = objectRect(obj);
      const clearNow = (c: Tile) => isStandable(grid, c.x, c.y);
      const clearAfter = (c: Tile) => clearNow(c) && !covered.has(tileIndex(grid, c.x, c.y));
      // Only report newly broken rules, not ones an older save already broke.
      const broken = accessRequirements(obj.defId, r, obj.rotation).some(
        (req) => isMet(req, clearNow) && !isMet(req, clearAfter),
      );
      if (broken) return obj;
    }
  }
  return undefined;
}

/** Items on a tile, top first: a mounted fixture, then the floor item or door. */
export function itemsAt(state: SimState, floor: number, x: number, y: number): PlacedObject[] {
  const grid = state.floors[floor];
  if (!grid || !inBounds(grid, x, y)) return [];
  const i = tileIndex(grid, x, y);
  return [grid.mountId[i]!, grid.objectId[i]!]
    .filter((id) => id !== -1)
    .map((id) => state.objects[id]!);
}

export type Mount = "floor" | "wall" | "ceiling";

/** How an item is fixed: doors and most equipment stand on the floor. */
export function mountOf(defId: string): Mount {
  const def = objectDef(defId);
  return def?.kind === "equipment" ? def.def.mount : "floor";
}

/** The grid layer an item occupies: floor items block the tile, mounted ones don't. */
export function layerOf(grid: FloorGrid, defId: string): Int32Array {
  return mountOf(defId) === "floor" ? grid.objectId : grid.mountId;
}

function mountProblem(
  grid: FloorGrid,
  r: Rect,
  rotation: Rotation,
  mount: Exclude<Mount, "floor">,
  ignoreId: number,
): string | null {
  for (const t of rectTiles(r)) {
    if (!inBounds(grid, t.x, t.y)) return "Off the map";
    const i = tileIndex(grid, t.x, t.y);
    if (isWallOrDoor(grid, i)) return "Mount it beside a wall, not on it";
    if (grid.floorType[i] !== FloorType.Floor) return "Needs floor (foundations)";
    const other = grid.mountId[i];
    if (other !== -1 && other !== ignoreId) return "Something is already mounted here";
  }
  if (mount === "wall") {
    const behind = sideTiles(r, rotation, "back");
    const onWall = behind.every(
      (t) => inBounds(grid, t.x, t.y) && grid.wall[tileIndex(grid, t.x, t.y)] !== WallType.None,
    );
    if (!onWall) return "Needs a wall behind it (the dark edge)";
  }
  return null;
}

/**
 * The first wall-mounted item that would lose its wall if these tiles stopped
 * being walls, ignoring items in `exclude` (e.g. ones being removed too).
 */
export function mountsRelyingOn(
  state: SimState,
  floor: number,
  tiles: Tile[],
  exclude: ReadonlySet<number>,
): PlacedObject | undefined {
  const grid = state.floors[floor];
  if (!grid) return undefined;
  const lost = new Set(tiles.map((t) => tileIndex(grid, t.x, t.y)));
  for (const t of tiles) {
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = t.x + dx;
      const ny = t.y + dy;
      if (!inBounds(grid, nx, ny)) continue;
      const id = grid.mountId[tileIndex(grid, nx, ny)]!;
      if (id === -1 || exclude.has(id)) continue;
      const obj = state.objects[id]!;
      if (mountOf(obj.defId) !== "wall") continue;
      const behind = sideTiles(objectRect(obj), obj.rotation, "back");
      if (behind.some((b) => lost.has(tileIndex(grid, b.x, b.y)))) return obj;
    }
  }
  return undefined;
}

export function noWallMessage(fixture: PlacedObject): string {
  return `Would leave the ${objectDef(fixture.defId)?.def.name ?? "fixture"} with no wall`;
}

/**
 * The rotation that puts a wall-mounted item's back against a wall at (x, y),
 * preferring `preferred` when it already does. Null if no wall is adjacent.
 */
export function wallMountRotation(
  grid: FloorGrid,
  x: number,
  y: number,
  preferred: Rotation,
): Rotation | null {
  const wallBehind = (rot: Rotation) => {
    const { dx, dy } = frontDirection(rot);
    const bx = x - dx;
    const by = y - dy;
    return inBounds(grid, bx, by) && grid.wall[tileIndex(grid, bx, by)] !== WallType.None;
  };
  if (wallBehind(preferred)) return preferred;
  return ([0, 1, 2, 3] as Rotation[]).find(wallBehind) ?? null;
}

export function blockedMessage(victim: PlacedObject): string {
  return `Would block access to ${objectDef(victim.defId)?.def.name ?? "an item"}`;
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
