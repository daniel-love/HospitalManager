/**
 * Deterioration and cardiac arrest (GAME_DESIGN §5.2, §5.6, §7).
 *
 * Some majors patients start to get worse before they're treated. Staff
 * notice once the early warning score (NEWS2) reaches the urgent level and
 * someone is looking: a clinician working with them, a set of observations,
 * or a nurse at a station with their trolley in sight. Noticing escalates
 * them for an urgent doctor review and buys time; the stabilising pathway
 * step ends the danger.
 *
 * Nobody noticing, or no treatment in time, ends in a cardiac arrest: a crash
 * call pulls a doctor and a nurse off whatever they're doing, and a patient
 * safety incident is recorded with its contributing factors.
 *
 * For now every resuscitation ends with a transfer to intensive care. Deaths,
 * with the full UK process (§5.6), come in a later M3 step.
 */
import { conditionById, roleNames, roomById, staffRoleById } from "@data/catalogue";
import {
  ESCALATION_GRACE_MINS,
  MAX_INCIDENTS,
  MONITOR_RESPONSE_DISTANCE,
  NEWS_BASE,
  NEWS_PEAK,
  NEWS_URGENT,
  RESUS_MINS,
  RESUS_WAIT_LIMIT_MINS,
} from "@data/monitoring";
import {
  ROSC_CHANCE,
  ROSC_CHANCE_ARREST_TEAM,
  ROSC_LOSS_PER_MIN,
  ROSC_MIN_CHANCE,
} from "@data/deaths";
import { debrief, die } from "./deaths";
import type { Incident, Patient, Point, Staff } from "../agents";
import { emit } from "../events";
import { couchStatus, frontOf, release, seatApproach } from "../places";
import { chance } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, TICKS_PER_MINUTE } from "../time";
import { isStandable } from "../world/objects";
import { roomOfObject } from "../world/rooms";
import {
  dirtyCouch,
  ESCALATED_DUE,
  jobsForPatient,
  postJob,
  removeJob,
  RESUS_DUE,
  ticksFor,
} from "./jobBoard";
import { bedCover, monitorTooFar, nurseStations, obsInterval, watcherOf } from "./monitoring";
import { stop } from "./movement";
import { formatWait, inAE, leave, releaseSeat } from "./patients";

const mins = (ticks: number) => Math.round(ticks / TICKS_PER_MINUTE);

function clockAt(tick: number): string {
  const { hour, minute } = clockFromTick(tick);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Rolls whether a new patient will deteriorate, and when. */
export function rollDeterioration(state: SimState, p: Patient): void {
  const d = conditionById.get(p.conditionId)!.deterioration;
  if (!d || !chance(state.rng, d.chance)) return;
  const onset = state.tick + ticksFor(state.rng, d.onsetMins);
  p.deterioration = { onset, crash: onset + ticksFor(state.rng, d.warningMins), noticed: null };
}

/** The early warning score (NEWS2) a set of observations would show now. */
export function newsScore(state: SimState, p: Patient): number {
  const d = p.deterioration;
  if (!d || state.tick < d.onset) return NEWS_BASE;
  const progress = Math.min(1, (state.tick - d.onset) / Math.max(1, d.crash - d.onset));
  return Math.round(NEWS_BASE + (NEWS_PEAK - NEWS_BASE) * progress);
}

export function updateDeterioration(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const beingSeen = new Map<number, Staff>();
  for (const j of Object.values(state.jobs)) {
    const s = j.staffId === null ? undefined : state.staff[j.staffId];
    if (j.state === "working" && j.patientId !== null && s) beingSeen.set(j.patientId, s);
  }
  for (const p of Object.values(state.patients)) {
    const d = p.deterioration;
    if (!d || p.stage === "leaving") continue;
    if (p.stage === "collapsed") {
      checkArrestTeam(state, p);
      continue;
    }
    if (state.tick < d.onset) continue;
    if (d.noticed === null && newsScore(state, p) >= NEWS_URGENT) {
      const onBed =
        p.bed !== null &&
        (p.stage === "in_cubicle" || p.stage === "awaiting_bed") &&
        p.path.length === 0;
      const seenBy = beingSeen.get(p.id);
      const watcher = onBed ? watcherOf(state, p.bed!) : undefined;
      if (p.stage === "awaiting_handover") notice(state, p, "crew", "with them");
      else if (seenBy) notice(state, p, seenBy, "with them");
      else if (watcher) notice(state, p, watcher.nurse, watcher.remote ? "monitor" : "station");
    }
    if (state.tick >= d.crash) collapse(state, p);
  }
}

/**
 * Staff (or the ambulance crew, who stay with their patient until handover)
 * spotted a deteriorating patient: escalate for an urgent doctor review.
 * `how` says whether they were with the patient or watching from a station.
 */
export function notice(
  state: SimState,
  p: Patient,
  who: Staff | "crew",
  how: "with them" | "station" | "monitor" | "obs",
): void {
  const d = p.deterioration!;
  if (d.noticed !== null) return;
  const news = newsScore(state, p);
  d.noticed = state.tick;
  d.crash += ESCALATION_GRACE_MINS * TICKS_PER_MINUTE;
  if (p.category > 2) p.category = 2;
  for (const job of jobsForPatient(state, p.id)) {
    if (["treat", "triage", "handover", "arrange_transfer"].includes(job.kind))
      job.dueTick = Math.min(job.dueTick, ESCALATED_DUE);
  }
  const name =
    who === "crew" ? "The ambulance crew" : `${staffRoleById.get(who.role)!.name} ${who.name}`;
  const where =
    how === "station"
      ? " from the nurse station"
      : how === "monitor"
        ? " on the central monitor"
        : "";
  emit(
    state,
    `${name} noticed ${p.name} getting worse${where} (NEWS2 ${news}) and escalated for an urgent doctor review`,
    "warn",
    at(p),
  );
}

const at = (p: Patient): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Where a patient is, for incident records: the room type's name. */
function whereIs(state: SimState, p: Patient): string {
  const grid = state.floors[0]!;
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const id = grid.roomId[y * grid.width + x] ?? 0;
  const room = id === 0 ? undefined : state.rooms[id - 1];
  return room ? (roomById.get(room.typeId)?.name ?? "department") : "department";
}

/**
 * Someone who arrests in a chair or on the toilet is lowered to the floor in
 * front of it for CPR, where the team (and later the porter) can reach them.
 */
function lowerToFloor(state: SimState, p: Patient): void {
  if (p.path.length > 0) return; // Walking: already on the floor.
  const seat = p.seat && state.objects[p.seat.objectId];
  const toilet = p.toilet && p.toilet.left >= 0 ? state.objects[p.toilet.objectId] : undefined;
  const spot = seat ? seatApproach(seat, p.seat!.slot) : toilet ? frontOf(toilet) : null;
  if (!spot || !isStandable(state.floors[0]!, spot.x, spot.y)) return;
  p.x = p.prevX = spot.x;
  p.y = p.prevY = spot.y;
}

/** Cardiac arrest: crash call, and an incident report. */
function collapse(state: SimState, p: Patient): void {
  const d = p.deterioration!;
  const causes = incidentCauses(state, p);
  for (const job of jobsForPatient(state, p.id)) removeJob(state, job);
  lowerToFloor(state, p);
  releaseSeat(state, p);
  if (p.toilet) release(state, p.toilet.objectId, 0, p.id);
  if (p.desk !== null) release(state, p.desk, 0, p.id);
  p.desk = null;
  p.bookingLeft = -1;
  p.toilet = null;
  p.standing = null;
  // Still on the couch only if they'd got there; otherwise it's free again.
  const onBed = p.stage === "in_cubicle" || p.stage === "triage";
  if (p.bed !== null && (!onBed || p.path.length > 0)) {
    release(state, p.bed, 0, p.id);
    p.bed = null;
  }
  stop(p);
  p.stage = "collapsed";
  p.category = 1; // A cardiac arrest is Immediate.
  p.retriaged = null;
  d.crash = state.tick;

  const where = whereIs(state, p);
  const condition = conditionById.get(p.conditionId)!;
  const incident: Incident = {
    id: state.nextIncidentId++,
    tick: state.tick,
    patientId: p.id,
    patientName: p.name,
    conditionId: p.conditionId,
    summary:
      d.noticed === null
        ? "Cardiac arrest after deteriorating unnoticed"
        : "Cardiac arrest after escalation, before treatment",
    where,
    at: at(p),
    causes,
  };
  state.incidents.push(incident);
  if (state.incidents.length > MAX_INCIDENTS) state.incidents.shift();
  state.today.stats.incidents++;
  emit(
    state,
    `Crash call: ${p.name} (${condition.name.toLowerCase()}) has gone into cardiac arrest in the ${where}. An incident report has been filed.`,
    "bad",
    at(p),
  );

  const duration = ticksFor(state.rng, RESUS_MINS);
  const base = {
    kind: "resus" as const,
    patientId: p.id,
    objectId: p.bed,
    roomType: "",
    dueTick: RESUS_DUE,
    durationTicks: duration,
  };
  postJob(state, { ...base, roles: ["junior_doctor"], step: 0 });
  postJob(state, { ...base, roles: ["nurse", "nurse_practitioner"], step: 1 });
}

/** No A&E doctor has reached the arrest in time: the hospital arrest team takes over. */
function checkArrestTeam(state: SimState, p: Patient): void {
  const lead = jobsForPatient(state, p.id).find((j) => j.kind === "resus" && j.step === 0);
  if (lead?.state === "working") return;
  if (state.tick - p.deterioration!.crash < RESUS_WAIT_LIMIT_MINS * TICKS_PER_MINUTE) return;
  const incident = [...state.incidents].reverse().find((i) => i.patientId === p.id);
  incident?.causes.push(
    `No A&E doctor reached the cardiac arrest within ${RESUS_WAIT_LIMIT_MINS} minutes; the hospital's arrest team took over`,
  );
  emit(
    state,
    `The hospital's cardiac arrest team took over ${p.name}'s resuscitation: no A&E doctor came`,
    "bad",
    at(p),
  );
  finishResus(state, p, null, null);
}

/**
 * The resuscitation is over. If the heart restarted (more likely the sooner
 * the team leader got there), they go to intensive care; if not, they have
 * died, and the team leader confirms it. Either way the team debriefs.
 * `lead` is null, and `startedAfterMins` too, when the hospital's arrest
 * team took over.
 */
export function finishResus(
  state: SimState,
  p: Patient,
  lead: Staff | null,
  startedAfterMins: number | null,
): void {
  const team = Object.values(state.jobs)
    .filter((j) => j.patientId === p.id && j.kind === "resus" && j.state === "working")
    .map((j) => state.staff[j.staffId!]!)
    .filter((s) => s !== lead);
  if (lead) team.unshift(lead);
  const rosc =
    startedAfterMins === null
      ? ROSC_CHANCE_ARREST_TEAM
      : Math.max(ROSC_MIN_CHANCE, ROSC_CHANCE - ROSC_LOSS_PER_MIN * startedAfterMins);
  const survived = chance(state.rng, rosc);
  if (survived) {
    const bed = p.bed;
    leave(state, p, "transferred");
    if (bed !== null && state.objects[bed]) dirtyCouch(state, bed);
    emit(state, `${p.name} was resuscitated and transferred to intensive care`, "info", at(p));
  } else {
    if (startedAfterMins !== null && startedAfterMins >= 1) {
      const incident = [...state.incidents].reverse().find((i) => i.patientId === p.id);
      incident?.causes.push(
        `The resuscitation team leader reached them ${Math.round(startedAfterMins)} minutes after the arrest`,
      );
    }
    die(state, p, false, true);
  }
  debrief(state, team, !survived);
}

/** Contributing factors, in plain English, for the incident record. */
function incidentCauses(state: SimState, p: Patient): string[] {
  const d = p.deterioration!;
  const causes: string[] = [];
  const condition = conditionById.get(p.conditionId)!;

  if (d.noticed === null) {
    causes.push(
      `Warning signs began ${formatWait(mins(state.tick - d.onset))} before the arrest, and nobody noticed`,
    );
  } else {
    const stabiliser = condition.pathway.find((s, i) => s.stabilises && i >= p.step);
    causes.push(
      `Escalated at ${clockAt(d.noticed)}, but ${stabiliser ? stabiliser.name.toLowerCase() : "treatment"} hadn't started ${formatWait(mins(state.tick - d.noticed))} later${delayReason(state, p)}`,
    );
  }

  const onBed = p.bed !== null && p.stage === "in_cubicle";
  if (onBed) {
    const room = roomOfObject(state, p.bed!);
    const name = room ? (roomById.get(room.typeId)?.name ?? "bay") : "bay";
    const cover = bedCover(state, p.bed!);
    if (nurseStations(state).length === 0) {
      causes.push(`There's no nurse station, so nobody was watching their trolley in the ${name}`);
    } else if (cover === "blind") {
      causes.push(`Their trolley in the ${name} isn't visible from any nurse station`);
      const far = monitorTooFar(state, p.bed!);
      if (far !== null) {
        causes.push(
          `The central monitor is a ${far} m walk away, beyond the ${MONITOR_RESPONSE_DISTANCE} m a nurse can respond in time`,
        );
      }
    } else if (cover === "curtained") {
      causes.push(
        `The curtains round their trolley in the ${name} were drawn, hiding them from the nurse station`,
      );
    } else if (cover === "unstaffed") {
      causes.push(
        `The nurse station that can see their trolley in the ${name} was empty: every nurse was busy`,
      );
    }
  } else if (p.stage === "awaiting_handover") {
    causes.push(
      `Still with the ambulance crew ${formatWait(mins(state.tick - p.times.arrived))} after arriving, waiting to be handed over`,
    );
  } else if (p.stage === "waiting_treatment" || p.stage === "waiting_triage") {
    const step = condition.pathway[p.step];
    const room = step ? roomById.get(step.room) : undefined;
    let text = `They were in the ${whereIs(state, p)}, where nobody watches patients continuously`;
    if (room && p.category > 0) {
      const c = couchStatus(state, room.id, step!.capabilities);
      text += `, waiting ${formatWait(mins(state.tick - (p.times.triaged ?? p.times.arrived)))} for a ${room.name}`;
      if (c.free === 0) text += ` (all ${c.total} in use or waiting to be cleaned)`;
    }
    causes.push(text);
  }

  const every = obsInterval(p);
  if (every !== null && p.obs) {
    const overdue = mins(state.tick - p.obs.tick) - every;
    causes.push(
      overdue > 0
        ? `Observations were ${formatWait(overdue)} overdue (due every ${every} min); the last, at ${clockAt(p.obs.tick)}, scored NEWS2 ${p.obs.news}`
        : `Last observations at ${clockAt(p.obs.tick)} scored NEWS2 ${p.obs.news}`,
    );
  } else if (p.times.triaged === null && p.stage !== "awaiting_handover") {
    const queue = Object.values(state.patients).filter((q) => q.stage === "waiting_triage").length;
    causes.push(
      `Not yet triaged after ${formatWait(mins(state.tick - p.times.arrived))}, with ${queue} waiting for triage`,
    );
  }

  const nurses = Object.values(state.staff).filter((s) => s.role === "nurse").length;
  const inDept = Object.values(state.patients).filter(inAE).length;
  causes.push(
    `${nurses === 1 ? "1 staff nurse" : `${nurses} staff nurses`} on duty for ${inDept === 1 ? "1 patient" : `${inDept} patients`} in A&E`,
  );
  return causes;
}

/** Why the patient's next treatment step is held up, as ": …" (or ""). */
function delayReason(state: SimState, p: Patient): string {
  const job = jobsForPatient(state, p.id).find(
    (j) => (j.kind === "treat" || j.kind === "handover") && j.state === "open",
  );
  if (!job) return "";
  const qualified = Object.values(state.staff).filter((s) => job.roles.includes(s.role));
  if (qualified.length === 0) return `: there are no ${roleNames(job.roles, true)}`;
  if (qualified.every((s) => s.jobId !== null)) {
    return qualified.length === 1
      ? `: the only ${roleNames(job.roles)} was busy`
      : `: all ${qualified.length} ${roleNames(job.roles, true)} were busy`;
  }
  if (job.objectId === null) {
    const c = couchStatus(state, job.roomType, job.capabilities);
    const room = roomById.get(job.roomType)?.name ?? job.roomType;
    if (c.free === 0) return `: no free ${room}`;
  }
  return "";
}
