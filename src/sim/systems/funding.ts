/**
 * NHS funding (GAME_DESIGN §2.2): the block contract for emergency care.
 * Commissioners pay a fixed share (NHS_FUNDING.blockShare) of the expected
 * value of the emergency care the hospital is equipped to provide for its
 * catchment: the A&E attendances it can treat, and the emergency admissions
 * and operations that follow where it has a ward, the specialty's doctors
 * and theatres. Each patient then earns the rest of their tariff when
 * treated (finance.ts earnEmergency). The block is sized to the rooms and
 * ward beds there are to do the work, capped at a margin over the care
 * actually delivered lately (commissioners claw back the rest), and paid as a daily share at
 * midnight, from what the hospital can do then, so building a service
 * raises it from the next day, and closing one lowers it.
 */
import { content } from "@data/catalogue";
import { NHS_FUNDING } from "@data/economy";
import type { ConditionDef, SpecialtyId } from "@data/schema";
import type { SimState } from "../state";
import { parkingSpaces } from "./ambulances";
import { dailyDemand, treatableConditions } from "./arrivals";
import { cantOperate } from "./theatres";
import { MINUTES_PER_DAY } from "../time";

/** A consultant or registrar of the specialty on the hospital's books (not bank or agency). */
function hasOwnTeam(state: SimState, specialty: SpecialtyId): boolean {
  return Object.values(state.staff).some(
    (s) =>
      s.specialty === specialty &&
      (s.role === "consultant" || s.role === "registrar") &&
      (s.contract === "resident" || s.contract === "on_call"),
  );
}

/** Whether the hospital could admit this condition: a ward and its specialty's doctors. */
function canAdmit(state: SimState, c: ConditionDef, ward: boolean): boolean {
  return !!c.admission && !!c.specialty && ward && hasOwnTeam(state, c.specialty);
}

/** An admission's value at full tariff: the stay, plus any emergency operation it can do. */
function admissionValue(state: SimState, c: ConditionDef): number {
  const a = c.admission!;
  let value = a.tariff;
  const op = a.operation;
  if (op && cantOperate(state, op.specialty ?? c.specialty!) === null) {
    value += op.chance * op.tariff;
  }
  return value;
}

/** Inpatient beds on wards and in side rooms. */
function wardBeds(state: SimState): number {
  let beds = 0;
  for (const r of state.rooms) {
    if (!r.valid || (r.typeId !== "ward" && r.typeId !== "side_room")) continue;
    for (const id of r.objectIds) {
      const d = state.objects[id]?.defId;
      if (d === "hospital_bed" || d === "profiling_bed") beds++;
    }
  }
  return beds;
}

/**
 * The expected full-tariff value of a day's emergency care the hospital can
 * provide. Commissioners pay for activity a hospital can deliver, so it's
 * the catchment's patients with conditions it can treat, as far as its
 * rooms have time for them (each condition by its busiest room), and the
 * emergency admissions (and operations) that follow, as far as its ward
 * beds can take them at the average length of stay.
 */
export function emergencyValuePerDay(state: SimState): number {
  // A closed A&E provides none; on divert, none for ambulances.
  if (state.departments.ae === "closed") return 0;
  const demand = dailyDemand(state);
  const treatable = treatableConditions(state);
  const ward = state.rooms.some((r) => r.valid && r.typeId === "ward");
  const ambulances = parkingSpaces(state).length > 0 && state.departments.ae !== "divert";
  // Patients a day with each condition.
  const perDay = new Map<ConditionDef, number>();
  for (const ch of ["walk_in", "ambulance"] as const) {
    if (ch === "ambulance" && !ambulances) continue;
    const all = content.conditions.reduce((n, c) => n + c.channels[ch], 0);
    if (all === 0) continue;
    const arrivals = ch === "walk_in" ? demand.walkIns : demand.ambulances;
    for (const c of treatable) {
      perDay.set(c, (perDay.get(c) ?? 0) + (arrivals * c.channels[ch]) / all);
    }
  }
  // Room time they'd need, against the room time there is.
  const needed = new Map<string, number>();
  for (const [c, n] of perDay) {
    for (const step of c.pathway) {
      const mins = ((step.mins[0] + step.mins[1]) / 2) * step.chance;
      needed.set(
        step.room,
        (needed.get(step.room) ?? 0) + n * mins * NHS_FUNDING.roomOccupancyPerTreatment,
      );
    }
  }
  const roomShare = new Map<string, number>();
  for (const [room, mins] of needed) {
    const rooms = state.rooms.filter((r) => r.valid && r.typeId === room).length;
    const available = rooms * MINUTES_PER_DAY * NHS_FUNDING.roomUtilisation;
    roomShare.set(room, Math.min(1, available / mins));
  }

  let attendances = 0;
  let admissions = 0;
  let admissionValueSum = 0;
  let bedHours = 0;
  for (const [c, all] of perDay) {
    const n = all * Math.min(...c.pathway.map((s) => roomShare.get(s.room) ?? 0));
    attendances += n * c.tariff;
    if (!canAdmit(state, c, ward)) continue;
    const a = c.admission!;
    const admitted = n * a.chance;
    admissions += admitted;
    admissionValueSum += admitted * admissionValue(state, c);
    bedHours += admitted * ((a.stayHours[0] + a.stayHours[1]) / 2);
  }
  if (admissions === 0) return attendances;
  // Ward beds turn over once per average stay.
  const capacity = (wardBeds(state) * 24) / (bedHours / admissions);
  return attendances + admissionValueSum * Math.min(1, capacity / admissions);
}

/**
 * The full-tariff value of the emergency care actually done a day, on
 * average over the last few weeks (from the marginal tariff earned), or
 * null with too little history yet.
 */
export function deliveredValuePerDay(state: SimState): number | null {
  const days = state.history.slice(-NHS_FUNDING.activityDays);
  if (days.length < NHS_FUNDING.activityGraceDays) return null;
  const marginal = days.reduce((n, d) => n + d.ledger.tariff, 0) / days.length;
  return marginal / (1 - NHS_FUNDING.blockShare);
}

/**
 * Today's share of the block contract, £: a share of the emergency care the
 * hospital is equipped to provide, but no more than a margin over what it's
 * actually been doing.
 */
export function dailyBlock(state: SimState): number {
  // A Private Hospital has no NHS emergency contract.
  if (state.funding === "private") return 0;
  let value = emergencyValuePerDay(state);
  const delivered = deliveredValuePerDay(state);
  if (delivered !== null) value = Math.min(value, delivered * NHS_FUNDING.activityTolerance);
  return value * NHS_FUNDING.blockShare;
}
