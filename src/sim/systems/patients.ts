/**
 * The A&E walk-in patient lifecycle (GAME_DESIGN §5.5) and patient needs
 * (§5.4):
 *
 *   arrive → queue at reception → book in → wait → triage → wait
 *     → called to a cubicle or bay → treatment steps → discharge
 *
 * A patient who deteriorates unnoticed may collapse on the way
 * (systems/deterioration.ts).
 *
 * Patients decide where to be each tick and walk there; staff work arrives
 * through the job board (systems/jobs.ts). While waiting, mood falls (faster
 * when standing or desperate for the toilet), and an unhappy patient may
 * leave without being seen (LWBS).
 */
import { conditionById } from "@data/catalogue";
import {
  BOOKING_MINS,
  FOUR_HOUR_MINS,
  LWBS_ACUITY_FACTOR,
  LWBS_MAX_CHANCE_PER_MIN,
  LWBS_MOOD,
  MOOD_DECAY_IN_CUBICLE,
  MOOD_DECAY_SEATED,
  MOOD_DECAY_STANDING,
  MOOD_DECAY_TOILET,
  TOILET_MINS,
  TOILET_URGE,
  TOILET_USES_BEFORE_CLEAN,
  TOILET_CLEAN_MINS,
  TRIAGE_CATEGORIES,
  TRIAGE_MINS,
  TRIAGE_TARGET_MINS,
} from "@data/patients";
import type { Outcome, Patient, PatientStage, Point } from "../agents";
import { emit } from "../events";
import {
  bedside,
  deskStaffSpot,
  fallbackEntrance,
  freeSeat,
  freeToilet,
  frontOf,
  holder,
  inValidRoom,
  queueSpots,
  release,
  reserve,
  restPoint,
  seatApproach,
  seatTile,
  siteEntrance,
  staffedDesks,
  standingSpot,
} from "../places";
import { chance, nextInt } from "../rng";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { isStandable } from "../world/objects";
import { earn } from "./finance";
import {
  dirtyCouch,
  ESCALATED_DUE,
  hasCleaningJob,
  jobsForPatient,
  postJob,
  removeJob,
  ticksFor,
} from "./jobBoard";
import { headTo, stop } from "./movement";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;

/** Stages where a patient is waiting to be called and may give up. */
const WAITING: ReadonlySet<PatientStage> = new Set([
  "queueing",
  "waiting_triage",
  "waiting_treatment",
]);

export function updatePatients(state: SimState): void {
  const beingSeen = new Set<number>();
  for (const j of Object.values(state.jobs)) {
    if (j.state === "working" && j.patientId !== null) beingSeen.add(j.patientId);
  }
  updateQueue(state);
  for (const p of Object.values(state.patients)) {
    updateNeeds(state, p, beingSeen.has(p.id));
    if (p.stage !== "leaving" && WAITING.has(p.stage) && p.toilet === null) maybeGiveUp(state, p);
    switch (p.stage) {
      case "queueing":
        break; // Handled by updateQueue.
      case "booking":
        updateBooking(state, p);
        break;
      case "waiting_triage":
      case "waiting_treatment":
        waitInArea(state, p, beingSeen.has(p.id));
        break;
      case "awaiting_handover":
        break; // On the stretcher at the ambulance (systems/ambulances.ts).
      case "awaiting_bed":
      case "transferring":
      case "on_ward":
        break; // On a bed; porters move them (systems/admissions.ts).
      case "deceased":
      case "to_mortuary":
      case "in_mortuary":
        break; // See systems/deaths.ts.
      case "collapsed":
        break; // The crash team comes to them (systems/deterioration.ts).
      case "called_triage":
      case "called_treatment":
      case "triage":
      case "in_cubicle":
        goToBed(state, p);
        break;
      case "leaving":
        updateLeaving(state, p);
        break;
    }
  }
}

// ---------- Reception ----------

/** Queue spots are only recomputed when the layout changes. */
const spotCache = new WeakMap<SimState, { version: number; spots: Point[] }>();

function cachedQueueSpots(state: SimState): Point[] {
  const c = spotCache.get(state);
  if (c && c.version === state.layoutVersion) return c.spots;
  const spots = queueSpots(state);
  spotCache.set(state, { version: state.layoutVersion, spots });
  return spots;
}

/** First come, first served: the head of the queue goes to the next free staffed desk. */
function updateQueue(state: SimState): void {
  const queue = Object.values(state.patients)
    .filter((p) => p.stage === "queueing")
    .sort((a, b) => a.times.arrived - b.times.arrived || a.id - b.id);
  if (queue.length === 0) return;
  const freeDesks = staffedDesks(state).filter((d) => holder(state, d.id, 0) === undefined);
  while (freeDesks.length > 0 && queue.length > 0) {
    const desk = freeDesks.shift()!;
    const p = queue.shift()!;
    p.stage = "booking";
    p.desk = desk.id;
    p.bookingLeft = ticksFor(state.rng, BOOKING_MINS);
    reserve(state, desk.id, 0, p.id);
  }
  const spots = cachedQueueSpots(state);
  queue.forEach((p, n) => {
    const spot = spots[Math.min(n, spots.length - 1)];
    if (spot) headTo(state, p, spot);
    else stop(p);
  });
}

function updateBooking(state: SimState, p: Patient): void {
  const desk = p.desk === null ? undefined : state.objects[p.desk];
  if (!desk || !inValidRoom(state, desk.id, "ae_reception")) {
    if (p.desk !== null) release(state, p.desk, 0, p.id);
    p.desk = null;
    p.stage = "queueing";
    return;
  }
  if (headTo(state, p, frontOf(desk)) !== "arrived") return;
  // Booking only progresses while the receptionist is at the desk.
  const sid = holder(state, desk.id, "staff");
  const s = sid === undefined ? undefined : state.staff[sid];
  const spot = deskStaffSpot(desk);
  if (!s || s.path.length > 0 || s.x !== spot.x || s.y !== spot.y) return;
  if (--p.bookingLeft > 0) return;
  release(state, desk.id, 0, p.id);
  p.desk = null;
  p.bookingLeft = -1;
  p.times.booked = state.tick;
  p.stage = "waiting_triage";
  postJob(state, {
    kind: "triage",
    roles: ["nurse"],
    patientId: p.id,
    roomType: "triage_room",
    dueTick: p.times.arrived + TRIAGE_TARGET_MINS * TICKS_PER_MINUTE,
    durationTicks: ticksFor(state.rng, TRIAGE_MINS),
  });
}

// ---------- Waiting ----------

function waitInArea(state: SimState, p: Patient, beingSeen: boolean): void {
  if (p.toilet) {
    toiletTrip(state, p);
    return;
  }
  // Staggered so not every patient searches every tick.
  const myTurn = (state.tick + p.id) % 10 === 0;
  if (p.bladder >= TOILET_URGE && myTurn && !beingSeen) {
    const toilet = freeToilet(state, p);
    if (toilet) {
      reserve(state, toilet.id, 0, p.id);
      p.toilet = { objectId: toilet.id, left: -1 };
      toiletTrip(state, p);
      return;
    }
  }
  if (p.seat && !inValidRoom(state, p.seat.objectId, "waiting_area")) releaseSeat(state, p);
  if (!p.seat && (myTurn || p.standing === null)) {
    const seat = freeSeat(state, p);
    if (seat) {
      reserve(state, seat.objectId, seat.slot, p.id);
      p.seat = seat;
      p.standing = null;
    }
  }
  if (p.seat) {
    const obj = state.objects[p.seat.objectId]!;
    headTo(state, p, seatTile(obj, p.seat.slot), seatApproach(obj, p.seat.slot));
    return;
  }
  const grid = state.floors[0]!;
  if (!p.standing || !isStandable(grid, p.standing.x, p.standing.y)) {
    const pickN = (n: number) => nextInt(state.rng, 0, n - 1);
    p.standing = standingSpot(state, "waiting_area", pickN) ??
      standingSpot(state, "ae_reception", pickN) ?? { x: Math.round(p.x), y: Math.round(p.y) };
  }
  headTo(state, p, p.standing);
}

function toiletTrip(state: SimState, p: Patient): void {
  const trip = p.toilet!;
  const toilet = state.objects[trip.objectId];
  if (!toilet || !inValidRoom(state, toilet.id, "toilets")) {
    release(state, trip.objectId, 0, p.id);
    p.toilet = null;
    return;
  }
  if (trip.left < 0) {
    const arrival = headTo(state, p, { x: toilet.x, y: toilet.y }, frontOf(toilet));
    if (arrival === "arrived") trip.left = ticksFor(state.rng, TOILET_MINS);
    else if (arrival === "no_route") {
      release(state, toilet.id, 0, p.id);
      p.toilet = null;
    }
    return;
  }
  if (--trip.left > 0) return;
  p.bladder = 0;
  const dirt = (state.dirt[toilet.id] ?? 0) + 1;
  state.dirt[toilet.id] = dirt;
  release(state, toilet.id, 0, p.id);
  p.toilet = null;
  if (dirt >= TOILET_USES_BEFORE_CLEAN && !hasCleaningJob(state, toilet.id)) {
    postJob(state, {
      kind: "clean_toilet",
      roles: ["cleaner"],
      objectId: toilet.id,
      roomType: "toilets",
      dueTick: state.tick,
      durationTicks: ticksFor(state.rng, TOILET_CLEAN_MINS),
    });
  }
}

export function releaseSeat(state: SimState, p: Patient): void {
  if (p.seat) release(state, p.seat.objectId, p.seat.slot, p.id);
  p.seat = null;
}

// ---------- Triage and treatment ----------

/** Walk to the reserved couch and lie on it. */
function goToBed(state: SimState, p: Patient): void {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  if (!bed) return; // The job system notices and sends them back to wait.
  const arrival = headTo(state, p, restPoint(bed), bedside(state, bed));
  if (arrival !== "arrived") return;
  if (p.stage === "called_triage") p.stage = "triage";
  else if (p.stage === "called_treatment") p.stage = "in_cubicle";
}

/** Called by a clinician (job system): leave the waiting area for the couch. */
export function callToBed(state: SimState, p: Patient, bedId: number): void {
  releaseSeat(state, p);
  p.standing = null;
  // Moving on from another trolley (say Resus to Majors): that one needs cleaning.
  if (p.bed !== null) {
    release(state, p.bed, 0, p.id);
    dirtyCouch(state, p.bed);
  }
  reserve(state, bedId, 0, p.id);
  p.bed = bedId;
  p.stage = p.stage === "waiting_triage" ? "called_triage" : "called_treatment";
}

/** Back to the waiting area, e.g. when their cubicle was dismantled. */
export function backToWaiting(state: SimState, p: Patient): void {
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  p.bed = null;
  if (p.category === 0) {
    // Not handed over yet: stay with the crew where they are.
    p.stage = p.ambulanceId !== null ? "awaiting_handover" : "waiting_triage";
  } else p.stage = "waiting_treatment";
}

/** Posts the job for the patient's current pathway step. */
export function postTreatment(state: SimState, p: Patient, objectId: number | null): void {
  const condition = conditionById.get(p.conditionId)!;
  const step = condition.pathway[p.step]!;
  const target = TRIAGE_CATEGORIES[p.category]?.targetMins ?? 240;
  const escalated = p.deterioration !== null && p.deterioration.noticed !== null;
  postJob(state, {
    kind: "treat",
    roles: step.roles,
    patientId: p.id,
    objectId,
    roomType: step.room,
    capabilities: step.capabilities,
    step: p.step,
    dueTick: escalated ? ESCALATED_DUE : p.times.arrived + target * TICKS_PER_MINUTE,
    durationTicks: ticksFor(state.rng, step.mins),
  });
}

export function afterTriage(state: SimState, p: Patient): void {
  const condition = conditionById.get(p.conditionId)!;
  p.category = condition.acuity;
  p.times.triaged = state.tick;
  const stats = state.today.stats;
  stats.triaged++;
  stats.triageWaitMins += (state.tick - p.times.arrived) / TICKS_PER_MINUTE;
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  p.bed = null;
  p.step = 0;
  p.stage = "waiting_treatment";
  postTreatment(state, p, null);
}

// ---------- Needs and mood ----------

function updateNeeds(state: SimState, p: Patient, beingSeen: boolean): void {
  // Ward needs (meals, toilets, washing) are left to the ward team for now.
  if (p.death || ["leaving", "collapsed", "transferring", "on_ward"].includes(p.stage)) return;
  if (!p.toilet || p.toilet.left < 0) p.bladder = Math.min(100, p.bladder + p.bladderRate);
  let decay = 0;
  if (p.stage === "awaiting_handover") {
    decay = MOOD_DECAY_SEATED;
  } else if (
    WAITING.has(p.stage) ||
    p.stage === "called_triage" ||
    p.stage === "called_treatment"
  ) {
    const seated = p.seat !== null && p.path.length === 0 && !p.toilet;
    decay = seated || p.toilet ? MOOD_DECAY_SEATED : MOOD_DECAY_STANDING;
  } else if ((p.stage === "in_cubicle" || p.stage === "awaiting_bed") && !beingSeen) {
    decay = MOOD_DECAY_IN_CUBICLE;
  }
  if (p.bladder >= 90 && !p.toilet) decay += MOOD_DECAY_TOILET;
  p.mood = Math.max(0, p.mood - decay / TICKS_PER_HOUR);
}

function maybeGiveUp(state: SimState, p: Patient): void {
  if (p.mood >= LWBS_MOOD || state.tick % TICKS_PER_MINUTE !== 0) return;
  const p0 = LWBS_MAX_CHANCE_PER_MIN * (1 - p.mood / LWBS_MOOD);
  if (!chance(state.rng, p0 * (LWBS_ACUITY_FACTOR[p.category] ?? 1))) return;
  const mins = Math.round((state.tick - p.times.arrived) / TICKS_PER_MINUTE);
  emit(state, `${p.name} left without being seen after ${formatWait(mins)}`, "warn", {
    x: Math.round(p.x),
    y: Math.round(p.y),
  });
  leave(state, p, "lwbs");
}

export function formatWait(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m} min` : `${h}h ${String(m).padStart(2, "0")}m`;
}

// ---------- Leaving ----------

/**
 * Discharged or transferred (with the tariff earned), or gave up: release
 * everything and head out. Inpatients going home from a ward left A&E (and
 * were counted there) when they were admitted; they earn the inpatient tariff.
 */
export function leave(state: SimState, p: Patient, outcome: Outcome): void {
  for (const job of jobsForPatient(state, p.id)) removeJob(state, job);
  releaseSeat(state, p);
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  if (p.desk !== null) release(state, p.desk, 0, p.id);
  if (p.toilet) release(state, p.toilet.objectId, 0, p.id);
  p.bed = null;
  p.desk = null;
  p.toilet = null;
  p.standing = null;
  p.stage = "leaving";
  p.outcome = outcome;
  p.times.left = state.tick;

  const stats = state.today.stats;
  const condition = conditionById.get(p.conditionId)!;
  if (p.times.admitted !== null) {
    stats.wardDischarges++;
    earn(state, condition.admission?.tariff ?? 0);
    return;
  }
  recordDeparture(state, p);
  if (outcome === "lwbs") stats.lwbs++;
  else {
    if (outcome === "transferred") stats.transferred++;
    else if (outcome === "transferred_out") stats.transfersOut++;
    else stats.discharged++;
    earn(state, condition.tariff);
  }
}

/** Still in A&E: not on their way out, admitted to a ward, or deceased. */
export function inAE(p: Patient): boolean {
  return p.stage !== "leaving" && p.stage !== "on_ward" && p.death === null;
}

/** Leaving A&E (home, elsewhere, or died): the 4-hour clock stops. */
export function recordDeparture(state: SimState, p: Patient): void {
  const stats = state.today.stats;
  const mins = (state.tick - p.times.arrived) / TICKS_PER_MINUTE;
  stats.departures++;
  stats.timeInDeptMins += mins;
  if (mins <= FOUR_HOUR_MINS) stats.within4h++;
}

function updateLeaving(state: SimState, p: Patient): void {
  // Taken straight to intensive care (an ICU of your own comes later).
  if (p.outcome === "transferred" || p.outcome === "transferred_out") {
    delete state.patients[p.id];
    return;
  }
  const exit = siteEntrance(state) ?? fallbackEntrance(state);
  const arrival = headTo(state, p, exit);
  // Unreachable exits don't trap anyone: they find their own way out.
  if (arrival === "arrived" || arrival === "no_route") delete state.patients[p.id];
}
