/**
 * Operating theatres and planned surgery (GAME_DESIGN §5.1, M4 step 7).
 *
 * Theatre lists: each resident surgeon has weekly lists in their job plan
 * (systems/clinics.ts). Each list needs an anaesthetist, paired from the
 * anaesthetists' weekly quotas, and a working theatre: one of the
 * surgeon's specialty first, then one open to any, never one kept for
 * emergencies. Patients on the surgical waiting list are booked into lists
 * like clinic appointments (systems/referrals.ts).
 *
 * On the day: a patient comes to the Day Surgery Unit an hour or so before
 * their slot, and a staff nurse admits them. In turn, the surgeon's next
 * patient walks to the operating table. An inpatient needs a ward bed for
 * afterwards, kept for them from now; with none free, or with the list
 * running too late to finish, they're cancelled on the day and must be
 * rebooked within 28 days. The operation starts once the surgeon,
 * anaesthetist and two theatre practitioners are at the table; after it a
 * practitioner wheels them to a Recovery trolley, where a staff nurse looks
 * after them. Day cases then go back to the Day Surgery Unit and home; the
 * rest go to their ward bed with a porter. The RTT clock stops at the
 * operation.
 *
 * A surgeon or anaesthetist on a list is off the job board while it has
 * patients to see, like a clinician in clinic.
 */
import { conditionById, specialtyById } from "@data/catalogue";
import { CLINIC_SESSIONS, type SessionHalf } from "@data/outpatients";
import { PLANNED_PREFIX } from "@data/conditions";
import type { SpecialtyId } from "@data/schema";
import type { Operation, Patient, Referral, Staff } from "../agents";
import { onDuty } from "../agents";
import { warn } from "../events";
import {
  bedside,
  fallbackEntrance,
  freeCouches,
  freeSeat,
  frontOf,
  release,
  reserve,
  restPoint,
  seatApproach,
  seatTile,
  siteEntrance,
} from "../places";
import { chance, nextInt } from "../rng";
import type { PlacedObject, SimState } from "../state";
import { clockFromTick, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "../time";
import { objectRect, sideTiles } from "../world/objects";
import { roomOfObject } from "../world/rooms";
import { trolleyStop } from "./admissions";
import { newPatient } from "./arrivals";
import { jobPlan } from "./clinics";
import { dirtyCouch, jobsForPatient, postJob, removeJob, ticksFor, unassignJob } from "./jobBoard";
import { headTo } from "./movement";
import { leave, recordDeparture } from "./patients";
import { bookAppointments } from "./referrals";
import { callIn, operates } from "./staffing";
import { earnEmergency } from "./finance";
import { inClinic } from "./outpatients";

/** Minutes between cases on a list, for cleaning and setting up: booked into each slot. */
export const TURNAROUND_MINS = 15;
/** Patients cancel on the day for their own reasons (about 3% in the NHS). */
export const ELECTIVE_DNA = 0.03;
/** Patients arrive this long before their slot, at most. */
const ARRIVE_BEFORE_MINS: [number, number] = [60, 90];
/** A nurse's pre-operative checks, consent and gown. */
const PRE_OP_MINS: [number, number] = [15, 25];
/** Coming round in Recovery. */
const RECOVERY_MINS: [number, number] = [30, 60];
/** Day cases rest in the Day Surgery Unit before going home. */
const POST_OP_MINS: [number, number] = [30, 60];
/** A list may run this late; a case that wouldn't finish by then is cancelled. */
const MAX_OVERRUN_MINS = 30;
/** Theatre practitioners needed at each operation. */
export const PRACTITIONERS = 2;
/** Practitioners call the next patient this long before their slot. */
const CALL_AHEAD_MINS = 15;

const mean = ([a, b]: readonly [number, number]) => (a + b) / 2;

/** A planned theatre list: its surgeon, anaesthetist (if one's free) and theatre. */
export interface TheatreList {
  day: number;
  half: SessionHalf;
  surgeon: Staff;
  anaesthetist: Staff | null;
  /** A private list (clinics.ts SessionSlot.private). */
  private: boolean;
  /** The theatre (a Room id), or null with none free. */
  roomId: number | null;
}

/** Anaesthetists who do theatre lists, in hiring order. */
function anaesthetists(state: SimState): Staff[] {
  return Object.values(state.staff)
    .filter(
      (s) =>
        s.specialty === "anaesthetics" &&
        operates(s) &&
        s.theatreSessions + s.privateTheatreSessions > 0,
    )
    .sort((a, b) => a.id - b.id);
}

/** An anaesthetist's lists a week of a kind: in a Private Hospital all are private. */
function anaesthetistQuota(state: SimState, a: Staff, isPrivate: boolean): number {
  if (state.funding === "private") return a.theatreSessions;
  return isPrivate ? a.privateTheatreSessions : a.theatreSessions;
}

function isSurgeon(s: Staff): boolean {
  return operates(s) && s.specialty !== "anaesthetics";
}

const listCache = new WeakMap<SimState, { key: string; weeks: Map<number, TheatreList[]> }>();

/**
 * A week's theatre lists (from the Monday `weekStart`). Anaesthetists cover
 * lists in time order until their weekly quota is used, one list at a time;
 * then each half-day's lists get theatres.
 */
function weekLists(state: SimState, weekStart: number): TheatreList[] {
  let key = `${state.layoutVersion}|${JSON.stringify(state.roomSpecialties)}|${Object.keys(state.emergencyTheatres)}|${Object.keys(state.privateRooms)}|${state.funding}|`;
  for (const s of Object.values(state.staff)) {
    const n =
      s.theatreSessions + s.clinicSessions + s.privateTheatreSessions + s.privateClinicSessions;
    if (n > 0) {
      key += `${s.id}:${s.clinicSessions}:${s.theatreSessions}:${s.privateClinicSessions}:${s.privateTheatreSessions},`;
    }
  }
  let cache = listCache.get(state);
  if (!cache || cache.key !== key) {
    cache = { key, weeks: new Map() };
    listCache.set(state, cache);
  }
  const hit = cache.weeks.get(weekStart);
  if (hit) return hit;

  const surgeons = Object.values(state.staff)
    .filter((s) => isSurgeon(s) && s.theatreSessions + s.privateTheatreSessions > 0)
    .sort((a, b) => a.id - b.id);
  const lists: TheatreList[] = [];
  for (let d = 0; d < 5; d++) {
    for (const half of ["am", "pm"] as const) {
      for (const s of surgeons) {
        const slot = jobPlan(state, s).find(
          (p) => p.kind === "theatre" && p.weekday === d && p.half === half,
        );
        if (slot) {
          lists.push({
            day: weekStart + d,
            half,
            surgeon: s,
            anaesthetist: null,
            private: slot.private,
            roomId: null,
          });
        }
      }
    }
  }
  const team = anaesthetists(state);
  const quota = new Map<string, number>();
  for (const a of team) {
    for (const p of [false, true]) quota.set(`${a.id}:${p}`, anaesthetistQuota(state, a, p));
  }
  for (const l of lists) {
    const busy = new Set(
      lists
        .filter((o) => o.day === l.day && o.half === l.half && o.anaesthetist)
        .map((o) => o.anaesthetist!.id),
    );
    const k = (t: Staff) => `${t.id}:${l.private && state.funding !== "private"}`;
    const a = team.find((t) => (quota.get(k(t)) ?? 0) > 0 && !busy.has(t.id));
    if (a) {
      l.anaesthetist = a;
      quota.set(k(a), quota.get(k(a))! - 1);
    }
  }
  const theatres = state.rooms.filter((r) => r.valid && r.typeId === "theatre" && !r.emergency);
  for (let d = 0; d < 5; d++) {
    for (const half of ["am", "pm"] as const) {
      const free = [...theatres];
      const here = lists.filter((l) => l.day === weekStart + d && l.half === half);
      // In a Hybrid trust, private lists use Private Patient Unit theatres and NHS lists the rest.
      const take = (l: TheatreList, test: (r: (typeof free)[number]) => boolean) => {
        const i = free.findIndex(
          (r) => (state.funding !== "hybrid" || r.private === l.private) && test(r),
        );
        return i < 0 ? null : free.splice(i, 1)[0]!.id;
      };
      for (const l of here) l.roomId = take(l, (r) => r.specialty === l.surgeon.specialty);
      for (const l of here) if (l.roomId === null) l.roomId = take(l, (r) => r.specialty === null);
    }
  }
  cache.weeks.set(weekStart, lists);
  return lists;
}

/** The theatre lists on a day's morning or afternoon (none at weekends). */
export function listsOn(state: SimState, day: number, half: SessionHalf): TheatreList[] {
  const weekday = (day - 1) % 7;
  // For emergencies only, or closed: planned lists stand down.
  if (weekday > 4 || state.departments.theatres !== "open") return [];
  return weekLists(state, day - weekday).filter((l) => l.day === day && l.half === half);
}

/** A list that can run: it has an anaesthetist and a theatre. */
export function canRun(l: TheatreList): boolean {
  return l.anaesthetist !== null && l.roomId !== null;
}

/** A list under way now, with its theatre's table and anaesthetic machine. */
interface LiveList {
  list: TheatreList;
  table: PlacedObject;
  machine: PlacedObject;
  end: number;
}

const liveCache = new WeakMap<SimState, { minute: number; live: LiveList[] }>();

/**
 * Lists under way: from the start of the session until its booked patients
 * are done (or cancelled), at most MAX_OVERRUN_MINS past its end. Worked out
 * once a minute.
 */
export function liveLists(state: SimState): LiveList[] {
  const minute = Math.floor(state.tick / TICKS_PER_MINUTE);
  const cached = liveCache.get(state);
  if (cached && cached.minute === minute) return cached.live;
  const live: LiveList[] = [];
  const c = clockFromTick(state.tick);
  for (const half of ["am", "pm"] as const) {
    const times = CLINIC_SESSIONS[half];
    const start = tickAt(c.day, 0) + times.start * TICKS_PER_MINUTE;
    const end = tickAt(c.day, 0) + times.end * TICKS_PER_MINUTE;
    if (state.tick < start || state.tick >= end + MAX_OVERRUN_MINS * TICKS_PER_MINUTE) continue;
    for (const list of listsOn(state, c.day, half)) {
      if (!canRun(list)) continue;
      const room = state.rooms[list.roomId! - 1]!;
      const objects = room.objectIds.map((id) => state.objects[id]!);
      const table = objects.find((o) => o.defId === "operating_table");
      const machine = objects.find((o) => o.defId === "anaesthetic_machine");
      if (!table || !machine) continue;
      if (!hasCasesLeft(state, list)) continue;
      live.push({ list, table, machine, end });
    }
  }
  liveCache.set(state, { minute, live });
  return live;
}

/** Anyone booked onto this list still to be operated on (or under way). */
function hasCasesLeft(state: SimState, list: TheatreList): boolean {
  if (Object.values(state.operations).some((o) => o.surgeonId === list.surgeon.id)) return true;
  return Object.values(state.referrals).some((r) => {
    const b = r.booking;
    return (
      r.kind === "surgery" &&
      b?.staffId === list.surgeon.id &&
      b.day === list.day &&
      b.half === list.half
    );
  });
}

/**
 * Whether a member of staff is busy in theatre: a surgeon or anaesthetist
 * on a list with patients to see, or anyone in an operation's team.
 */
export function inTheatre(state: SimState, s: Staff): boolean {
  for (const op of Object.values(state.operations)) {
    if (op.surgeonId === s.id || op.anaesthetistId === s.id) return true;
    if (op.practitionerIds.includes(s.id)) return true;
  }
  return liveLists(state).some(
    (l) => l.list.surgeon.id === s.id || l.list.anaesthetist?.id === s.id,
  );
}

/** Every tick: patients come in, lists run, operations progress. */
export function updateTheatres(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE === 0) {
    setOff(state);
    scheduleEmergencies(state);
  }
  for (const p of Object.values(state.patients)) {
    if (p.elective && (p.stage === "pre_op" || p.stage === "post_op")) inDayUnit(state, p);
  }
  for (const live of liveLists(state)) runList(state, live);
  for (const op of Object.values(state.operations)) runOperation(state, op);
}

/** Patients booked on today's lists set off (or cancel). */
function setOff(state: SimState): void {
  const coming = new Set<number>();
  for (const p of Object.values(state.patients)) if (p.elective) coming.add(p.elective.referralId);
  const today = clockFromTick(state.tick).day;
  for (const r of Object.values(state.referrals)) {
    const b = r.booking;
    if (r.kind !== "surgery" || !b || b.day !== today || coming.has(r.id)) continue;
    const before =
      ARRIVE_BEFORE_MINS[0] + ((r.id * 13) % (ARRIVE_BEFORE_MINS[1] - ARRIVE_BEFORE_MINS[0]));
    const listStart = tickAt(b.day, 0) + CLINIC_SESSIONS[b.half].start * TICKS_PER_MINUTE;
    const when = Math.max(
      listStart - ARRIVE_BEFORE_MINS[1] * TICKS_PER_MINUTE,
      b.at - before * TICKS_PER_MINUTE,
    );
    if (state.tick < when) continue;
    if (chance(state.rng, ELECTIVE_DNA)) {
      // They cancel on the day: back on the list, as if newly listed.
      state.today.stats.dnas++;
      r.booking = null;
      r.dnas++;
      if (r.dnas >= 2) delete state.referrals[r.id];
      bookAppointments(state);
      continue;
    }
    admitElective(state, r);
  }
}

/** A planned surgery patient arriving for their operation. */
function admitElective(state: SimState, r: Referral): Patient {
  const at = siteEntrance(state) ?? fallbackEntrance(state);
  const condition = conditionById.get(`${PLANNED_PREFIX}${r.specialty}`)!;
  const p = newPatient(state, at, condition, "pre_op");
  p.name = r.name;
  p.specialty = r.specialty;
  p.category = condition.acuity;
  p.elective = {
    referralId: r.id,
    payer: r.payer,
    dayCase: r.dayCase,
    checked: false,
    wardBed: null,
  };
  state.patients[p.id] = p;
  return p;
}

/** In the Day Surgery Unit: sit, be admitted by a nurse, and (after) rest before going home. */
function inDayUnit(state: SimState, p: Patient): void {
  if (!p.seat && (state.tick + p.id) % 10 === 0) {
    const seat = freeSeat(state, p, "day_surgery_unit");
    if (seat) {
      reserve(state, seat.objectId, seat.slot, p.id);
      p.seat = seat;
    }
  }
  const obj = p.seat && state.objects[p.seat.objectId];
  if (obj) headTo(state, p, seatTile(obj, p.seat!.slot), seatApproach(obj, p.seat!.slot));
  else if (p.seat) p.seat = null;
  if (p.stage === "post_op") {
    if (p.stayUntil !== null && state.tick >= p.stayUntil) leave(state, p, "discharged");
    return;
  }
  const seated = obj && p.path.length === 0;
  if (p.elective!.checked || !seated) return;
  if (jobsForPatient(state, p.id).some((j) => j.kind === "pre_op_check")) return;
  postJob(state, {
    kind: "pre_op_check",
    roles: ["nurse"],
    patientId: p.id,
    roomType: "",
    // In good time for their slot.
    dueTick: state.tick,
    durationTicks: ticksFor(state.rng, PRE_OP_MINS),
  });
}

/** The nurse has admitted them: checks, consent, gown. */
export function preOpChecked(p: Patient): void {
  if (p.elective) p.elective.checked = true;
}

/** Theatre practitioners free to join an operation. */
function freePractitioners(state: SimState): Staff[] {
  const busy = new Set(Object.values(state.operations).flatMap((o) => o.practitionerIds));
  return Object.values(state.staff).filter(
    (s) => s.role === "theatre_practitioner" && onDuty(s) && s.jobId === null && !busy.has(s.id),
  );
}

/** A list under way: start the surgeon's next case when they're free. */
function runList(state: SimState, live: LiveList): void {
  const { list } = live;
  const surgeon = list.surgeon;
  const busy = Object.values(state.operations).some(
    (o) => o.surgeonId === surgeon.id && o.phase !== "to_recovery",
  );
  if (busy) return;
  const queue = Object.values(state.referrals)
    .filter((r) => {
      const b = r.booking;
      return (
        r.kind === "surgery" &&
        b?.staffId === surgeon.id &&
        b.day === list.day &&
        b.half === list.half
      );
    })
    .sort((a, b) => a.booking!.at - b.booking!.at);
  const r = queue[0];
  if (!r) return;
  const service = specialtyById.get(r.specialty)!.surgery!;
  // Too late to finish this one (and so the rest): cancelled on the day.
  if (
    state.tick + mean(service.opMins) * TICKS_PER_MINUTE >
    live.end + MAX_OVERRUN_MINS * TICKS_PER_MINUTE
  ) {
    for (const q of queue) cancelOnTheDay(state, q, "the list ran out of time");
    return;
  }
  if (state.tick < r.booking!.at - CALL_AHEAD_MINS * TICKS_PER_MINUTE) return;
  const p = Object.values(state.patients).find((x) => x.elective?.referralId === r.id);
  if (!p || p.stage !== "pre_op" || !p.elective!.checked) return; // Not here or not ready yet.
  if (!p.elective!.dayCase && p.elective!.wardBed === null) {
    const bed = wardBedFor(state, p);
    if (!bed) {
      cancelOnTheDay(
        state,
        r,
        r.payer === "nhs" ? "no ward bed for afterwards" : "no private room for afterwards",
        p,
      );
      return;
    }
    reserve(state, bed.id, 0, p.id);
    p.elective!.wardBed = bed.id;
  }
  const team = freePractitioners(state);
  if (team.length < PRACTITIONERS) return; // The list waits for theatre staff.
  startOperation(
    state,
    p,
    live.table,
    surgeon,
    list.anaesthetist!,
    team.slice(0, PRACTITIONERS),
    false,
  );
}

/**
 * A free bed for after their operation. A private patient has a room of
 * their own: a side room (in a Hybrid trust, in the Private Patient Unit).
 * An NHS patient goes to a ward: their specialty's, then any, then another's.
 */
function wardBedFor(state: SimState, p: Patient): PlacedObject | undefined {
  if (p.elective?.payer !== "nhs") {
    return freeCouches(state, "side_room", ["inpatient_bed"], p, true)[0];
  }
  const beds = freeCouches(state, "ward", ["inpatient_bed"], p);
  const fit = (b: PlacedObject) => {
    const sp = roomOfObject(state, b.id)?.specialty ?? null;
    return sp === p.specialty ? 0 : sp === null ? 1 : 2;
  };
  return beds.sort((a, b) => fit(a) - fit(b))[0];
}

/**
 * A planned operation cancelled by the hospital on the day: home again, and
 * to be rebooked within 28 days.
 */
export function cancelOnTheDay(state: SimState, r: Referral, why: string, patient?: Patient): void {
  const p = patient ?? Object.values(state.patients).find((x) => x.elective?.referralId === r.id);
  state.today.stats.cancelledOnDay++;
  r.booking = null;
  r.rebookBy = state.tick + 28 * TICKS_PER_DAY;
  warn(
    state,
    `cancelled_${why}`,
    60 * TICKS_PER_MINUTE,
    `A planned operation was cancelled on the day: ${why}. The patient must be rebooked within 28 days.`,
    "warn",
  );
  if (p && p.stage === "pre_op") {
    if (p.elective!.wardBed !== null) release(state, p.elective!.wardBed, 0, p.id);
    p.elective = null; // They go home; they're back on the list.
    for (const job of jobsForPatient(state, p.id)) removeJob(state, job);
    if (p.seat) release(state, p.seat.objectId, p.seat.slot, p.id);
    p.seat = null;
    p.outcome = "discharged";
    p.stage = "leaving";
  }
  bookAppointments(state);
}

/** The patient goes to the table; the team gathers. */
export function startOperation(
  state: SimState,
  p: Patient,
  table: PlacedObject,
  surgeon: Staff,
  anaesthetist: Staff,
  practitioners: Staff[],
  emergency: boolean,
): Operation {
  if (p.seat) release(state, p.seat.objectId, p.seat.slot, p.id);
  p.seat = null;
  for (const job of jobsForPatient(state, p.id)) {
    if (job.kind === "obs" || job.kind === "pre_op_check") removeJob(state, job);
  }
  reserve(state, table.id, 0, p.id);
  const op: Operation = {
    id: state.nextOperationId++,
    patientId: p.id,
    table: table.id,
    surgeonId: surgeon.id,
    anaesthetistId: anaesthetist.id,
    practitionerIds: practitioners.map((s) => s.id),
    phase: "gathering",
    left: 0,
    recoveryBed: null,
    emergency,
  };
  state.operations[op.id] = op;
  if (!emergency) p.stage = "to_theatre";
  return op;
}

/** Where each of the team stands: the surgeon and scrub practitioner either side, the other at the foot. */
function teamSpots(state: SimState, op: Operation, machine: PlacedObject | undefined) {
  const table = state.objects[op.table]!;
  const sides = sideTiles(objectRect(table), table.rotation, "sides");
  const left = sides[0] ?? bedside(state, table);
  const right = sides.find((t) => Math.abs(t.x - left.x) + Math.abs(t.y - left.y) > 1) ?? left;
  return {
    surgeon: left,
    anaesthetist: machine ? frontOf(machine) : right,
    practitioners: [right, frontOf(table)],
  };
}

function runOperation(state: SimState, op: Operation): void {
  const p = state.patients[op.patientId];
  const table = state.objects[op.table];
  if (!p || p.death || !table) {
    endOperation(state, op);
    return;
  }
  const room = roomOfObject(state, table.id);
  const machine = room?.objectIds
    .map((id) => state.objects[id]!)
    .find((o) => o.defId === "anaesthetic_machine");
  const spots = teamSpots(state, op, machine);
  const team: [Staff | undefined, { x: number; y: number }][] = [
    [state.staff[op.surgeonId], spots.surgeon],
    [state.staff[op.anaesthetistId], spots.anaesthetist],
    ...op.practitionerIds.map(
      (id, i) =>
        [state.staff[id], spots.practitioners[i] ?? spots.surgeon] as [
          Staff | undefined,
          { x: number; y: number },
        ],
    ),
  ];
  if (op.phase === "gathering") {
    if (team.some(([s]) => !s)) {
      endOperation(state, op); // Someone left: it'll be rebooked.
      return;
    }
    const there = op.emergency
      ? wheelToTheatre(state, op, p, table)
      : headTo(state, p, restPoint(table), bedside(state, table)) === "arrived";
    if (there && p.stage === "to_theatre") p.stage = "in_theatre";
    let ready = there;
    for (const [i, [s, spot]] of team.entries()) {
      // The practitioner fetching an emergency patient comes with them.
      if (op.emergency && !there && i === 3) continue;
      if (headTo(state, s!, spot) !== "arrived") ready = false;
    }
    if (!ready) return;
    op.phase = "operating";
    if (op.emergency) {
      startEmergency(state, p);
      op.left = ticksFor(state.rng, emergencyOpOf(p)!.mins);
    } else {
      op.left = ticksFor(state.rng, specialtyById.get(p.specialty!)!.surgery!.opMins);
    }
    return;
  }
  if (op.phase === "operating") {
    for (const [s, spot] of team) if (s) headTo(state, s, spot);
    if (op.left > 0) {
      op.left--;
      return;
    }
    const bed = freeCouches(state, "recovery", [], p)[0];
    if (!bed) {
      warn(
        state,
        "no_recovery",
        60 * TICKS_PER_MINUTE,
        "An operation has finished but there's no free Recovery trolley, so the patient stays on the table and the theatre can't take the next case.",
        "warn",
      );
      return;
    }
    reserve(state, bed.id, 0, p.id);
    release(state, op.table, 0, p.id);
    p.bed = bed.id; // Theirs now, though they're still being wheeled to it.
    op.recoveryBed = bed.id;
    op.phase = "to_recovery";
    // The surgeon, anaesthetist and second practitioner are free for the next case.
    op.practitionerIds = op.practitionerIds.slice(0, 1);
    recordOperation(state, p, op);
    return;
  }
  // to_recovery: the practitioner wheels them.
  const bed = op.recoveryBed === null ? undefined : state.objects[op.recoveryBed];
  const pusher = state.staff[op.practitionerIds[0]!];
  if (!bed) {
    op.phase = "operating"; // The trolley went: find another.
    op.recoveryBed = null;
    return;
  }
  const from = { x: Math.round(p.x), y: Math.round(p.y) };
  const stop = trolleyStop(state, from, bed);
  let arrival = stop
    ? headTo(state, p, restPoint(bed), stop, true)
    : headTo(state, p, restPoint(bed), bedside(state, bed));
  if (arrival === "no_route") arrival = headTo(state, p, restPoint(bed), bedside(state, bed));
  if (pusher) {
    pusher.prevX = pusher.x;
    pusher.prevY = pusher.y;
    pusher.x = p.x;
    pusher.y = p.y;
    pusher.path = [];
    pusher.dest = null;
  }
  if (arrival !== "arrived") return;
  p.bed = bed.id;
  p.stage = "in_recovery";
  delete state.operations[op.id];
  postJob(state, {
    kind: "recovery",
    roles: ["nurse"],
    patientId: p.id,
    roomType: "",
    // Straight away: someone coming round from an anaesthetic needs a nurse.
    dueTick: -1,
    durationTicks: ticksFor(state.rng, RECOVERY_MINS),
  });
}

/** The operation is done: the RTT clock stops, and it's counted. */
function recordOperation(state: SimState, p: Patient, op: Operation): void {
  const stats = state.today.stats;
  if (op.emergency) return; // Counted when it started (startEmergency).
  stats.electiveOps++;
  if (p.elective?.dayCase) stats.dayCases++;
  if (p.elective && p.elective.payer !== "nhs") stats.privateOps++;
  if (p.elective) delete state.referrals[p.elective.referralId];
}

/** Abandons an operation that can't go on (the patient or a team member is gone). */
function endOperation(state: SimState, op: Operation): void {
  delete state.operations[op.id];
  const p = state.patients[op.patientId];
  release(state, op.table, 0, op.patientId);
  if (!p || p.death || !p.elective) return;
  const r = state.referrals[p.elective.referralId];
  if (r) cancelOnTheDay(state, r, "the theatre team wasn't there", p);
}

/**
 * The Recovery nurse is done: a day case goes back to the Day Surgery Unit
 * to get ready for home; anyone else waits on the trolley for a porter to
 * take them to their ward bed.
 */
export function recovered(state: SimState, p: Patient): void {
  if (p.homeBed !== null) {
    // Back from theatre to the ward: their bed was kept, so free it for the porter.
    release(state, p.homeBed, 0, p.id);
    p.homeBed = null;
  }
  if (p.elective?.dayCase) {
    if (p.bed !== null) {
      release(state, p.bed, 0, p.id);
      dirtyCouch(state, p.bed);
    }
    p.bed = null;
    p.stage = "post_op";
    p.stayUntil =
      state.tick + nextInt(state.rng, POST_OP_MINS[0], POST_OP_MINS[1]) * TICKS_PER_MINUTE;
    return;
  }
  if (p.elective && p.elective.wardBed !== null) {
    // Their bed was kept: free it for the porter to claim.
    release(state, p.elective.wardBed, 0, p.id);
    p.elective.wardBed = null;
  }
  p.stage = "awaiting_bed";
  p.times.decided ??= state.tick;
  postJob(state, {
    kind: "transfer",
    roles: ["porter"],
    patientId: p.id,
    // A private patient has a room of their own.
    roomType: p.elective && p.elective.payer !== "nhs" ? "side_room" : "ward",
    capabilities: ["inpatient_bed"],
    dueTick: state.tick,
    durationTicks: 1,
  });
}

/** Whether someone is on an operating table or being wheeled from it. */
export function operationFor(state: SimState, patientId: number): Operation | undefined {
  return Object.values(state.operations).find((o) => o.patientId === patientId);
}

// ---------- Emergency surgery ----------

/** An emergency is done out of hours (or in any free theatre) once it's this close to due. */
const EMERGENCY_ANY_THEATRE_HOURS = 6;

/** The emergency operation an admitted patient needs, from their condition. */
export function emergencyOpOf(p: Patient) {
  return conditionById.get(p.conditionId)?.admission?.operation;
}

/**
 * Why an emergency operation can't be done here at all, or null if it can:
 * a theatre, a surgeon of the specialty (resident or on call), an
 * anaesthetist, two theatre practitioners and Recovery.
 */
export function cantOperate(state: SimState, specialty: SpecialtyId): string | null {
  if (state.departments.theatres === "closed") return "Theatres are closed";
  const has = (type: string) => state.rooms.some((r) => r.valid && r.typeId === type);
  const doctor = (sp: SpecialtyId) =>
    Object.values(state.staff).some(
      (s) => s.specialty === sp && (s.role === "consultant" || s.role === "registrar"),
    );
  if (!has("theatre")) return "There's no working Operating Theatre";
  if (!has("recovery")) return "There's no Recovery";
  if (!doctor(specialty)) {
    return `There's no ${specialtyById.get(specialty)!.name} surgeon (consultant or registrar)`;
  }
  if (!doctor("anaesthetics"))
    return "There's no anaesthetist (an Anaesthetics consultant or registrar)";
  const practitioners = Object.values(state.staff).filter((s) => s.role === "theatre_practitioner");
  if (practitioners.length < PRACTITIONERS) return "There aren't two theatre practitioners";
  return null;
}

/** Waiting for an emergency operation, and in a state to go: on their trolley or ward bed. */
function readyForEmergency(state: SimState, p: Patient): boolean {
  const e = p.emergencyOp;
  if (!e || e.done || e.from !== null || p.death || p.transfer || p.bed === null) return false;
  if (p.path.length > 0 || operationFor(state, p.id)) return false;
  if (p.stage === "on_ward") return true;
  if (p.stage !== "awaiting_bed") return false;
  // Not while a porter is already wheeling them to the ward.
  return !jobsForPatient(state, p.id).some((j) => j.kind === "transfer" && j.state !== "open");
}

/**
 * A doctor of a specialty free to go to theatre now: resident or in, not
 * already in theatre or clinic, and not in the middle of something. If
 * there's none, an on-call consultant of it is called in.
 */
function doctorFor(state: SimState, specialty: SpecialtyId, call: boolean): Staff | undefined {
  const all = Object.values(state.staff).filter(
    (s) => s.specialty === specialty && (s.role === "consultant" || s.role === "registrar"),
  );
  const free = all.find((s) => {
    if (!onDuty(s) || inTheatre(state, s) || inClinic(state, s)) return false;
    const job = s.jobId === null ? undefined : state.jobs[s.jobId];
    return !job || job.state !== "working";
  });
  if (free) return free;
  if (call && !all.some((s) => s.onCall?.state === "called")) {
    const home = all.find((s) => s.onCall?.state === "home");
    if (home) callIn(state, home);
  }
  return undefined;
}

/** Takes a doctor off what they were about to do (it goes back on the board). */
function freeUp(state: SimState, s: Staff): void {
  const job = s.jobId === null ? undefined : state.jobs[s.jobId];
  if (job) unassignJob(state, job);
}

/** Tables in use by an operation. */
function busyTables(state: SimState): Set<number> {
  return new Set(Object.values(state.operations).map((o) => o.table));
}

/** A working theatre's operating table. */
function tableIn(state: SimState, roomId: number): PlacedObject | undefined {
  const room = state.rooms[roomId - 1];
  return room?.objectIds.map((id) => state.objects[id]!).find((o) => o.defId === "operating_table");
}

/**
 * Every minute: patients waiting for an emergency operation go to theatre
 * when they can. First choice, a theatre kept for emergencies; then the
 * next slot on a planned list of their specialty that's running (the
 * planned patient is cancelled); and once they're within a few hours of
 * due, any free theatre, calling the on-call team in if need be.
 */
function scheduleEmergencies(state: SimState): void {
  const waiting = Object.values(state.patients)
    .filter((p) => readyForEmergency(state, p))
    .sort((a, b) => a.emergencyOp!.due - b.emergencyOp!.due);
  for (const p of waiting) {
    const e = p.emergencyOp!;
    const practitioners = freePractitioners(state);
    if (practitioners.length < PRACTITIONERS) return;
    const team = practitioners.slice(0, PRACTITIONERS);
    const busy = busyTables(state);
    const theatres = state.rooms.filter((r) => r.valid && r.typeId === "theatre");

    // 1. A theatre kept for emergencies.
    const cepod = theatres
      .filter((r) => r.emergency)
      .map((r) => tableIn(state, r.id))
      .find((t) => t && !busy.has(t.id));
    if (cepod) {
      const surgeon = doctorFor(state, e.specialty, true);
      const anaesthetist = doctorFor(state, "anaesthetics", true);
      if (surgeon && anaesthetist) {
        go(state, p, cepod, surgeon, anaesthetist, team);
        continue;
      }
    }

    // 2. The next slot on a planned list of their specialty.
    const live = liveLists(state).find(
      (l) =>
        l.list.surgeon.specialty === e.specialty &&
        !busy.has(l.table.id) &&
        !Object.values(state.operations).some((o) => o.surgeonId === l.list.surgeon.id),
    );
    if (live) {
      const next = Object.values(state.referrals)
        .filter((r) => {
          const b = r.booking;
          return (
            r.kind === "surgery" &&
            b?.staffId === live.list.surgeon.id &&
            b.day === live.list.day &&
            b.half === live.list.half
          );
        })
        .sort((a, b) => a.booking!.at - b.booking!.at)[0];
      if (next) {
        state.today.stats.bumped++;
        cancelOnTheDay(state, next, "an emergency operation took their place");
      }
      go(state, p, live.table, live.list.surgeon, live.list.anaesthetist!, team);
      continue;
    }

    // 3. Close to due: any free theatre not running a list, with whoever's free or on call.
    if (state.tick < e.due - EMERGENCY_ANY_THEATRE_HOURS * 60 * TICKS_PER_MINUTE) continue;
    const listed = new Set(liveLists(state).map((l) => l.table.id));
    const table = theatres
      .map((r) => tableIn(state, r.id))
      .find((t) => t && !busy.has(t.id) && !listed.has(t.id));
    if (!table) continue;
    const surgeon = doctorFor(state, e.specialty, true);
    const anaesthetist = doctorFor(state, "anaesthetics", true);
    if (surgeon && anaesthetist) go(state, p, table, surgeon, anaesthetist, team);
  }
}

function go(
  state: SimState,
  p: Patient,
  table: PlacedObject,
  surgeon: Staff,
  anaesthetist: Staff,
  practitioners: Staff[],
): void {
  freeUp(state, surgeon);
  freeUp(state, anaesthetist);
  p.emergencyOp!.from = p.stage === "on_ward" ? "ward" : "ae";
  // A porter on the way to take them to the ward stands down.
  for (const job of jobsForPatient(state, p.id)) if (job.kind === "transfer") removeJob(state, job);
  startOperation(state, p, table, surgeon, anaesthetist, practitioners, true);
}

/**
 * The second practitioner fetches an emergency patient and wheels them to
 * the table on their bed or trolley. True once they're on the table.
 */
function wheelToTheatre(state: SimState, op: Operation, p: Patient, table: PlacedObject): boolean {
  if (p.stage === "in_theatre") return true;
  const porter = state.staff[op.practitionerIds[1] ?? op.practitionerIds[0]!];
  if (p.stage !== "to_theatre") {
    const bed = p.bed === null ? undefined : state.objects[p.bed];
    if (porter && bed && headTo(state, porter, bedside(state, bed)) !== "arrived") return false;
    // Off they go. A ward bed is kept for their return; an A&E trolley is
    // left for cleaning, and they've left A&E.
    if (p.emergencyOp!.from === "ward") p.homeBed = p.bed;
    else if (p.bed !== null) {
      release(state, p.bed, 0, p.id);
      dirtyCouch(state, p.bed);
      recordDeparture(state, p);
    }
    for (const job of jobsForPatient(state, p.id)) if (job.kind === "obs") removeJob(state, job);
    p.bed = table.id;
    p.stage = "to_theatre";
  }
  const from = { x: Math.round(p.x), y: Math.round(p.y) };
  const stop = trolleyStop(state, from, table);
  let arrival = stop
    ? headTo(state, p, restPoint(table), stop, true)
    : headTo(state, p, restPoint(table), bedside(state, table));
  if (arrival === "no_route") arrival = headTo(state, p, restPoint(table), bedside(state, table));
  if (porter) {
    porter.prevX = porter.x;
    porter.prevY = porter.y;
    porter.x = p.x;
    porter.y = p.y;
    porter.path = [];
    porter.dest = null;
  }
  return arrival === "arrived";
}

/** The emergency operation starts: counted, on time or not, and its tariff earned. */
function startEmergency(state: SimState, p: Patient): void {
  const e = p.emergencyOp!;
  e.done = true;
  const stats = state.today.stats;
  stats.emergencyOps++;
  if (state.tick <= e.due) stats.emergencyOnTime++;
  earnEmergency(state, emergencyOpOf(p)?.tariff ?? 0);
}
