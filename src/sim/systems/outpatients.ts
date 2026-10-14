/**
 * Clinic days (GAME_DESIGN §5.1): outpatients come in for their booked
 * appointments, and clinicians run their clinic sessions.
 *
 * Each booked patient sets off a little before their appointment. Some
 * don't come (did not attend): their first missed appointment is rebooked,
 * a second sends them back to their GP. Those who come book in at an
 * Outpatients Reception desk with a receptionist, sit in the nearest
 * Waiting Area, and are called into the clinic room in appointment order.
 *
 * A clinician in a session (from 10 minutes before it starts, until they've
 * seen everyone booked into it) isn't on the job board: they finish what
 * they're doing, go to the desk in their clinic room, and see their
 * patients one by one. After a first appointment the patient is discharged
 * back to their GP, given a follow-up, or listed for surgery (the RTT clock
 * runs on until the operation); a follow-up may need another. Each
 * appointment attended earns its tariff.
 *
 * If the session can't run on the day (the clinician has left, or there's
 * no clinic room), waiting patients are sent home and rebooked.
 */
import { specialtyById } from "@data/catalogue";
import { CLINIC_SESSIONS, URGENT_TARGET_DAYS, type SessionHalf } from "@data/outpatients";
import { BOOKING_MINS } from "@data/patients";
import type { Outpatient, Referral, Staff } from "../agents";
import {
  deskStaffSpot,
  fallbackEntrance,
  freeSeat,
  frontOf,
  holder,
  release,
  reserve,
  seatApproach,
  seatTile,
  siteEntrance,
} from "../places";
import { chance, nextFloat, nextInt } from "../rng";
import type { PlacedObject, SimState } from "../state";
import { clockFromTick, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "../time";
import { sessionsOn, type Session } from "./clinics";
import { ticksFor, unassignJob } from "./jobBoard";
import { headTo } from "./movement";
import { bookAppointments, serviceOf } from "./referrals";
import { earnOutpatient, earnPrivate } from "./finance";

/** Chance of not attending: first appointments, follow-ups (NHS about 7%). */
export const DNA_CHANCE = { first: 0.06, follow_up: 0.08 };
/** Patients set off so as to arrive this many minutes early (at most). */
const ARRIVE_EARLY_MINS: [number, number] = [5, 25];
/** Clinicians go to their room this long before the session starts. */
const SESSION_LEAD_MINS = 10;
/** A clinic overruns at most this long before anyone still waiting is sent home. */
const MAX_OVERRUN_MINS = 90;
/** Consultations take this fraction of the booked slot (they rarely run to time). */
const CONSULT_SPREAD: [number, number] = [0.7, 1.4];

/** Outpatients Reception desks, in working rooms. */
export function outpatientDesks(state: SimState): PlacedObject[] {
  const out: PlacedObject[] = [];
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== "outpatients_reception") continue;
    for (const id of room.objectIds) {
      if (state.objects[id]!.defId === "reception_desk") out.push(state.objects[id]!);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A clinic session under way: its clinician, room and desk, and when it ends. */
export interface LiveSession {
  session: Session;
  desk: PlacedObject;
  end: number;
}

const liveCache = new WeakMap<SimState, { minute: number; live: Map<number, LiveSession> }>();

/**
 * Clinicians in a clinic session right now (staff id → session): from just
 * before it starts until they've seen everyone booked into it, or it's
 * overrun too far. Worked out once a minute.
 */
export function liveSessions(state: SimState): Map<number, LiveSession> {
  const minute = Math.floor(state.tick / TICKS_PER_MINUTE);
  const cached = liveCache.get(state);
  if (cached && cached.minute === minute) return cached.live;
  const live = new Map<number, LiveSession>();
  const c = clockFromTick(state.tick);
  if (c.weekday <= 4) {
    for (const half of ["am", "pm"] as SessionHalf[]) {
      const times = CLINIC_SESSIONS[half];
      const start = tickAt(c.day, 0) + times.start * TICKS_PER_MINUTE;
      const end = tickAt(c.day, 0) + times.end * TICKS_PER_MINUTE;
      if (state.tick < start - SESSION_LEAD_MINS * TICKS_PER_MINUTE) continue;
      if (state.tick >= end + MAX_OVERRUN_MINS * TICKS_PER_MINUTE) continue;
      for (const session of sessionsOn(state, c.day, half)) {
        if (session.roomId === null) continue;
        const room = state.rooms[session.roomId - 1]!;
        const desk = room.objectIds.map((id) => state.objects[id]!).find((o) => o.defId === "desk");
        if (!desk) continue;
        const s = session.staff;
        if (state.tick >= end && !hasPatientsLeft(state, s.id, c.day, half)) continue;
        live.set(s.id, { session, desk, end });
      }
    }
  }
  liveCache.set(state, { minute, live });
  return live;
}

/** Whether a member of staff is running a clinic now (and so off the job board). */
export function inClinic(state: SimState, s: Staff): boolean {
  return liveSessions(state).has(s.id);
}

/** Anyone booked into this session still to come in or be seen. */
function hasPatientsLeft(
  state: SimState,
  staffId: number,
  day: number,
  half: SessionHalf,
): boolean {
  for (const o of Object.values(state.outpatients)) {
    if (o.staffId === staffId && o.stage !== "leaving") return true;
  }
  for (const r of Object.values(state.referrals)) {
    const b = r.booking;
    if (b && b.staffId === staffId && b.day === day && b.half === half && b.at > state.tick) {
      return true;
    }
  }
  return false;
}

/** Every tick: patients set off, book in and wait; clinicians see them. */
export function updateOutpatients(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE === 0) setOff(state);
  const live = liveSessions(state);
  for (const [staffId, ls] of live) runClinic(state, state.staff[staffId]!, ls);
  for (const o of Object.values(state.outpatients)) updateOutpatient(state, o, live);
}

/** Booked patients whose appointment is coming up set off (or don't come). */
function setOff(state: SimState): void {
  const coming = new Set(Object.values(state.outpatients).map((o) => o.referralId));
  for (const r of Object.values(state.referrals)) {
    const b = r.booking;
    if (!b || coming.has(r.id)) continue;
    // How early they mean to arrive varies from person to person.
    const early =
      ARRIVE_EARLY_MINS[0] + ((r.id * 7) % (ARRIVE_EARLY_MINS[1] - ARRIVE_EARLY_MINS[0]));
    if (state.tick < b.at - early * TICKS_PER_MINUTE) continue;
    if (r.kind === "surgery") continue;
    if (chance(state.rng, DNA_CHANCE[r.kind])) {
      didNotAttend(state, r);
      continue;
    }
    const at = siteEntrance(state) ?? fallbackEntrance(state);
    const o: Outpatient = {
      id: state.nextAgentId++,
      name: r.name,
      x: at.x,
      y: at.y,
      prevX: at.x,
      prevY: at.y,
      path: [],
      dest: null,
      pathVersion: state.layoutVersion,
      referralId: r.id,
      specialty: r.specialty,
      stage: "arriving",
      seat: null,
      desk: null,
      left: -1,
      appointment: b.at,
      staffId: b.staffId,
      bookedIn: null,
      seen: null,
    };
    state.outpatients[o.id] = o;
  }
}

/**
 * Missed their appointment. The first time it's rebooked (a missed first
 * appointment restarts the RTT clock, as the NHS rules allow); the second
 * time they're discharged back to their GP.
 */
function didNotAttend(state: SimState, r: Referral): void {
  state.today.stats.dnas++;
  r.dnas++;
  r.booking = null;
  if (r.dnas >= 2) {
    delete state.referrals[r.id];
    return;
  }
  if (r.kind === "first") r.clockStart = state.tick;
  bookAppointments(state);
}

function updateOutpatient(state: SimState, o: Outpatient, live: Map<number, LiveSession>): void {
  const r = state.referrals[o.referralId];
  const session = live.get(o.staffId);
  const check =
    state.tick % TICKS_PER_MINUTE === 0 && o.stage !== "leaving" && o.stage !== "in_clinic";
  if (check && (!r || clinicCancelled(state, o, session))) {
    // The clinic isn't running today: sent home, and rebooked.
    if (r) {
      r.booking = null;
      state.today.stats.clinicCancellations++;
      bookAppointments(state);
    }
    goHome(state, o);
  }
  switch (o.stage) {
    case "arriving":
      return arrive(state, o);
    case "booking":
      return bookIn(state, o);
    case "waiting":
      return waitToBeCalled(state, o);
    case "called":
      if (session && headTo(state, o, frontOf(session.desk)) === "arrived") {
        o.stage = "in_clinic";
        o.seen = state.tick;
        const service = serviceOf(o.specialty)!;
        const slot = r?.booking?.mins ?? service.followUpSlotMins;
        const f =
          CONSULT_SPREAD[0] + (CONSULT_SPREAD[1] - CONSULT_SPREAD[0]) * nextFloat(state.rng);
        o.left = Math.max(1, Math.round(slot * f * TICKS_PER_MINUTE));
      }
      return;
    case "in_clinic":
      if (--o.left <= 0) {
        seen(state, o);
        goHome(state, o);
      }
      return;
    case "leaving": {
      const exit = siteEntrance(state) ?? fallbackEntrance(state);
      const arrival = headTo(state, o, exit);
      if (arrival === "arrived" || arrival === "no_route") delete state.outpatients[o.id];
      return;
    }
  }
}

/** Whether their clinic won't happen today: the clinician gone, or no session for them. */
function clinicCancelled(
  state: SimState,
  o: Outpatient,
  session: LiveSession | undefined,
): boolean {
  if (!state.staff[o.staffId]) return true;
  // Before the session starts it isn't live yet; once it's over, it's too late.
  const c = clockFromTick(o.appointment);
  const half: SessionHalf = c.hour < 13 ? "am" : "pm";
  const end = tickAt(c.day, 0) + CLINIC_SESSIONS[half].end * TICKS_PER_MINUTE;
  if (session) return false;
  return (
    state.tick >= end ||
    !sessionsOn(state, c.day, half).some((s) => s.staff.id === o.staffId && s.roomId !== null)
  );
}

/** Head for a free Outpatients Reception desk with a receptionist, and book in there. */
function arrive(state: SimState, o: Outpatient): void {
  if (o.desk === null) {
    const desk = outpatientDesks(state).find(
      (d) => holder(state, d.id, 0) === undefined && holder(state, d.id, "staff") !== undefined,
    );
    if (!desk) {
      // Nobody on the desk yet: head over and wait near it.
      const any = outpatientDesks(state)[0];
      if (any) headTo(state, o, frontOf(any));
      return;
    }
    reserve(state, desk.id, 0, o.id);
    o.desk = desk.id;
  }
  const desk = state.objects[o.desk];
  if (!desk) {
    o.desk = null;
    return;
  }
  if (headTo(state, o, frontOf(desk)) !== "arrived") return;
  o.stage = "booking";
  o.left = ticksFor(state.rng, BOOKING_MINS);
}

function bookIn(state: SimState, o: Outpatient): void {
  if (--o.left > 0) return;
  if (o.desk !== null) release(state, o.desk, 0, o.id);
  o.desk = null;
  o.bookedIn = state.tick;
  o.stage = "waiting";
}

/** Sit in the nearest Waiting Area until called. */
function waitToBeCalled(state: SimState, o: Outpatient): void {
  if (!o.seat) {
    const seat = freeSeat(state, o);
    if (!seat) return; // Stand where they are.
    reserve(state, seat.objectId, seat.slot, o.id);
    o.seat = seat;
  }
  const obj = state.objects[o.seat.objectId];
  if (!obj) {
    o.seat = null;
    return;
  }
  headTo(state, o, seatTile(obj, o.seat.slot), seatApproach(obj, o.seat.slot));
}

/** Clinician: to the clinic room desk, then call each patient in turn. */
function runClinic(state: SimState, s: Staff, ls: LiveSession): void {
  const job = s.jobId === null ? undefined : state.jobs[s.jobId];
  if (job) {
    // Clinic first: anything not yet started goes back on the board.
    if (job.state !== "working") unassignJob(state, job);
    return;
  }
  if (headTo(state, s, deskStaffSpot(ls.desk)) !== "arrived") return;
  s.lastActiveTick = state.tick;
  const mine = Object.values(state.outpatients).filter((o) => o.staffId === s.id);
  if (mine.some((o) => o.stage === "called" || o.stage === "in_clinic")) return;
  // In appointment order, no more than a little early.
  const next = mine
    .filter((o) => o.stage === "waiting" && o.appointment <= state.tick + 10 * TICKS_PER_MINUTE)
    .sort((a, b) => a.appointment - b.appointment || a.id - b.id)[0];
  if (!next) return;
  if (next.seat) release(state, next.seat.objectId, next.seat.slot, next.id);
  next.seat = null;
  next.stage = "called";
}

/** The appointment's outcome, its tariff, and what happens next on the list. */
function seen(state: SimState, o: Outpatient): void {
  const r = state.referrals[o.referralId];
  const service = serviceOf(o.specialty);
  if (!r || !service) return;
  const stats = state.today.stats;
  r.booking = null;
  if (r.kind === "first") {
    stats.firstAppointments++;
    earnAppointment(state, r, service.firstTariff);
    if (r.urgent) {
      stats.urgentSeen++;
      if (state.tick - (r.clockStart ?? r.added) <= URGENT_TARGET_DAYS * TICKS_PER_DAY) {
        stats.urgentWithin2w++;
      }
    }
    if (chance(state.rng, service.surgeryChance)) {
      // A decision to operate: the RTT clock runs on until surgery.
      r.kind = "surgery";
      r.added = state.tick;
      r.dayCase = chance(state.rng, specialtyById.get(r.specialty)?.surgery?.dayCaseShare ?? 0);
      stats.listedForSurgery++;
      return;
    }
  } else {
    stats.followUps++;
    earnAppointment(state, r, service.followUpTariff);
  }
  if (chance(state.rng, service.followUpChance)) {
    // Treatment has started (or it's monitoring): the clock stops.
    const [lo, hi] = service.followUpWeeks;
    r.kind = "follow_up";
    r.clockStart = null;
    r.added = state.tick;
    r.due = state.tick + nextInt(state.rng, lo * 7, hi * 7) * TICKS_PER_DAY;
    r.dnas = 0;
    return;
  }
  delete state.referrals[r.id]; // Discharged back to their GP.
}

/** An appointment's income: tariff for the NHS, a facility fee for a private patient. */
function earnAppointment(state: SimState, r: Referral, tariff: number): void {
  if (r.payer === "nhs") earnOutpatient(state, tariff);
  else {
    earnPrivate(state, tariff, r.payer, true);
    state.today.stats.privateSeen++;
  }
}

function goHome(state: SimState, o: Outpatient): void {
  if (o.seat) release(state, o.seat.objectId, o.seat.slot, o.id);
  if (o.desk !== null) release(state, o.desk, 0, o.id);
  o.seat = null;
  o.desk = null;
  o.stage = "leaving";
}
