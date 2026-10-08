/** Programmer-art colours, until a sprite atlas replaces them (M7). */
import type { EquipmentDef } from "@data/schema";

export const GRASS_SHADES = [0x5a8f3c, 0x5e9440, 0x578b39] as const;
export const FLOOR_COLOUR = 0xd9d4c7;
export const WALL_COLOUR = 0x3b4048;
export const GLASS_COLOUR = 0x9fd3e6;
export const DOOR_COLOUR = 0x9a6a3a;
export const ZONE_ALPHA = 0.32;

export const CATEGORY_COLOURS: Record<EquipmentDef["category"], number> = {
  furnishing: 0xb08d6a,
  bedding: 0xeef0f5,
  monitoring: 0x5cb8e6,
  diagnostic: 0x8f7ee6,
  treatment: 0x4fc4a0,
  life_support: 0xe05a5a,
  facilities: 0xc9d6df,
  decor: 0x6abf5a,
};

/** Marks the side of an item that staff work from (NHS-ish blue). */
export const STAFF_COLOUR = 0x2f7fd8;

/** Plan mode blueprint tints. */
export const PLAN_ADDED = 0x3d8bfd;
export const PLAN_REMOVED = 0xe0504a;

export const GHOST_OK = 0x5ad17a;
export const GHOST_BAD = 0xe0504a;
export const GHOST_REMOVE = 0xe0a040;
