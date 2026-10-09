/**
 * Building fabric: floor (foundations), walls and doors. Costs are rough UK
 * new-build figures per 1 m tile.
 */
import { FloorType, WallType } from "@sim/world/grid";

/** Turning a grass tile into buildable interior floor (slab, services, finish). */
export const FOUNDATION_COST_PER_TILE = 1200;

/** Outdoor paving the player lays on their own land, linking the hospital to the public road. */
export const surfaces = [
  {
    id: "path",
    type: FloorType.Path,
    name: "Footpath",
    costPerTile: 40,
    description:
      "Paving for people on foot. Patients and visitors walk faster on it than on grass, so lay paths from the pavement to your entrances.",
  },
  {
    id: "road",
    type: FloorType.Road,
    name: "Access road",
    costPerTile: 150,
    description:
      "Tarmac for vehicles, at least 3 tiles wide. Ambulances drive in on it from the public road (lay it across the pavement for a dropped kerb), and an Ambulance Bay can be zoned on it.",
  },
] as const;
export type SurfaceId = (typeof surfaces)[number]["id"];

/** What a tile's surface cost to lay (0 for grass). */
export function surfaceCost(type: number): number {
  if (type === FloorType.Floor) return FOUNDATION_COST_PER_TILE;
  return surfaces.find((s) => s.type === type)?.costPerTile ?? 0;
}

export const walls = [
  {
    type: WallType.Standard,
    name: "Wall",
    costPerTile: 350,
    blocksSight: true,
    description: "Standard partition wall.",
  },
  {
    type: WallType.Glass,
    name: "Glazed wall",
    costPerTile: 900,
    blocksSight: false,
    description: "Blocks movement but not line of sight. Useful for observation.",
  },
];

export const doors = [
  {
    id: "door_single",
    code: 1,
    name: "Door",
    cost: 900,
    width: 1,
    bedAccess: false,
    description: "Single door. Fine for walking patients and wheelchairs.",
  },
  {
    id: "door_double",
    code: 2,
    name: "Double door",
    cost: 2400,
    width: 2,
    bedAccess: true,
    description: "Bed-width double door. Needed wherever beds and trolleys pass.",
  },
];
