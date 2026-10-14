/**
 * Getting inpatients home (GAME_DESIGN §9, bed blocking). Once the doctor's
 * discharge review says someone is fit to go:
 *
 * - most go home once their medicines and transport are ready, a few hours
 *   later: in their bed, or (while the Discharge Lounge is open and has a
 *   free seat) in the lounge, freeing the bed at once;
 * - some need social care to go home (a package of care, a care home
 *   place). It takes days to arrange once asked for, longer in a
 *   social-care crisis, and they keep their ward bed until it's in place:
 *   a delayed discharge. A Discharge Coordinator asks for it as soon as
 *   they're admitted, so the wait runs alongside their treatment; without
 *   one, a ward nurse asks only once they're fit, and the whole wait
 *   comes after.
 */
import { CARE_NEED, DISCHARGE } from "@data/discharge";
import { pressureEventById } from "@data/pressure";
import type { DischargePlan, Patient } from "../agents";
import { freeSeat, reserve, seatApproach, seatTile } from "../places";
import { nextFloat } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, TICKS_PER_MINUTE } from "../time";
import { dirtyCouch, jobsForPatient, postJob, ticksFor } from "./jobBoard";
import { headTo } from "./movement";
import { leave } from "./patients";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/** On arrival on the ward: whether they'll need care, and how long it'll take to arrange. */
export function planDischarge(state: SimState, p: Patient): DischargePlan {
  const share = CARE_NEED[p.conditionId] ?? DISCHARGE.otherCareNeed;
  const needsCare = nextFloat(state.rng) < share;
  const { min, mean, max } = DISCHARGE.careDelayDays;
  const days = Math.min(max, min - Math.log(1 - nextFloat(state.rng)) * mean);
  const plan: DischargePlan = {
    needsCare,
    careHours: Math.round(days * 24),
    planned: null,
    careReady: null,
    fit: null,
    goAt: null,
  };
  p.discharge = plan;
  // A discharge coordinator plans from the day they're admitted.
  if (needsCare && hasCoordinator(state)) postPlanning(state, p, false);
  return plan;
}

function hasCoordinator(state: SimState): boolean {
  return Object.values(state.staff).some((s) => s.role === "discharge_coordinator");
}

/** Asking social care for a care package or placement: coordinators first, then (once fit) nurses. */
function postPlanning(state: SimState, p: Patient, nurses: boolean): void {
  for (const j of jobsForPatient(state, p.id)) {
    if (j.kind !== "discharge_planning") continue;
    if (nurses && !j.roles.includes("nurse") && j.state === "open") j.roles.push("nurse");
    return;
  }
  postJob(state, {
    kind: "discharge_planning",
    roles: nurses ? ["discharge_coordinator", "nurse"] : ["discharge_coordinator"],
    patientId: p.id,
    roomType: "",
    // Behind urgent clinical work.
    dueTick: state.tick + 2 * TICKS_PER_HOUR,
    durationTicks: ticksFor(state.rng, DISCHARGE.planningMins),
  });
}

/** How much longer social care takes now: a crisis multiplies it. */
export function careDelayFactor(state: SimState): number {
  let f = 1;
  for (const e of state.pressure.active) {
    const m = pressureEventById.get(e.defId)!.careDelay;
    if (m && state.tick >= e.start && state.tick < e.end) f *= m;
  }
  return f;
}

/** The planning is done: social care is asked, and will be in place this long from now. */
export function dischargePlanned(state: SimState, p: Patient): void {
  const d = p.discharge;
  if (!d) return;
  d.planned = state.tick;
  d.careReady = state.tick + Math.round(d.careHours * careDelayFactor(state)) * TICKS_PER_HOUR;
}

/** The doctor's review: fit to go. Now it's medicines, transport and (for some) care. */
export function fitForDischarge(state: SimState, p: Patient, bed: number): void {
  const d = p.discharge ?? planDischarge(state, p);
  d.fit = state.tick;
  if (d.needsCare && d.planned === null) postPlanning(state, p, true);
  const [lo, hi] = DISCHARGE.goHomeHours;
  d.goAt = state.tick + Math.round((lo + (hi - lo) * nextFloat(state.rng)) * TICKS_PER_HOUR);
  if (!d.needsCare) toLounge(state, p, bed);
}

/** A delayed discharge: fit to go, ready but for social care, and still in a ward bed. */
export function delayedDischarge(state: SimState, p: Patient): boolean {
  const d = p.discharge;
  return (
    p.stage === "on_ward" &&
    !!d?.needsCare &&
    d.fit !== null &&
    state.tick >= (d.goAt ?? 0) &&
    (d.careReady === null || state.tick < d.careReady)
  );
}

function loungeOpen(state: SimState): boolean {
  const { hour } = clockFromTick(state.tick);
  return hour >= DISCHARGE.loungeOpens && hour < DISCHARGE.loungeCloses;
}

/** Into the discharge lounge, if it's open with a free seat: their bed is free at once. */
function toLounge(state: SimState, p: Patient, bed: number): boolean {
  if (!loungeOpen(state)) return false;
  const seat = freeSeat(state, p, "discharge_lounge");
  if (!seat) return false;
  reserve(state, seat.objectId, seat.slot, p.id);
  p.seat = seat;
  p.bed = null;
  p.stage = "discharge_lounge";
  dirtyCouch(state, bed);
  return true;
}

/** Each minute: patients leave once they can, or move to the lounge; delays are counted hourly. */
export function updateDischarges(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const hourly = state.tick % TICKS_PER_HOUR === 0;
  for (const p of Object.values(state.patients)) {
    const d = p.discharge;
    if (!d || d.fit === null) continue;
    if (p.stage === "discharge_lounge") {
      const seat = p.seat;
      if (seat) {
        const obj = state.objects[seat.objectId];
        if (obj) headTo(state, p, seatTile(obj, seat.slot), seatApproach(obj, seat.slot));
      }
      if (state.tick >= d.goAt!) leave(state, p, "discharged");
      continue;
    }
    if (p.stage !== "on_ward" || p.death) continue;
    if (hourly && delayedDischarge(state, p)) state.today.stats.delayedBedHours++;
    const ready = d.needsCare
      ? d.careReady !== null && state.tick >= Math.max(d.careReady, d.goAt!)
      : state.tick >= d.goAt!;
    if (ready) {
      const bed = p.bed;
      leave(state, p, "discharged");
      if (bed !== null && state.objects[bed]) dirtyCouch(state, bed);
    } else if (!d.needsCare && p.bed !== null && loungeOpen(state)) {
      toLounge(state, p, p.bed);
    }
  }
}
