/**
 * Building fabric: floor (foundations), walls and doors. Costs are rough UK
 * new-build figures per 1 m tile.
 */
import { FloorType, WallType } from "@sim/world/grid";

/** Turning a grass tile into buildable interior floor (slab, services, finish). */
export const FOUNDATION_COST_PER_TILE = 1200;

/** Storeys a hospital can have: the ground floor and two above it. */
export const MAX_FLOORS = 3;
/** An upper floor's slab on its supporting frame costs this much more than ground-floor foundations. */
export const UPPER_FLOOR_COST_FACTOR = 1.5;
/** Longest gap (tiles) a first-floor link bridge may span between supported floor at each end. */
export const BRIDGE_MAX_SPAN = 8;
/** A link bridge (a glazed, enclosed footbridge) costs this much more per tile than foundations. */
export const BRIDGE_COST_FACTOR = 3;

/**
 * A flight of stairs is as long a walk as this many tiles of corridor per
 * floor (it's slower going, and there are landings), at walking speed.
 */
export const STAIRS_TILES_PER_FLOOR = 15;

/** Bed lifts (systems/portals.ts). Times in ticks, scaled like walking (see PATIENT_SPEED). */
export const LIFT = {
  /** Spaces in the car: a person takes 1. */
  capacity: 8,
  /** A bed or trolley with whoever pushes it (leaving room for two more). */
  bedLoad: 6,
  /** Doors open, people getting on and off. */
  doorTicks: 8,
  /** Travelling one floor. */
  ticksPerFloor: 6,
};

/**
 * Choosing between stairs and a lift, as tiles of walking each is worth.
 * Staff take the stairs for a floor or two; walking patients and visitors
 * prefer the lift unless its queue is long; beds always take the lift.
 */
export const PORTAL_CHOICE = {
  /** Calling a lift and riding it, before anyone else in the queue. */
  liftTiles: 10,
  liftTilesPerFloor: 4,
  /** Each person already waiting for that lift on your floor. */
  liftTilesPerWaiter: 4,
  /** Staff would rather not wait for a lift. */
  staffLiftTiles: 25,
  /** Patients and visitors find stairs this much harder going. */
  publicStairsFactor: 2,
};

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
    solid: true,
    description: "Standard partition wall.",
  },
  {
    type: WallType.Glass,
    name: "Glazed wall",
    costPerTile: 900,
    blocksSight: false,
    solid: true,
    description: "Blocks movement but not line of sight. Useful for observation.",
  },
  {
    type: WallType.Lead,
    name: "Lead-lined wall",
    costPerTile: 1400,
    blocksSight: true,
    solid: true,
    description:
      "A wall with lead sheet in it, for radiation protection. X-ray and CT rooms must be enclosed by it (doors are lead-lined too). Draw it over existing walls to upgrade them.",
  },
  {
    type: WallType.Curtain,
    name: "Curtain divider",
    costPerTile: 150,
    blocksSight: true,
    solid: false,
    description:
      "Ceiling-track curtain between neighbouring bays, as in most open-plan Majors areas. Separates bays and screens patients, but takes no doors or wall fixtures, and a room that must be enclosed needs real walls.",
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
