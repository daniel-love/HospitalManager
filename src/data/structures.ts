/**
 * Building fabric: floor (foundations), walls and doors. Costs are rough UK
 * new-build figures per 1 m tile.
 */
import { WallType } from "@sim/world/grid";

/** Turning a grass tile into buildable interior floor (slab, services, finish). */
export const FOUNDATION_COST_PER_TILE = 1200;

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
