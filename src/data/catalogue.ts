/**
 * Validated content plus lookup tables. Import definitions from here rather
 * than from the raw data files so everything has been through Zod.
 */
import { conditions } from "./conditions";
import { capabilityCombos, equipment } from "./equipment";
import { rooms } from "./rooms";
import type {
  ConditionDef,
  DoorDef,
  EquipmentDef,
  RoomDef,
  StaffRoleDef,
  StaffRoleId,
  WallDef,
} from "./schema";
import { validateContent } from "./schema";
import { staffRoles } from "./staff";
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
