/**
 * Escalation (GAME_DESIGN §8.3): the hospital's pressure as an OPEL level
 * (Operational Pressures Escalation Levels, 1 to 4, as NHS trusts report
 * them), and escalation beds. With escalation open, an admitted patient
 * with no ward bed goes to a free escalation trolley in a ward or a
 * corridor rather than waiting on an A&E trolley: corridor care. It frees
 * A&E, but patients on one lose mood rather than settling, and each one
 * there at midnight costs reputation (systems/reputation.ts).
 */
import { equipmentById } from "@data/catalogue";
import type { Patient, Point } from "../agents";
import { holder } from "../places";
import type { PlacedObject, SimState } from "../state";
import { roomOfObject } from "../world/rooms";

export function isEscalationBed(defId: string): boolean {
  return equipmentById.get(defId)?.capabilities.includes("escalation_bed") ?? false;
}

/** Whether a patient is on an escalation trolley. */
export function onEscalationBed(state: SimState, p: Patient): boolean {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  return !!bed && isEscalationBed(bed.defId);
}

/** Escalation trolleys in working wards and corridors, nearest `from` first. */
export function escalationBeds(state: SimState): PlacedObject[] {
  return Object.values(state.objects).filter((o) => {
    if (!isEscalationBed(o.defId)) return false;
    const room = roomOfObject(state, o.id);
    return !!room && room.valid && (room.typeId === "ward" || room.typeId === "corridor");
  });
}

/** A free escalation trolley nearest `from`, if escalation is open. */
export function freeEscalationBeds(state: SimState, from: Point): PlacedObject[] {
  if (!state.policies.escalation) return [];
  const d = (o: PlacedObject) => Math.abs(o.x - from.x) + Math.abs(o.y - from.y);
  return escalationBeds(state)
    .filter((o) => holder(state, o.id, 0) === undefined)
    .sort((a, b) => d(a) - d(b) || a.id - b.id);
}

/** Patients on escalation trolleys now. */
export function patientsInEscalation(state: SimState): number {
  return Object.values(state.patients).filter((p) => !p.death && onEscalationBed(state, p)).length;
}

export interface Opel {
  level: number;
  /** What's driving it, in plain words. */
  drivers: string[];
}

/** Inpatient beds on wards and in side rooms (not escalation trolleys), and how many are taken. */
export function wardBedUse(state: SimState): { beds: number; used: number } {
  let beds = 0;
  let used = 0;
  for (const r of state.rooms) {
    if (!r.valid || (r.typeId !== "ward" && r.typeId !== "side_room")) continue;
    for (const id of r.objectIds) {
      const o = state.objects[id]!;
      const caps = equipmentById.get(o.defId)?.capabilities ?? [];
      if (!caps.includes("inpatient_bed")) continue;
      beds++;
      if (holder(state, id, 0) !== undefined) used++;
    }
  }
  return { beds, used };
}

/**
 * The OPEL level: 1 (steady) to 4 (extreme pressure), from ward bed
 * occupancy, admitted patients waiting in A&E for a bed, ambulances
 * waiting to hand over, and patients in escalation beds.
 */
export function opel(state: SimState): Opel {
  let points = 0;
  const drivers: string[] = [];
  const { beds, used } = wardBedUse(state);
  if (beds > 0) {
    const occ = used / beds;
    if (occ >= 0.98) points += 2;
    else if (occ >= 0.92) points += 1;
    if (occ >= 0.92) drivers.push(`Ward beds ${Math.round(occ * 100)}% full`);
  }
  const waiting = Object.values(state.patients).filter((p) => p.stage === "awaiting_bed").length;
  if (waiting >= 5) points += 2;
  else if (waiting >= 2) points += 1;
  if (waiting >= 2) drivers.push(`${waiting} admitted patients waiting in A&E for a bed`);
  const ambulances = Object.values(state.ambulances).filter((a) => a.phase !== "parked").length;
  if (ambulances >= 3) points += 2;
  else if (ambulances >= 1) points += 1;
  if (ambulances >= 1) drivers.push(`${ambulances} ambulances waiting to hand over`);
  const escalated = patientsInEscalation(state);
  if (escalated > 0) {
    points += 1;
    drivers.push(`${escalated} patients in escalation beds`);
  }
  return { level: 1 + Math.min(3, Math.floor(points / 2)), drivers };
}
