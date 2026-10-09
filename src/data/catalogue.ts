/**
 * Validated content plus lookup tables. Import definitions from here rather
 * than from the raw data files so everything has been through Zod.
 */
import { conditions } from "./conditions";
import { capabilityCombos, equipment, EQUIPMENT_CATEGORY_NAMES } from "./equipment";
import { ROOM_GROUP_NAMES, ROOM_GROUP_OF, roomGroups, rooms } from "./rooms";
import type {
  ConditionDef,
  DoorDef,
  EquipmentDef,
  RoomDef,
  StaffRoleDef,
  StaffRoleId,
  WallDef,
} from "./schema";
import { equipmentCategories, staffGroups, validateContent } from "./schema";
import { STAFF_GROUP_NAMES, staffRoles } from "./staff";
import { doors, walls } from "./structures";

export const content = validateContent({
  equipment,
  doors,
  walls,
  rooms,
  capabilityCombos,
  staffRoles,
  conditions,
});

export const equipmentById = new Map<string, EquipmentDef>(content.equipment.map((e) => [e.id, e]));
export const doorById = new Map<string, DoorDef>(content.doors.map((d) => [d.id, d]));
export const doorByCode = new Map<number, DoorDef>(content.doors.map((d) => [d.code, d]));
export const wallByType = new Map<number, WallDef>(content.walls.map((w) => [w.type, w]));
export const roomById = new Map<string, RoomDef>(content.rooms.map((r) => [r.id, r]));
export const roomByCode = new Map<number, RoomDef>(content.rooms.map((r) => [r.code, r]));
export const conditionById = new Map<string, ConditionDef>(
  content.conditions.map((c) => [c.id, c]),
);
export const staffRoleById = new Map<StaffRoleId, StaffRoleDef>(
  content.staffRoles.map((r) => [r.id, r]),
);

/**
 * What to put in a room to give it a capability, for messages: one item per
 * part of a combination, e.g. ["Defibrillator", "Resus trolley"].
 */
export function equipmentNamesFor(capability: string): string[] {
  const combo = content.capabilityCombos.find((c) => c.capability === capability);
  if (combo) return combo.requires.flatMap(equipmentNamesFor);
  const item = content.equipment.find((e) => e.capabilities.includes(capability));
  return [item?.name ?? capability];
}

/** Extra equipment a room type needs for some conditions (see conditionEquipment). */
export interface ConditionEquipment {
  capability: string;
  /** What to put in the room, e.g. ["ECG (12-lead)"]. */
  items: string[];
  /** Conditions that need it here, e.g. ["Chest pain"]. */
  conditions: string[];
}

/**
 * Equipment a room type needs beyond being valid, for the conditions whose
 * pathway steps use it there: e.g. a Majors Bay needs an ECG (12-lead) for
 * chest pain. Leaves out anything the room's own requirements already
 * guarantee (a Majors Bay always has oxygen).
 */
export function conditionEquipment(roomType: string): ConditionEquipment[] {
  const def = roomById.get(roomType);
  if (!def) return [];
  const guaranteed = (cap: string): boolean => {
    const combo = content.capabilityCombos.find((c) => c.capability === cap);
    if (combo) return combo.requires.every(guaranteed);
    return def.required.some((req) =>
      req.anyOf.every((id) => equipmentById.get(id)?.capabilities.includes(cap)),
    );
  };
  const byCap = new Map<string, Set<string>>();
  for (const c of content.conditions) {
    for (const step of c.pathway) {
      if (step.room !== roomType) continue;
      for (const cap of step.capabilities) {
        if (guaranteed(cap)) continue;
        if (!byCap.has(cap)) byCap.set(cap, new Set());
        byCap.get(cap)!.add(c.name);
      }
    }
  }
  return [...byCap].map(([capability, names]) => ({
    capability,
    items: equipmentNamesFor(capability),
    conditions: [...names],
  }));
}

/** "Junior Doctor or Emergency Nurse Practitioner"; plural: "Junior Doctors or …". */
export function roleNames(roles: readonly StaffRoleId[], plural = false): string {
  const names = roles.map((r) => (staffRoleById.get(r)?.name ?? r) + (plural ? "s" : ""));
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Anything that can be placed as an object: equipment or a door. */
export type ObjectDef = { kind: "equipment"; def: EquipmentDef } | { kind: "door"; def: DoorDef };

export function objectDef(defId: string): ObjectDef | undefined {
  const e = equipmentById.get(defId);
  if (e) return { kind: "equipment", def: e };
  const d = doorById.get(defId);
  if (d) return { kind: "door", def: d };
  return undefined;
}

/** Footprint [w, h] at rotation 0. Doors lie along the x axis. */
export function baseFootprint(o: ObjectDef): [number, number] {
  return o.kind === "equipment" ? o.def.footprint : [o.def.width, 1];
}

/**
 * A titled section of a list (the Hire panel, the build palettes). Sections
 * come from each definition's group, in a fixed order, so new content always
 * lands under the right heading; empty sections are left out.
 */
export interface Section<T> {
  id: string;
  name: string;
  items: T[];
}

function sections<G extends string, T>(
  order: readonly G[],
  names: Record<G, string>,
  items: readonly T[],
  groupOf: (item: T) => G,
): Section<T>[] {
  return order
    .map((g) => ({ id: g, name: names[g], items: items.filter((i) => groupOf(i) === g) }))
    .filter((s) => s.items.length > 0);
}

/** Staff roles by group: medical, nursing, support services, administrative. */
export function staffRoleSections(): Section<StaffRoleDef>[] {
  return sections(staffGroups, STAFF_GROUP_NAMES, content.staffRoles, (r) => r.group);
}

/** Room types by palette section (A&E, wards, shared spaces…). */
export function roomSections(): Section<RoomDef>[] {
  return sections(roomGroups, ROOM_GROUP_NAMES, content.rooms, (r) => ROOM_GROUP_OF[r.department]);
}

/** Equipment by category. */
export function equipmentSections(): Section<EquipmentDef>[] {
  return sections(
    equipmentCategories,
    EQUIPMENT_CATEGORY_NAMES,
    content.equipment,
    (e) => e.category,
  );
}
