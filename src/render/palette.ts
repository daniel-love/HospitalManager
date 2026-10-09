/** Programmer-art colours, until a sprite atlas replaces them (M7). */
import type { EquipmentDef, StaffRoleId } from "@data/schema";

export const GRASS_SHADES = [0x5a8f3c, 0x5e9440, 0x578b39] as const;
export const FLOOR_COLOUR = 0xd9d4c7;
/** The council's pavement: grey concrete slabs. */
export const PATH_COLOUR = 0xb3b0a8;
/** The player's footpaths: warmer block paving, so they stand out from the pavement. */
export const FOOTPATH_COLOUR = 0xc8bca2;
export const KERB_COLOUR = 0x7f7c75;
export const ROAD_COLOUR = 0x4a4d52;
/** A dropped kerb: tarmac across the pavement, a little lighter than the road. */
export const DROPPED_KERB_COLOUR = 0x63666b;
export const ROAD_MARKING = 0xe8e8e2;
/** Yellow box markings on an Ambulance Bay. */
export const BAY_MARKING = 0xf2c230;
export const BUS_STOP_RED = 0xd8322e;
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

/**
 * Staff uniforms (GAME_DESIGN §11), loosely NHS: nurses in blue, senior nurses
 * (nurse practitioners) in navy, doctors in maroon scrubs, reception in grey-purple, domestic staff in green.
 */
export const ROLE_COLOURS: Record<StaffRoleId, number> = {
  receptionist: 0x8a7fb8,
  nurse: 0x2f6fd8,
  nurse_practitioner: 0x16255c,
  junior_doctor: 0x9c2d4a,
  porter: 0x4a5568,
  medical_examiner: 0x5b3a7a,
  cleaner: 0x3f9a6a,
};

/** Patients wear white until triaged, then show their triage colour as a ring. */
export const PATIENT_COLOUR = 0xf4f1ea;
export const UNTRIAGED_RING = 0x8a929c;
export const SELECTED_RING = 0xffe066;

/** Coverage overlay (GAME_DESIGN §7): beds watched, in sight of an empty station, or out of sight. */
export const COVER_COLOURS = {
  watched: 0x4cbb5a,
  remote: 0x2fb5b5,
  unstaffed: 0xf0a830,
  blind: 0xe0504a,
} as const;
/** Floor a nurse station can see. */
export const COVER_SEEN = 0x5cb8e6;

/** Patient markers: getting worse (amber) and cardiac arrest (red). */
export const DETERIORATING_MARK = 0xf0a830;
export const ARREST_MARK = 0xe0504a;

/** UK ambulance livery (Battenburg yellow and green) and paramedic green. */
export const AMBULANCE_YELLOW = 0xf2d81a;
export const AMBULANCE_GREEN = 0x2f8f4e;
export const PARAMEDIC_COLOUR = 0x1f6b3a;
