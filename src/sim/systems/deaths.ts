/**
 * Death in hospital (GAME_DESIGN §5.6), following the real UK process. It is
 * never shown graphically; the cost is in the process. Each step ties up
 * particular staff, rooms and beds for a realistic time:
 *
 *   death → verification (the time is recorded)
 *     → the family told in the Relatives' Room (unexpected deaths)
 *     → last offices (two nurses; the bay stays closed)
 *     → a porter takes them to the Mortuary on a covered trolley
 *     → the bay is deep cleaned
 *     → Medical Examiner review (and for some, the coroner: days), by a
 *       consultant with the duty, in an office-hours session, who didn't
 *       treat them
 *     → released to the funeral director
 *
 * Expected deaths (end-of-life care on a ward) need no crash call, but should
 * happen in a side room. Unexpected deaths follow a failed resuscitation.
 * Staff involved lose morale; resuscitation teams have a short hot debrief.
 */
import { conditionById, roleNames, roomById, staffRoleById } from "@data/catalogue";
import {
  BODIES_PER_FRIDGE,
  BREAK_NEWS_MINS,
  CONTINGENCY_HOURS,
  CORONER_DAYS,
  CORONER_REFERRAL_CHANCE,
  DEBRIEF_MINS,
  DEEP_CLEAN_MINS,
  LAST_OFFICES_MINS,
  ME_REVIEW_MINS,
  ME_SESSION,
  MORALE_HIT_EXPECTED,
  MORALE_HIT_TEAM,
  MORALE_HIT_UNEXPECTED,
  MORALE_RECOVERY_PER_HOUR,
  MORALE_START,
  RELEASE_HOURS,
  VERIFY_MINS,
} from "@data/deaths";
import { onSite, type Incident, type Job, type Patient, type Point, type Staff } from "../agents";
import { emit, warn } from "../events";
import { bedside, deskStaffSpot, frontOf, holder, release, reserve } from "../places";
import { chance, nextFloat } from "../rng";
import type { PlacedObject, SimState } from "../state";
import {
  clockFromTick,
  isWeekday,
  MINUTES_PER_DAY,
  TICKS_PER_MINUTE,
  tickAt,
  WEEKDAY_NAMES,
} from "../time";
import { roomAt, roomOfObject } from "../world/rooms";
import { bedRouteExists } from "./admissions";
import { earn } from "./finance";
import { dirtyCouch, jobsForPatient, postJob, removeJob, ticksFor } from "./jobBoard";
import { headTo, stop } from "./movement";
import { recordDeparture, releaseSeat } from "./patients";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;
/** Rooms where the public wait: a covered trolley shouldn't pass through them. */
const PUBLIC_ROOMS = new Set(["waiting_area", "ae_reception"]);

const tileOf = (p: Patient): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** The name of the room someone is in, for records ("Majors Bay"), or "department". */
export function roomNameAt(state: SimState, at: Point): string {
  const room = roomAt(state, 0, at.x, at.y);
  return room ? (roomById.get(room.typeId)?.name ?? "department") : "department";
}

// ---------- Dying ----------

/**
 * A patient has died. `verified`: the resuscitation team leader confirmed
 * death at the end of the attempt; otherwise a verification job is posted.
 */
export function die(state: SimState, p: Patient, expected: boolean, verified: boolean): void {
  const where = roomNameAt(state, tileOf(p));
  for (const job of jobsForPatient(state, p.id)) removeJob(state, job);
  releaseSeat(state, p);
  if (p.toilet) release(state, p.toilet.objectId, 0, p.id);
  if (p.desk !== null) release(state, p.desk, 0, p.id);
  p.toilet = null;
  p.desk = null;
  p.standing = null;
  // They stay on their bed, if they were on one.
  const onBed = ["in_cubicle", "triage", "collapsed", "awaiting_bed", "on_ward"].includes(p.stage);
  if (p.bed !== null && (!onBed || p.path.length > 0)) {
    release(state, p.bed, 0, p.id);
    p.bed = null;
  }
  stop(p);
  const wasAdmitted = p.times.admitted !== null;
  p.stage = "deceased";
  p.outcome = "died";
  p.times.left = state.tick;
  p.deterioration = null;
  p.death = {
    tick: state.tick,
    expected,
    where,
    verified: verified ? state.tick : null,
    familyTold: expected ? state.tick : null,
    lastOffices: null,
    inMortuary: null,
    fridge: null,
    meReviewed: null,
    coroner: !expected && chance(state.rng, CORONER_REFERRAL_CHANCE),
    releaseAt: null,
  };

  const stats = state.today.stats;
  stats.deaths++;
  if (!expected) stats.unexpectedDeaths++;
  const condition = conditionById.get(p.conditionId)!;
  // The attendance or inpatient spell is still paid for.
  if (wasAdmitted) earn(state, condition.admission?.tariff ?? 0);
  else {
    recordDeparture(state, p);
    earn(state, condition.tariff);
  }

  if (expected) {
    emit(
      state,
      `${p.name}, who was receiving end-of-life care, died peacefully on the ward.`,
      "info",
      tileOf(p),
    );
    const room = p.bed === null ? undefined : roomOfObject(state, p.bed);
    if (room?.typeId !== "side_room") {
      complain(
        state,
        `${p.name} died in an open bay rather than a side room. Their family have complained about the lack of privacy.`,
        tileOf(p),
      );
    }
  } else {
    emit(
      state,
      `${p.name} died in the ${where} after an unsuccessful resuscitation.`,
      "bad",
      tileOf(p),
    );
    recordOnIncident(state, p);
    // The whole nursing team feels it.
    for (const s of Object.values(state.staff))
      if (s.role === "nurse") lowerMorale(s, MORALE_HIT_TEAM);
  }

  if (verified) afterVerification(state, p);
  else {
    postJob(state, {
      kind: "verify_death",
      roles: expected ? ["nurse", "junior_doctor"] : ["junior_doctor", "nurse_practitioner"],
      patientId: p.id,
      roomType: "",
      dueTick: state.tick,
      durationTicks: ticksFor(state.rng, VERIFY_MINS),
    });
  }
}

/** The arrest's incident record now records the death. */
function recordOnIncident(state: SimState, p: Patient): void {
  const incident: Incident | undefined = [...state.incidents]
    .reverse()
    .find((i) => i.patientId === p.id);
  if (!incident) return;
  incident.summary = `Death: ${incident.summary.charAt(0).toLowerCase()}${incident.summary.slice(1)}`;
  incident.causes.push("The resuscitation attempt was unsuccessful");
}

function complain(state: SimState, text: string, at: Point): void {
  state.today.stats.complaints++;
  emit(state, text, "warn", at);
}

/** Verified: the family can be told, and last offices begin. */
function afterVerification(state: SimState, p: Patient): void {
  const d = p.death!;
  if (d.familyTold === null) {
    postJob(state, {
      kind: "break_news",
      roles: ["junior_doctor"],
      patientId: p.id,
      roomType: "relatives_room",
      dueTick: state.tick,
      durationTicks: ticksFor(state.rng, BREAK_NEWS_MINS),
    });
  }
  const lastOffices = {
    kind: "last_offices" as const,
    roles: ["nurse" as const],
    patientId: p.id,
    roomType: "",
    dueTick: state.tick,
    durationTicks: ticksFor(state.rng, LAST_OFFICES_MINS),
  };
  postJob(state, { ...lastOffices, step: 0 });
  postJob(state, { ...lastOffices, step: 1 });
}

/** A resuscitation is over: everyone involved has a short hot debrief, and it weighs on them. */
export function debrief(state: SimState, team: Staff[], died: boolean): void {
  for (const s of team) {
    if (died) lowerMorale(s, MORALE_HIT_UNEXPECTED);
    const job = postJob(state, {
      kind: "debrief",
      roles: [s.role],
      roomType: "",
      dueTick: state.tick,
      durationTicks: ticksFor(state.rng, DEBRIEF_MINS),
    });
    job.staffId = s.id;
    job.state = "working";
    s.jobId = job.id;
  }
}

// ---------- The Medical Examiner ----------

/** Whether it's a Medical Examiner session: a weekday, in office hours. */
export function inMeSession(tick: number): boolean {
  const c = clockFromTick(tick);
  return isWeekday(c) && c.hour >= ME_SESSION.startHour && c.hour < ME_SESSION.endHour;
}

/** When the next Medical Examiner session starts, from `tick` (now, if one's on). */
export function nextMeSession(tick: number): number {
  if (inMeSession(tick)) return tick;
  const c = clockFromTick(tick);
  for (let day = c.day; day < c.day + 8; day++) {
    const start = tickAt(day, ME_SESSION.startHour);
    if (start > tick && isWeekday(clockFromTick(start))) return start;
  }
  return tick + MINUTES_PER_DAY * TICKS_PER_MINUTE; // Unreachable.
}

/** Consultants with the Medical Examiner duty (whether or not they're free). */
export function medicalExaminers(state: SimState): Staff[] {
  return Object.values(state.staff).filter((s) => s.meDuty);
}

/**
 * Whether a member of staff can be this death's Medical Examiner: a
 * consultant with the duty, in a session, who didn't treat them.
 */
export function canReviewDeath(state: SimState, s: Staff, p: Patient | undefined): boolean {
  return s.meDuty && onSite(s) && inMeSession(state.tick) && !!p && !p.consultants.includes(s.id);
}

function lowerMorale(s: Staff, by: number): void {
  s.morale = Math.max(0, s.morale - by);
}

// ---------- Jobs ----------

/** Where a death job happens: the place to claim, or null if it can't start yet. */
export function claimDeathPlace(state: SimState, job: Job): Point | null {
  const p = job.patientId === null ? undefined : state.patients[job.patientId];
  switch (job.kind) {
    case "break_news": {
      // In the Relatives' Room if there's one free; otherwise wherever they can.
      const sofa = relativesSofa(state);
      if (sofa) {
        job.objectId = sofa.id;
        return frontOf(sofa);
      }
      return p ? tileOf(p) : null;
    }
    case "me_review": {
      const desk = freeDesk(state);
      if (!desk) return null;
      job.objectId = desk.id;
      return deskStaffSpot(desk);
    }
    case "to_mortuary":
      return p ? claimMortuarySpace(state, job, p) : null;
    default:
      return p ? tileOf(p) : null;
  }
}

/** A sofa in a working Relatives' Room nobody is using. */
function relativesSofa(state: SimState): PlacedObject | undefined {
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== "relatives_room") continue;
    for (const id of room.objectIds) {
      const o = state.objects[id]!;
      if (o.defId === "sofa" && holder(state, o.id, "staff") === undefined) return o;
    }
  }
  return undefined;
}

/** Any desk with nobody sitting behind it. */
function freeDesk(state: SimState): PlacedObject | undefined {
  return Object.values(state.objects)
    .filter((o) => o.defId === "desk" && holder(state, o.id, "staff") === undefined)
    .sort((a, b) => a.id - b.id)[0];
}

/** Mortuary fridge units in working mortuaries, in id order. */
function fridges(state: SimState): PlacedObject[] {
  const out: PlacedObject[] = [];
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== "mortuary") continue;
    for (const id of room.objectIds) {
      if (state.objects[id]!.defId === "mortuary_fridge") out.push(state.objects[id]!);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Mortuary spaces: how many, and how many are taken. */
export function mortuarySpaces(state: SimState): { total: number; taken: number } {
  let total = 0;
  let taken = 0;
  for (const f of fridges(state)) {
    for (let slot = 0; slot < BODIES_PER_FRIDGE; slot++) {
      total++;
      if (holder(state, f.id, slot) !== undefined) taken++;
    }
  }
  return { total, taken };
}

/** A free fridge space a covered trolley can be wheeled to, reserved for the patient. */
function claimMortuarySpace(state: SimState, job: Job, p: Patient): Point | null {
  if (p.stage !== "deceased" || p.death?.lastOffices == null) return null;
  const from = tileOf(p);
  // Already holding a space (the porter was called away): keep it.
  if (job.objectId !== null && holder(state, job.objectId, job.step) === p.id) return from;
  for (const f of fridges(state)) {
    for (let slot = 0; slot < BODIES_PER_FRIDGE; slot++) {
      if (holder(state, f.id, slot) !== undefined) continue;
      if (!bedRouteExists(state, from, frontOf(f))) break;
      reserve(state, f.id, slot, p.id);
      job.objectId = f.id;
      job.step = slot;
      return from;
    }
  }
  return null;
}

/** Walks staff to the job, then works it. */
export function runDeathJob(state: SimState, job: Job, staff: Staff, p: Patient | undefined): void {
  if (job.kind === "debrief") {
    if (++job.progress >= job.durationTicks) removeJob(state, job);
    return;
  }
  if (job.kind === "to_mortuary") {
    if (p) runToMortuary(state, job, staff, p);
    else removeJob(state, job);
    return;
  }
  const place = job.objectId === null ? undefined : state.objects[job.objectId];
  const spot =
    job.kind === "me_review" && place
      ? deskStaffSpot(place)
      : job.kind === "break_news" && place
        ? frontOf(place)
        : p
          ? beside(state, p)
          : null;
  if (!spot) {
    removeJob(state, job);
    return;
  }
  if (job.state === "assigned") {
    if (headTo(state, staff, spot) !== "arrived") return;
    job.state = "working";
    if (place && (job.kind === "me_review" || job.kind === "break_news")) {
      reserve(state, place.id, "staff", staff.id);
    }
  }
  if (++job.progress < job.durationTicks) return;
  if (place) release(state, place.id, "staff", staff.id);
  removeJob(state, job);
  if (!p?.death) return;
  const d = p.death;
  switch (job.kind) {
    case "verify_death":
      d.verified = state.tick;
      if (d.expected) lowerMorale(staff, MORALE_HIT_EXPECTED);
      afterVerification(state, p);
      break;
    case "break_news":
      d.familyTold = state.tick;
      lowerMorale(staff, MORALE_HIT_EXPECTED);
      if (!place) {
        complain(
          state,
          `${p.name}'s family were given the news in a corridor: there's no Relatives' Room. They have complained.`,
          spot,
        );
      }
      break;
    case "last_offices":
      lowerMorale(staff, MORALE_HIT_EXPECTED / 2);
      if (!jobsForPatient(state, p.id).some((j) => j.kind === "last_offices")) {
        d.lastOffices = state.tick;
      }
      break;
    case "me_review": {
      d.meReviewed = state.tick;
      const hours = RELEASE_HOURS[0] + (RELEASE_HOURS[1] - RELEASE_HOURS[0]) * nextFloat(state.rng);
      const coronerDays = d.coroner
        ? CORONER_DAYS[0] + (CORONER_DAYS[1] - CORONER_DAYS[0]) * nextFloat(state.rng)
        : 0;
      d.releaseAt = state.tick + Math.round((hours + coronerDays * 24) * TICKS_PER_HOUR);
      break;
    }
  }
}

/** Beside the deceased: their bedside, or where they lie. */
function beside(state: SimState, p: Patient): Point {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  return bed ? bedside(state, bed) : tileOf(p);
}

/** The porter takes the deceased, covered, to their mortuary space. */
function runToMortuary(state: SimState, job: Job, porter: Staff, p: Patient): void {
  const fridge = job.objectId === null ? undefined : state.objects[job.objectId];
  if (!fridge) {
    removeJob(state, job);
    return;
  }
  const dest = frontOf(fridge);
  if (job.state === "assigned") {
    if (headTo(state, porter, beside(state, p)) !== "arrived") return;
    job.state = "working";
    p.stage = "to_mortuary";
    if (p.bed !== null) {
      release(state, p.bed, 0, p.id);
      if (state.objects[p.bed]) dirtyCouch(state, p.bed, DEEP_CLEAN_MINS);
      p.bed = null;
    }
    headTo(state, p, dest, dest, true);
    if (passesPublicArea(state, p.path)) {
      complain(
        state,
        `${p.name} was taken to the mortuary through a public waiting area. Families have complained.`,
        tileOf(p),
      );
    }
  }
  let arrival = headTo(state, p, dest, dest, true);
  if (arrival === "no_route") arrival = headTo(state, p, dest);
  porter.prevX = porter.x;
  porter.prevY = porter.y;
  porter.x = p.x;
  porter.y = p.y;
  porter.path = [];
  porter.dest = null;
  if (arrival !== "arrived") return;
  removeJob(state, job);
  p.stage = "in_mortuary";
  p.x = p.prevX = fridge.x;
  p.y = p.prevY = fridge.y;
  p.death!.inMortuary = state.tick;
  p.death!.fridge = { objectId: fridge.id, slot: job.step };
}

/** Whether a route ([x0, y0, x1, y1, …]) crosses a waiting area or reception. */
function passesPublicArea(state: SimState, path: number[]): boolean {
  for (let i = 0; i < path.length; i += 2) {
    const room = roomAt(state, 0, Math.round(path[i]!), Math.round(path[i + 1]!));
    if (room && PUBLIC_ROOMS.has(room.typeId)) return true;
  }
  return false;
}

// ---------- Each minute ----------

export function updateDeaths(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  for (const p of Object.values(state.patients)) {
    const d = p.death;
    if (!d) continue;
    const jobs = jobsForPatient(state, p.id);
    if (
      p.stage === "deceased" &&
      d.lastOffices !== null &&
      !jobs.some((j) => j.kind === "to_mortuary")
    ) {
      postJob(state, {
        kind: "to_mortuary",
        roles: ["porter"],
        patientId: p.id,
        roomType: "mortuary",
        dueTick: state.tick,
        durationTicks: 1,
      });
    }
    if (p.stage === "deceased" && d.lastOffices !== null) {
      const spaces = mortuarySpaces(state);
      if (spaces.taken >= spaces.total) noMortuarySpace(state, p);
      else if (!mortuaryReachable(state, p)) {
        warn(
          state,
          "mortuary_route",
          2 * TICKS_PER_HOUR,
          `${p.name} can't be taken to the mortuary: there's no bed-width route (double doors and 2-wide corridors) from the ${d.where}.`,
          "bad",
          tileOf(p),
        );
      }
      if (state.tick - d.lastOffices >= CONTINGENCY_HOURS * TICKS_PER_HOUR) {
        contingency(state, p);
        continue;
      }
    }
    if (p.stage === "in_mortuary") {
      if (d.meReviewed === null && !jobs.some((j) => j.kind === "me_review")) {
        postJob(state, {
          kind: "me_review",
          roles: ["consultant"],
          patientId: p.id,
          roomType: "",
          dueTick: d.tick,
          durationTicks: ticksFor(state.rng, ME_REVIEW_MINS),
        });
      }
      if (d.releaseAt !== null && state.tick >= d.releaseAt) releaseBody(state, p);
    }
  }
  if (state.tick % TICKS_PER_HOUR === 0) {
    for (const s of Object.values(state.staff)) {
      if (s.morale < MORALE_START)
        s.morale = Math.min(MORALE_START, s.morale + MORALE_RECOVERY_PER_HOUR);
    }
  }
}

/** No mortuary space: the deceased stays in the bay, which stays closed. Recorded once. */
function noMortuarySpace(state: SimState, p: Patient): void {
  const key = `no_mortuary_${p.id}`;
  if (state.alerts[key] !== undefined) return;
  state.alerts[key] = state.tick;
  const total = mortuarySpaces(state).total;
  const why = total === 0 ? "there's no working Mortuary" : `all ${total} mortuary spaces are full`;
  state.incidents.push({
    id: state.nextIncidentId++,
    tick: state.tick,
    patientId: p.id,
    patientName: p.name,
    conditionId: p.conditionId,
    summary: "No mortuary space: a deceased patient kept in the bay",
    where: p.death!.where,
    at: tileOf(p),
    causes: [
      `${p.name} couldn't be moved after last offices: ${why}`,
      "The bay stays closed to other patients until there's space",
    ],
  });
  state.today.stats.incidents++;
  warn(
    state,
    "mortuary_full",
    2 * TICKS_PER_HOUR,
    `A deceased patient can't be moved: ${why}.`,
    "bad",
    tileOf(p),
  );
}

/**
 * Still waiting for a mortuary space hours after last offices: the
 * contingency arrangement takes them, freeing the bay (or wherever they are).
 */
function contingency(state: SimState, p: Patient): void {
  for (const job of jobsForPatient(state, p.id)) removeJob(state, job);
  if (p.bed !== null) {
    release(state, p.bed, 0, p.id);
    if (state.objects[p.bed]) dirtyCouch(state, p.bed, DEEP_CLEAN_MINS);
  }
  emit(
    state,
    `${p.name} was taken to an external body store under contingency arrangements: there was no mortuary space.`,
    "warn",
    tileOf(p),
  );
  delete state.patients[p.id];
}

/** The funeral director collects them; their mortuary space is free again. */
function releaseBody(state: SimState, p: Patient): void {
  const f = p.death!.fridge;
  if (f) release(state, f.objectId, f.slot, p.id);
  emit(state, `The funeral director has collected ${p.name} from the mortuary.`, "info", tileOf(p));
  delete state.patients[p.id];
}

// ---------- Where things stand ----------

/** The steps after a death, in order. "family" runs alongside last offices. */
export type DeathStep =
  "verify" | "family" | "last_offices" | "to_mortuary" | "me_review" | "release";

/**
 * underway: someone is doing it (or, for release, it's only a matter of time);
 * waiting: it'll start when someone is free; blocked: it can't happen until
 * the player changes something.
 */
export type DeathProgress = "underway" | "waiting" | "blocked";

export interface DeathStatus {
  step: DeathStep;
  progress: DeathProgress;
  /** In plain English, e.g. "Waiting for a free porter". */
  reason: string;
}

/** The steps that apply to this death, in order. */
export function deathSteps(p: Patient): DeathStep[] {
  return p.death!.expected
    ? ["verify", "last_offices", "to_mortuary", "me_review", "release"]
    : ["verify", "family", "last_offices", "to_mortuary", "me_review", "release"];
}

/** Whether a step is done. */
export function deathStepDone(p: Patient, step: DeathStep): boolean {
  const d = p.death!;
  switch (step) {
    case "verify":
      return d.verified !== null;
    case "family":
      return d.familyTold !== null;
    case "last_offices":
      return d.lastOffices !== null;
    case "to_mortuary":
      return d.inMortuary !== null;
    case "me_review":
      return d.meReviewed !== null;
    case "release":
      return false;
  }
}

/** The step holding things up (the family aside: that runs alongside), and why. */
export function deathStatus(state: SimState, p: Patient): DeathStatus {
  const step = deathSteps(p).find((s) => s !== "family" && !deathStepDone(p, s)) ?? "release";
  return deathStepStatus(state, p, step);
}

/** Where one step stands. */
export function deathStepStatus(state: SimState, p: Patient, step: DeathStep): DeathStatus {
  const d = p.death!;
  const jobs = jobsForPatient(state, p.id);
  const status = (progress: DeathProgress, reason: string): DeathStatus => ({
    step,
    progress,
    reason,
  });
  const onStaff = (role: Staff["role"]) => Object.values(state.staff).some((s) => s.role === role);
  /** Someone has the job: they're on the way, or doing it. */
  const taken = (kind: Job["kind"], doing: (who: string) => string): DeathStatus | null => {
    const job = jobs.find((j) => j.kind === kind && j.state !== "open");
    const s = job?.staffId == null ? undefined : state.staff[job.staffId];
    if (!job || !s) return null;
    const who = `${staffRoleById.get(s.role)!.name} ${s.name}`;
    return status("underway", job.state === "working" ? doing(who) : `${who} is on the way`);
  };
  /** Nobody has it yet: is there anyone who could? */
  const unstaffed = (roles: Staff["role"][]): DeathStatus | null =>
    roles.some(onStaff) ? null : status("blocked", `No ${roleNames(roles, true)} on staff`);

  switch (step) {
    case "verify":
      return (
        taken("verify_death", (who) => `${who} is verifying the death`) ??
        unstaffed(
          d.expected ? ["nurse", "junior_doctor"] : ["junior_doctor", "nurse_practitioner"],
        ) ??
        status("waiting", "Waiting for a free nurse or doctor to verify the death")
      );
    case "family": {
      if (d.verified === null) return status("waiting", "Once the death is verified");
      const noRoom = !state.rooms.some((r) => r.valid && r.typeId === "relatives_room");
      const where = noRoom ? " (no Relatives' Room: it'll be in a corridor)" : "";
      return (
        taken("break_news", (who) => `${who} is speaking with the family${where}`) ??
        unstaffed(["junior_doctor"]) ??
        status(noRoom ? "blocked" : "waiting", `Waiting for a free doctor${where}`)
      );
    }
    case "last_offices": {
      if (d.verified === null) return status("waiting", "Once the death is verified");
      const lo = jobs.filter((j) => j.kind === "last_offices");
      const here = lo.filter((j) => j.state === "working").length;
      const coming = lo.filter((j) => j.state === "assigned").length;
      if (here === 2) return status("underway", "Two nurses are performing last offices");
      if (here + coming > 0) {
        return status(
          "underway",
          here === 1 && coming === 0
            ? "One nurse is performing last offices; the second is busy"
            : `Nurses are on the way (${here} of 2 here)`,
        );
      }
      return unstaffed(["nurse"]) ?? status("waiting", "Waiting for two free nurses");
    }
    case "to_mortuary": {
      if (d.lastOffices === null) return status("waiting", "Once last offices are done");
      const porter = taken("to_mortuary", (who) => `${who} is taking them to the mortuary`);
      if (porter) return porter;
      if (p.stage === "to_mortuary") return status("underway", "Being taken to the mortuary");
      const left = CONTINGENCY_HOURS * TICKS_PER_HOUR - (state.tick - d.lastOffices);
      const h = Math.floor(left / TICKS_PER_HOUR);
      const m = Math.floor((left % TICKS_PER_HOUR) / TICKS_PER_MINUTE);
      const countdown = `. Contingency store in ${h > 0 ? `${h}h ` : ""}${m}m`;
      const spaces = mortuarySpaces(state);
      if (spaces.total === 0) return status("blocked", `No working Mortuary${countdown}`);
      if (spaces.taken >= spaces.total) {
        return status("blocked", `The mortuary is full (${spaces.total} spaces)${countdown}`);
      }
      if (!mortuaryReachable(state, p)) {
        return status(
          "blocked",
          `No bed-width route to a free mortuary space: it needs double doors and 2-wide corridors${countdown}`,
        );
      }
      return unstaffed(["porter"]) ?? status("waiting", "Waiting for a free porter");
    }
    case "me_review": {
      if (d.inMortuary === null) return status("waiting", "Once they're in the mortuary");
      const busy = taken("me_review", (who) => `${who} is reviewing the notes`);
      if (busy) return busy;
      const examiners = medicalExaminers(state);
      if (examiners.length === 0) {
        return status("blocked", "No consultant has the Medical Examiner duty");
      }
      const independent = examiners.filter((s) => !p.consultants.includes(s.id));
      if (independent.length === 0) {
        return status(
          "blocked",
          examiners.length === 1
            ? "The only Medical Examiner treated them, so can't review their death: give another consultant the duty"
            : "Every Medical Examiner treated them: give another consultant the duty",
        );
      }
      if (!Object.values(state.objects).some((o) => o.defId === "desk")) {
        return status("blocked", "No desk for the Medical Examiner to work at");
      }
      if (!inMeSession(state.tick)) {
        const c = clockFromTick(nextMeSession(state.tick));
        const hh = String(c.hour).padStart(2, "0");
        return status(
          "waiting",
          `Medical Examiner sessions are Monday to Friday, ${String(ME_SESSION.startHour).padStart(2, "0")}:00 to ${ME_SESSION.endHour}:00. Next: ${WEEKDAY_NAMES[c.weekday]} ${hh}:00`,
        );
      }
      return freeDesk(state)
        ? status("waiting", "Waiting for the Medical Examiner")
        : status("waiting", "Waiting for a free desk");
    }
    case "release": {
      if (d.releaseAt === null)
        return status("waiting", "Once the Medical Examiner has reviewed them");
      const c = clockFromTick(d.releaseAt);
      const when = `Day ${c.day} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
      return status(
        "underway",
        d.coroner
          ? `With the coroner: the funeral director collects about ${when}`
          : `The funeral director collects about ${when}`,
      );
    }
  }
}

/** Whether a covered trolley could reach any free mortuary space from where they lie. */
function mortuaryReachable(state: SimState, p: Patient): boolean {
  const from = tileOf(p);
  for (const f of fridges(state)) {
    for (let slot = 0; slot < BODIES_PER_FRIDGE; slot++) {
      if (holder(state, f.id, slot) === undefined && bedRouteExists(state, from, frontOf(f))) {
        return true;
      }
    }
  }
  return false;
}
