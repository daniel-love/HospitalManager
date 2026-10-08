/**
 * Validated content plus lookup tables. Import definitions from here rather
 * than from the raw data files so everything has been through Zod.
 */
import { capabilityCombos, equipment } from "./equipment";
import { rooms } from "./rooms";
import type { DoorDef, EquipmentDef, RoomDef, WallDef } from "./schema";
import { validateContent } from "./schema";
import { doors, walls } from "./structures";

export const content = validateContent({ equipment, doors, walls, rooms, capabilityCombos });

export const equipmentById = new Map<string, EquipmentDef>(content.equipment.map((e) => [e.id, e]));
export const doorById = new Map<string, DoorDef>(content.doors.map((d) => [d.id, d]));
export const doorByCode = new Map<number, DoorDef>(content.doors.map((d) => [d.code, d]));
export const wallByType = new Map<number, WallDef>(content.walls.map((w) => [w.type, w]));
export const roomById = new Map<string, RoomDef>(content.rooms.map((r) => [r.id, r]));
export const roomByCode = new Map<number, RoomDef>(content.rooms.map((r) => [r.code, r]));

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
