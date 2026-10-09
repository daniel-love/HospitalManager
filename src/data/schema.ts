/**
 * Zod schemas for all content definitions. validateContent() runs at startup
 * (and in tests) so a typo in a data file fails loudly instead of quietly
 * breaking the game.
 */
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9_]+$/, "ids are lower_snake_case");
const code = z.number().int().min(1).max(255);

export const equipmentCategories = [
  "furnishing",
  "bedding",
  "monitoring",
  "diagnostic",
  "treatment",
  "life_support",
  "facilities",
  "decor",
] as const;
export type EquipmentCategory = (typeof equipmentCategories)[number];

export const accessSides = ["front", "back", "sides"] as const;
export type AccessSide = (typeof accessSides)[number];

const accessSchema = z.object({
  side: z.enum(accessSides),
  /** user = patients and visitors; staff = whoever operates the item. */
  who: z.enum(["user", "staff"]),
  /**
   * all: every tile along the side(s) must be clear. either: (only with
   * "sides") one whole side is enough, e.g. a bed may stand against a wall.
   */
  need: z.enum(["all", "either"]).default("all"),
});
export type Access = z.infer<typeof accessSchema>;

export const equipmentDefSchema = z.object({
  id,
  name: z.string().min(1),
  category: z.enum(equipmentCategories),
  /** 1 = basic, 3 = advanced. */
  tier: z.number().int().min(1).max(3),
  /** Purchase price, £. */
  cost: z.number().int().positive(),
  /** Running cost, £ per month (charged hourly). */
  upkeep: z.number().int().nonnegative(),
  /** [width, height] in tiles at rotation 0. */
  footprint: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  /** Chance per day of not breaking down (breakdowns from M6). */
  reliability: z.number().min(0).max(1),
  power: z.boolean(),
  /** What this item lets a room do. A room's capabilities are the union. */
  capabilities: z.array(id),
  /** Seats provided, for seating requirements. */
  seats: z.number().int().positive().optional(),
  /** 1–3 character label drawn on the item until real sprites exist. */
  glyph: z.string().min(1).max(3),
  /**
   * Sides that must stay clear so the item can be used, and by whom. Every
   * tile along a listed side must be standable. At rotation 0 the front faces
   * down; "sides" means both edges at right angles to the front. Defaults to
   * users (patients, visitors) at the front. Empty for symmetric items like
   * plants, which can go anywhere.
   */
  access: z.array(accessSchema).default([{ side: "front", who: "user", need: "all" }]),
  /**
   * floor: stands on the floor and blocks the tile. wall: hangs on a wall
   * (its back must be against one), e.g. oxygen outlets and monitors. ceiling:
   * e.g. curtain tracks. Mounted items take no floor space, so people can
   * stand beneath them and floor items can share their tile.
   */
  mount: z.enum(["floor", "wall", "ceiling"]).default("floor"),
  description: z.string(),
});
export type EquipmentDef = z.infer<typeof equipmentDefSchema>;
/** EquipmentDef as written in data files, before defaults are applied. */
export type EquipmentInput = z.input<typeof equipmentDefSchema>;

export const doorDefSchema = z.object({
  id,
  /** Stored in FloorGrid.door. Never renumber: saves depend on it. */
  code,
  name: z.string().min(1),
  cost: z.number().int().positive(),
  /** Tiles along the wall. */
  width: z.union([z.literal(1), z.literal(2)]),
  /** Wide enough for beds and trolleys. */
  bedAccess: z.boolean(),
  description: z.string(),
});
export type DoorDef = z.infer<typeof doorDefSchema>;

export const wallDefSchema = z.object({
  /** WallType value stored in FloorGrid.wall. */
  type: code,
  name: z.string().min(1),
  costPerTile: z.number().int().positive(),
  blocksSight: z.boolean(),
  description: z.string(),
});
export type WallDef = z.infer<typeof wallDefSchema>;

export const roomRequirementSchema = z.object({
  /** Checklist label, e.g. "Examination couch". */
  label: z.string().min(1),
  /** Any of these equipment ids satisfies the requirement. */
  anyOf: z.array(id).min(1),
  count: z.number().int().positive().default(1),
});
export type RoomRequirement = z.infer<typeof roomRequirementSchema>;

/** Departments a room can belong to. "Any" rooms serve every department. */
export const roomDepartments = [
  "A&E",
  "Inpatient",
  "General",
  "Any",
  "Facilities",
  "Support",
  "Staff",
] as const;
export type RoomDepartment = (typeof roomDepartments)[number];

export const roomDefSchema = z.object({
  id,
  /** Stored in FloorGrid.zone. Never renumber: saves depend on it. */
  code,
  name: z.string().min(1),
  department: z.enum(roomDepartments),
  /** Zone tint, 0xRRGGBB. */
  colour: z.number().int().min(0).max(0xffffff),
  /** Minimum [width, height] in tiles, in either orientation. */
  minSize: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  /** Must be fully bounded by walls and doors, with at least one door. */
  enclosed: z.boolean(),
  /**
   * Patients may walk through it on the way somewhere else (corridors,
   * waiting areas). Other rooms they only enter as their destination or
   * leave as their starting point, and never by a door straight outside.
   */
  publicRoute: z.boolean().default(false),
  /** Can be zoned on the player's access road as well as on foundations (outdoor hardstanding). */
  onRoad: z.boolean().default(false),
  required: z.array(roomRequirementSchema),
  minSeats: z.number().int().positive().optional(),
  /**
   * Every bed or trolley in the room needs clear space on both long sides
   * (Majors, Resus), not just the one side the item itself requires.
   */
  bothBedSides: z.boolean().default(false),
  /**
   * Patients here are seriously unwell: every bed should be in sight of a
   * staffed nurse station (GAME_DESIGN §7). Shown by the coverage overlay.
   */
  observed: z.boolean().default(false),
  /**
   * Room types this room must open onto: touching with no wall between, or
   * joined by a door. E.g. reception must lead straight into a waiting area.
   */
  connectedTo: z.array(z.object({ roomType: id, label: z.string().min(1) })).default([]),
  description: z.string(),
});
export type RoomDef = z.infer<typeof roomDefSchema>;
/** RoomDef as written in data files, before defaults are applied. */
export type RoomInput = z.input<typeof roomDefSchema>;

export const capabilityComboSchema = z.object({
  /** Granted to a room that has every capability in `requires`. */
  capability: id,
  requires: z.array(id).min(2),
});
export type CapabilityCombo = z.infer<typeof capabilityComboSchema>;

export const staffRoleIds = [
  "receptionist",
  "nurse",
  "nurse_practitioner",
  "junior_doctor",
  "porter",
  "cleaner",
  "medical_examiner",
] as const;
export type StaffRoleId = (typeof staffRoleIds)[number];

/** How staff are grouped when hiring and listing them, in display order. */
export const staffGroups = ["medical", "nursing", "support", "admin"] as const;
export type StaffGroup = (typeof staffGroups)[number];

export const staffRoleSchema = z.object({
  id: z.enum(staffRoleIds),
  name: z.string().min(1),
  /** Plural label for filters, e.g. "Nurses". */
  short: z.string().min(1),
  group: z.enum(staffGroups),
  /** Annual cost to the hospital, £: salary plus employer NI and pension. */
  annualCost: z.number().int().positive(),
  description: z.string(),
});
export type StaffRoleDef = z.infer<typeof staffRoleSchema>;

/** [min, max] minutes; each patient gets a random duration in the range. */
const minutesRange = z
  .tuple([z.number().positive(), z.number().positive()])
  .refine(([a, b]) => a <= b, "min must not exceed max");

export const pathwayStepSchema = z.object({
  /** Shown in the patient timeline, e.g. "Wound closure". */
  name: z.string().min(1),
  /**
   * Roles that can do this step, most preferred first: the job goes to a free
   * member of the earliest listed role, the nearest if there are several.
   */
  roles: z.array(z.enum(staffRoleIds)).min(1),
  /** Room type the step happens in. The room must be valid. */
  room: id,
  /** Extra capabilities the room needs for this step, beyond being valid. */
  capabilities: z.array(id).default([]),
  mins: minutesRange,
  /**
   * Completing this step treats whatever was making the patient deteriorate
   * (e.g. antibiotics and fluids for sepsis), so they no longer will.
   */
  stabilises: z.boolean().default(false),
});
export type PathwayStep = z.infer<typeof pathwayStepSchema>;

export const conditionDefSchema = z.object({
  id,
  name: z.string().min(1),
  /** Manchester Triage category: 1 Immediate … 5 Non-urgent. */
  acuity: z.number().int().min(1).max(5),
  /** Relative arrival weights per channel. */
  channels: z.object({
    walk_in: z.number().nonnegative(),
    ambulance: z.number().nonnegative().default(0),
  }),
  /** Income on discharge, £ (NHS tariff for the attendance). */
  tariff: z.number().int().nonnegative(),
  /** Treatment after triage, in order. The outcome follows the last step. */
  pathway: z.array(pathwayStepSchema).min(1),
  /**
   * After the last step: home, or (for the sickest) a transfer to intensive
   * care. Ward admissions come later in M3.
   */
  outcome: z.enum(["discharge", "icu"]).default("discharge"),
  /**
   * Chance the doctor decides to admit them to a ward after the last step
   * (instead of the outcome above), how long they stay, and the NHS tariff
   * for the inpatient stay.
   */
  admission: z
    .object({
      chance: z.number().min(0).max(1),
      stayHours: z
        .tuple([z.number().positive(), z.number().positive()])
        .refine(([a, b]) => a <= b, "min must not exceed max"),
      tariff: z.number().int().nonnegative(),
      /**
       * Share of admissions who are dying and admitted for end-of-life care.
       * They should have a side room, and die (expectedly) on the ward.
       */
      endOfLife: z.number().min(0).max(1).default(0),
    })
    .optional(),
  /**
   * How closely they must be watched after triage (GAME_DESIGN §7). periodic:
   * a nurse does observations every so often. continuous: observations more
   * often, and on a trolley they should be in sight of a staffed nurse station.
   */
  monitoring: z.enum(["none", "periodic", "continuous"]).default("none"),
  /**
   * Some patients get worse before they're treated. `chance` of it happening;
   * warning signs start `onsetMins` after arrival, and if nobody notices,
   * they collapse `warningMins` after that. A `stabilises` step stops it.
   */
  deterioration: z
    .object({
      chance: z.number().min(0).max(1),
      onsetMins: minutesRange,
      warningMins: minutesRange,
    })
    .optional(),
  description: z.string(),
});
export type ConditionDef = z.infer<typeof conditionDefSchema>;
export type ConditionInput = z.input<typeof conditionDefSchema>;

export interface Content {
  equipment: readonly unknown[];
  doors: readonly unknown[];
  walls: readonly unknown[];
  rooms: readonly unknown[];
  capabilityCombos: readonly unknown[];
  staffRoles: readonly unknown[];
  conditions: readonly unknown[];
}

export interface ValidContent {
  equipment: EquipmentDef[];
  doors: DoorDef[];
  walls: WallDef[];
  rooms: RoomDef[];
  capabilityCombos: CapabilityCombo[];
  staffRoles: StaffRoleDef[];
  conditions: ConditionDef[];
}

function uniqueBy<T>(items: T[], key: (t: T) => unknown, what: string, issues: string[]): void {
  const seen = new Set<unknown>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) issues.push(`duplicate ${what}: ${String(k)}`);
    seen.add(k);
  }
}

/** Parses every definition and checks cross-references. Throws listing all problems. */
export function validateContent(raw: Content): ValidContent {
  const content: ValidContent = {
    equipment: z.array(equipmentDefSchema).parse(raw.equipment),
    doors: z.array(doorDefSchema).parse(raw.doors),
    walls: z.array(wallDefSchema).parse(raw.walls),
    rooms: z.array(roomDefSchema).parse(raw.rooms),
    capabilityCombos: z.array(capabilityComboSchema).parse(raw.capabilityCombos),
    staffRoles: z.array(staffRoleSchema).parse(raw.staffRoles),
    conditions: z.array(conditionDefSchema).parse(raw.conditions),
  };

  const issues: string[] = [];
  uniqueBy([...content.equipment, ...content.doors], (d) => d.id, "object id", issues);
  uniqueBy(content.doors, (d) => d.code, "door code", issues);
  uniqueBy(content.walls, (w) => w.type, "wall type", issues);
  uniqueBy(content.rooms, (r) => r.id, "room id", issues);
  uniqueBy(content.rooms, (r) => r.code, "room code", issues);
  uniqueBy(content.staffRoles, (r) => r.id, "staff role", issues);
  uniqueBy(content.conditions, (c) => c.id, "condition id", issues);
  for (const role of staffRoleIds) {
    if (!content.staffRoles.some((r) => r.id === role))
      issues.push(`no definition for role ${role}`);
  }

  for (const e of content.equipment) {
    uniqueBy(e.access, (a) => a.side, `access side on ${e.id}`, issues);
    if (e.mount !== "floor" && e.access.length > 0) {
      issues.push(`${e.id}: mounted items take no floor space, so can't have access sides`);
    }
    for (const a of e.access) {
      if (a.need === "either" && a.side !== "sides") {
        issues.push(`${e.id}: "either" only applies to "sides"`);
      }
    }
  }

  const roomIds = new Set(content.rooms.map((r) => r.id));
  for (const room of content.rooms) {
    for (const c of room.connectedTo) {
      if (!roomIds.has(c.roomType))
        issues.push(`room ${room.id} connects to unknown ${c.roomType}`);
    }
  }

  const equipmentIds = new Set(content.equipment.map((e) => e.id));
  for (const room of content.rooms) {
    for (const req of room.required) {
      for (const ref of req.anyOf) {
        if (!equipmentIds.has(ref)) issues.push(`room ${room.id} requires unknown item ${ref}`);
      }
    }
  }
  const granted = new Set(content.equipment.flatMap((e) => e.capabilities));
  for (const combo of content.capabilityCombos) {
    for (const cap of combo.requires) {
      if (!granted.has(cap)) issues.push(`combo ${combo.capability} needs ungranted ${cap}`);
    }
  }

  // Combos can be required too (e.g. "resuscitation" for Resus steps).
  for (const combo of content.capabilityCombos) granted.add(combo.capability);
  for (const c of content.conditions) {
    for (const step of c.pathway) {
      if (!roomIds.has(step.room)) issues.push(`condition ${c.id} uses unknown room ${step.room}`);
      for (const cap of step.capabilities) {
        if (!granted.has(cap)) issues.push(`condition ${c.id} needs ungranted ${cap}`);
      }
    }
    if (c.deterioration && !c.pathway.some((s) => s.stabilises)) {
      issues.push(`condition ${c.id} can deteriorate but no step stabilises it`);
    }
  }

  if (issues.length > 0) throw new Error(`Invalid game content:\n  ${issues.join("\n  ")}`);
  return content;
}
