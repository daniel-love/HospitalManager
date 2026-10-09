/**
 * One floor of the tile grid, stored as struct-of-arrays (one typed array per
 * tile property) for memory and speed. Index a tile with tileIndex(grid, x, y).
 */

export const FloorType = {
  Grass: 0,
  /** Foundations: buildable interior. */
  Floor: 1,
  /** Paving for people: the public pavement or a player-laid footpath. */
  Path: 2,
  /** Tarmac for vehicles: the public road or a player-laid access road. */
  Road: 3,
} as const;
export type FloorType = (typeof FloorType)[keyof typeof FloorType];

export const WallType = {
  None: 0,
  Standard: 1,
  /** Glazed: blocks movement but not line of sight. */
  Glass: 2,
  /** Lead-lined: shields X-ray and CT rooms (radiation protection). */
  Lead: 3,
} as const;
export type WallType = (typeof WallType)[keyof typeof WallType];

/** Who owns a tile. Later (M7), parcels for sale will use further codes. */
export const Land = {
  /** The hospital's own site: buildable. */
  Owned: 0,
  /** The council's road and pavements: walked and driven on, never built on. */
  Public: 1,
} as const;
export type Land = (typeof Land)[keyof typeof Land];

export interface FloorGrid {
  width: number;
  height: number;
  floorType: Uint8Array;
  wall: Uint8Array;
  /** Door kind code (see data/structures.ts); 0 = no door. Doors are also objects. */
  door: Uint8Array;
  /** Land code (see Land). Upper floors are all Owned. */
  land: Uint8Array;
  /** Zoned room type code (see data/rooms.ts); 0 = unzoned. Player-painted. */
  zone: Uint8Array;
  /** Detected room id; 0 = no room. Derived from zones and walls, never saved. */
  roomId: Uint16Array;
  /** Floor-standing object (or door) on the tile; -1 = none. Blocks standing. */
  objectId: Int32Array;
  /**
   * Wall- or ceiling-mounted fixture on the tile (oxygen outlet, monitor,
   * curtain track); -1 = none. Doesn't block standing or floor objects.
   */
  mountId: Int32Array;
}

export function createFloorGrid(width: number, height: number): FloorGrid {
  const n = width * height;
  return {
    width,
    height,
    floorType: new Uint8Array(n).fill(FloorType.Grass),
    wall: new Uint8Array(n),
    door: new Uint8Array(n),
    land: new Uint8Array(n),
    zone: new Uint8Array(n),
    roomId: new Uint16Array(n),
    objectId: new Int32Array(n).fill(-1),
    mountId: new Int32Array(n).fill(-1),
  };
}

export function inBounds(grid: FloorGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

export function tileIndex(grid: FloorGrid, x: number, y: number): number {
  return y * grid.width + x;
}

/** Walls and doors are "solid" for room detection: they bound rooms. */
export function isWallOrDoor(grid: FloorGrid, i: number): boolean {
  return grid.wall[i] !== WallType.None || grid.door[i] !== 0;
}

/** Council-owned tiles (the public road and pavements) can't be built on. */
export function isPublic(grid: FloorGrid, i: number): boolean {
  return grid.land[i] === Land.Public;
}
