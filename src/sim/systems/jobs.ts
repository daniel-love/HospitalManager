/**
 * The job board (ARCHITECTURE §4.3, GAME_DESIGN §6.4). Staff are never told
 * what to do: the most urgent open job (earliest due) goes to the nearest
 * idle member of staff with the most preferred role that has anyone free. For triage and a patient's first
 * treatment step, a free couch is found at the same moment, as when a nurse
 * calls the next patient through. Work starts once both have arrived.
 *
 * Observations and crash calls happen wherever the patient is. A crash call
 * that finds nobody free pulls the nearest qualified person off other work.
 */
import { conditionById } from "@data/catalogue";
import { onSite, type Job, type Patient, type Point, type Staff } from "../agents";
import {
  bedside,
  freeCouch,
  frontOf,
  holder,
  inValidRoom,
  release,
  reserve,
  seatApproach,
} from "../places";
import type { PlacedObject, SimState } from "../state";
import {
  claimWardBed,
  dischargeFromWard,
  finishPathway,
  reviewed,
  runTransfer,
} from "./admissions";
import { handoverDone } from "./ambulances";
import { finishResus, newsScore, notice } from "./deterioration";
import { NEWS_URGENT } from "@data/monitoring";
import { removeJob, unassignJob } from "./jobBoard";
import { headTo } from "./movement";
import { TICKS_PER_MINUTE } from "../time";
import { canReviewDeath, claimDeathPlace, runDeathJob } from "./deaths";
import { afterTriage, backToWaiting, callToBed, lift, postTreatment, retriage } from "./patients";
import { MOOD_LIFT_SEEN, MOOD_LIFT_STEP } from "@data/patients";
import { canDo } from "./staffing";
import { transferArranged } from "./transfers";
import {
  claimDiagnosticPlace,
  DIAGNOSTIC_JOBS,
  keepsTrolley,
  pendingResults,
  runDiagnosticJob,
  scanned,
  sendSample,
} from "./diagnostics";
import { chance } from "../rng";
import { roomOfObject } from "../world/rooms";

/**
 * Jobs done wherever the patient is, rather than at a particular couch:
 * observations, crash calls, and handover of a patient who can sit.
 */
/** The steps after a death (systems/deaths.ts). */
const DEATH_JOBS = new Set<Job["kind"]>([
  "verify_death",
  "break_news",
  "last_offices",
  "to_mortuary",
  "me_review",
  "debrief",
]);

function atPatient(job: Job): boolean {
  return (
    job.kind === "obs" ||
    job.kind === "resus" ||
    job.kind === "arrange_transfer" ||
    (job.kind === "handover" && job.roomType === "")
  );
}

export function assignJobs(state: SimState): void {
  const idle = Object.values(state.staff).filter(
    (s) => s.jobId === null && s.role !== "receptionist" && onSite(s),
  );
  if (idle.length === 0) return;
  const open = Object.values(state.jobs)
    // A debrief belongs to the people who were there; it's never handed on.
    .filter((j) => j.state === "open" && j.kind !== "debrief")
    .sort((a, b) => a.dueTick - b.dueTick || a.id - b.id);
  for (const job of open) {
    let candidates = idle.filter((s) => canDo(s, job) && s.jobId === null);
    if (job.kind === "me_review") {
      const p = job.patientId === null ? undefined : state.patients[job.patientId];
      candidates = candidates.filter((s) => canReviewDeath(state, s, p));
    }
    if (candidates.length === 0 && job.kind === "resus") candidates = pullOffWork(state, job);
    if (candidates.length === 0) continue;
    const place = claimPlace(state, job);
    if (!place) continue;
    // The most preferred role with someone free, then the nearest of them.
    const best = Math.min(...candidates.map((s) => job.roles.indexOf(s.role)));
    const staff = nearest(
      candidates.filter((s) => job.roles.indexOf(s.role) === best),
      place,
    );
    job.staffId = staff.id;
    job.state = "assigned";
    staff.jobId = job.id;
    if (job.kind === "clean_toilet") reserve(state, job.objectId!, 0, staff.id);
  }
}

/**
 * Crash call with nobody free: the nearest qualified member of staff not
 * already at an arrest drops what they're doing (it goes back on the board).
 */
function pullOffWork(state: SimState, job: Job): Staff[] {
  const p = job.patientId === null ? undefined : state.patients[job.patientId];
  if (!p) return [];
  const busy = Object.values(state.staff).filter((s) => {
    const current = s.jobId === null ? undefined : state.jobs[s.jobId];
    return job.roles.includes(s.role) && current !== undefined && current.kind !== "resus";
  });
  if (busy.length === 0) return [];
  const staff = nearest(busy, p);
  unassignJob(state, state.jobs[staff.jobId!]!);
  return [staff];
}

/**
 * Where the job will happen, reserving a couch and calling the patient if
 * it's chosen now. Null if the job can't start yet.
 */
function claimPlace(state: SimState, job: Job): Point | null {
  if (job.kind === "transfer") return claimWardBed(state, job);
  if (DEATH_JOBS.has(job.kind)) return claimDeathPlace(state, job);
  if (DIAGNOSTIC_JOBS.has(job.kind)) return claimDiagnosticPlace(state, job);
  const step = treatStep(state, job);
  if (step?.needsResults && pendingResults(state, state.patients[job.patientId!]!).length > 0) {
    return null; // Waiting for results.
  }
  if (atPatient(job)) {
    const p = job.patientId === null ? undefined : state.patients[job.patientId];
    // Obs wait until they're back from the toilet.
    if (!p || (job.kind === "obs" && p.toilet)) return null;
    return p;
  }
  if (job.objectId !== null) {
    const obj = state.objects[job.objectId];
    if (!obj) return null;
    // A toilet in use gets cleaned once it's free.
    if (job.kind === "clean_toilet" && holder(state, obj.id, 0) !== undefined) return null;
    return obj;
  }
  const p = job.patientId === null ? undefined : state.patients[job.patientId];
  if (!p || p.toilet) return null; // Off to the toilet: call the next patient instead.
  const waiting =
    p.stage === "waiting_triage" ||
    p.stage === "waiting_treatment" ||
    p.stage === "awaiting_handover" ||
    // On a trolley elsewhere, waiting to move on (e.g. Resus to Majors).
    (p.stage === "in_cubicle" && p.path.length === 0);
  if (!waiting) return null;
  if (isBeingSeen(state, p.id)) return null; // Mid-observations.
  const couch = freeCouch(state, job.roomType, job.capabilities, p);
  if (!couch) return null;
  job.objectId = couch.id;
  callToBed(state, p, couch.id, keepsTrolley(state, p, !!step?.imaging));
  return couch;
}

/** The pathway step a treatment job is for. */
function treatStep(state: SimState, job: Job) {
  if (job.kind !== "treat" || job.patientId === null) return undefined;
  const p = state.patients[job.patientId];
  return p && conditionById.get(p.conditionId)!.pathway[job.step];
}

function isBeingSeen(state: SimState, patientId: number): boolean {
  return Object.values(state.jobs).some((j) => j.patientId === patientId && j.state === "working");
}

function nearest(staff: Staff[], to: Point): Staff {
  let best = staff[0]!;
  let bestD = Infinity;
  for (const s of staff) {
    const d = Math.abs(s.x - to.x) + Math.abs(s.y - to.y);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Walks assigned staff to their work and progresses it. */
export function runJobs(state: SimState): void {
  for (const job of Object.values(state.jobs)) {
    // Finishing one job can remove others mid-loop (a patient's, at an arrest).
    if (state.jobs[job.id] !== job) continue;
    if (job.kind === "debrief" && job.state === "open") {
      removeJob(state, job); // Interrupted (or they left): it's over.
      continue;
    }
    if (job.state === "open") continue;
    const staff = job.staffId === null ? undefined : state.staff[job.staffId];
    if (!staff) {
      // Dismissed mid-job: someone else picks it up, at the same place.
      job.staffId = null;
      job.state = "open";
      job.progress = 0;
      continue;
    }
    const patient = job.patientId === null ? undefined : state.patients[job.patientId];
    if (job.patientId !== null && !patient) {
      removeJob(state, job);
      continue;
    }
    if (atPatient(job)) {
      runAtPatient(state, job, staff, patient!);
      continue;
    }
    if (job.kind === "transfer") {
      runTransfer(state, job, staff, patient!);
      continue;
    }
    if (DEATH_JOBS.has(job.kind)) {
      runDeathJob(state, job, staff, patient);
      continue;
    }
    if (DIAGNOSTIC_JOBS.has(job.kind)) {
      runDiagnosticJob(state, job, staff, patient!);
      continue;
    }
    const obj = job.objectId === null ? undefined : state.objects[job.objectId];
    // Cleaning still makes sense in a room that's temporarily invalid.
    if (!obj || (job.patientId !== null && !inValidRoom(state, obj.id, job.roomType))) {
      abandon(state, job);
      continue;
    }
    const spot = job.kind === "clean_toilet" ? frontOf(obj) : bedside(state, obj);
    const arrival = headTo(state, staff, spot);
    if (job.state === "assigned") {
      if (arrival !== "arrived") continue;
      const onBed = ["triage", "in_cubicle", "on_ward"].includes(patient?.stage ?? "triage");
      if (patient && !onBed) continue;
      job.state = "working";
      if (job.kind === "treat" && patient && patient.times.seen === null) {
        patient.times.seen = state.tick;
        lift(patient, MOOD_LIFT_SEEN);
      }
      // A consultant who treats a patient can't be their Medical Examiner.
      if (patient && staff.role === "consultant" && !patient.consultants.includes(staff.id)) {
        patient.consultants.push(staff.id);
      }
    }
    if (++job.progress >= job.durationTicks) complete(state, job, obj);
  }
}

/** Where staff stand to see a patient: beside their couch, in front of their seat, or with them. */
function patientSpot(state: SimState, p: Patient): Point {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  const onBed =
    p.stage === "in_cubicle" ||
    p.stage === "triage" ||
    p.stage === "collapsed" ||
    p.stage === "awaiting_bed" ||
    p.stage === "on_ward";
  if (bed && onBed) return bedside(state, bed);
  const seat = p.seat && state.objects[p.seat.objectId];
  if (seat && p.path.length === 0) return seatApproach(seat, p.seat!.slot);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Observations and crash calls: go to the patient once they've settled, then work. */
function runAtPatient(state: SimState, job: Job, staff: Staff, p: Patient): void {
  if (job.kind === "obs" && (p.stage === "leaving" || p.stage === "collapsed" || p.death)) {
    removeJob(state, job);
    return;
  }
  const arrival = headTo(state, staff, patientSpot(state, p));
  if (job.state === "assigned") {
    if (arrival !== "arrived" || p.path.length > 0 || p.toilet) return;
    job.state = "working";
  }
  if (++job.progress < job.durationTicks) return;
  removeJob(state, job);
  if (job.kind === "obs") {
    p.obs = { tick: state.tick, news: newsScore(state, p) };
    const d = p.deterioration;
    if (d && d.noticed === null && state.tick >= d.onset && p.obs.news >= NEWS_URGENT) {
      notice(state, p, staff, "obs");
    }
  } else if (job.kind === "handover") {
    handoverDone(state, p, null);
  } else if (job.kind === "arrange_transfer") {
    transferArranged(state, p);
  } else if (job.step === 0) {
    // The team leader got there this long after the arrest.
    const startedAfter = (state.tick - job.durationTicks - job.createdTick) / TICKS_PER_MINUTE;
    finishResus(state, p, staff, Math.max(0, startedAfter));
  }
}

/** The place stopped working (removed or room invalid): put the job back. */
function abandon(state: SimState, job: Job): void {
  if (job.patientId === null) {
    removeJob(state, job);
    return;
  }
  const staff = job.staffId === null ? undefined : state.staff[job.staffId];
  if (staff) staff.jobId = null;
  const patient = state.patients[job.patientId]!;
  backToWaiting(state, patient);
  job.objectId = null;
  job.staffId = null;
  job.state = "open";
  job.progress = 0;
}

function complete(state: SimState, job: Job, obj: PlacedObject): void {
  const patient = job.patientId === null ? undefined : state.patients[job.patientId];
  removeJob(state, job);
  switch (job.kind) {
    case "triage":
      afterTriage(state, patient!);
      // Triage includes the first set of observations.
      patient!.obs = { tick: state.tick, news: newsScore(state, patient!) };
      break;
    case "treat": {
      const p = patient!;
      const condition = conditionById.get(p.conditionId)!;
      const pathway = condition.pathway;
      const done = pathway[p.step];
      if (done?.stabilises) p.deterioration = null;
      // Re-triage now treatment has worked; stabilising undoes any escalation.
      const to = done?.retriageTo ?? (done?.stabilises ? condition.acuity : undefined);
      if (to !== undefined) retriage(state, p, to);
      if (done?.sample) sendSample(state, p);
      p.step++;
      lift(p, MOOD_LIFT_STEP);
      // Optional steps (an X-ray under the Ottawa rules, say) only for some.
      while (pathway[p.step] && pathway[p.step]!.chance < 1) {
        if (chance(state.rng, pathway[p.step]!.chance)) break;
        p.step++;
      }
      const next = pathway[p.step];
      if (done?.imaging) {
        // Off the scanner: back to their trolley, or to wait.
        scanned(state, p, done.imaging, job);
        const home = p.bed === null ? undefined : roomOfObject(state, p.bed);
        postTreatment(state, p, home && next!.room === home.typeId ? p.bed : null);
        break;
      }
      if (next) {
        // Stay on the couch: the next step happens here, or they wait on it
        // until there's room where it does (Resus to Majors, say).
        postTreatment(state, p, next.room === job.roomType ? obj.id : null);
        break;
      }
      finishPathway(state, p, obj);
      break;
    }
    case "referral":
      reviewed(state, patient!);
      break;
    case "ward_discharge":
      dischargeFromWard(state, patient!, obj);
      break;
    case "transfer":
      break; // Handled by runTransfer.
    case "handover": {
      handoverDone(state, patient!, obj.id);
      break;
    }
    case "clean_cubicle":
      delete state.dirt[obj.id];
      break;
    case "clean_toilet":
      delete state.dirt[obj.id];
      if (job.staffId !== null) release(state, obj.id, 0, job.staffId);
      break;
    case "obs":
    case "resus":
    case "arrange_transfer":
      break; // Handled by runAtPatient.
  }
}
