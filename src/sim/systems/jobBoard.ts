/**
 * Posting and removing jobs. Kept separate from the job system that assigns
 * and runs them, so the patient system can post jobs without a circular
 * import.
 */
import { CUBICLE_CLEAN_MINS } from "@data/patients";
import type { Job, Staff } from "../agents";
import { release, reserve } from "../places";
import { noteCareEnded } from "./curtains";
import { nextFloat, type RngState } from "../rng";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { roomOfObject } from "../world/rooms";

/**
 * Due ticks that jump the queue (jobs are taken earliest-due first): crash
 * calls before everything, then patients escalated for deteriorating.
 */
export const RESUS_DUE = -2;
export const ESCALATED_DUE = -1;

/** A random duration in ticks for a [min, max] minutes range. */
export function ticksFor(rng: RngState, [min, max]: readonly [number, number]): number {
  return Math.max(1, Math.round((min + (max - min) * nextFloat(rng)) * TICKS_PER_MINUTE));
}

export type NewJob = Pick<Job, "kind" | "roles" | "roomType" | "dueTick" | "durationTicks"> &
  Partial<Pick<Job, "patientId" | "objectId" | "capabilities" | "step" | "specialty">>;

export function postJob(state: SimState, j: NewJob): Job {
  const job: Job = {
    id: state.nextJobId++,
    kind: j.kind,
    roles: [...j.roles],
    specialty: j.specialty ?? null,
    patientId: j.patientId ?? null,
    objectId: j.objectId ?? null,
    roomType: j.roomType,
    capabilities: j.capabilities ?? [],
    step: j.step ?? 0,
    dueTick: j.dueTick,
    durationTicks: j.durationTicks,
    progress: 0,
    staffId: null,
    state: "open",
    createdTick: state.tick,
    kit: null,
  };
  state.jobs[job.id] = job;
  const index = byPatient.get(state);
  if (index && job.patientId !== null) {
    index.set(job.patientId, [...(index.get(job.patientId) ?? []), job]);
  }
  return job;
}

/**
 * Removes a job, freeing whoever was doing it. If they'd fetched shared kit,
 * they wheel it back.
 */
export function removeJob(state: SimState, job: Job): void {
  noteCareEnded(state, job);
  const staff = job.staffId === null ? undefined : state.staff[job.staffId];
  if (staff) {
    staff.jobId = null;
    if (job.objectId !== null && job.patientId === null) {
      release(state, job.objectId, 0, staff.id);
    }
  }
  delete state.jobs[job.id];
  const index = byPatient.get(state);
  if (index && job.patientId !== null) {
    const left = (index.get(job.patientId) ?? []).filter((j) => j !== job);
    if (left.length > 0) index.set(job.patientId, left);
    else index.delete(job.patientId);
  }
  dropKit(state, job, staff);
}

/**
 * The job no longer needs its kit. If `returner` has it with them, they
 * wheel it back (a return_kit job of their own); otherwise it's free where
 * it's kept.
 */
export function dropKit(state: SimState, job: Job, returner?: Staff): void {
  const kit = job.kit;
  if (!kit) return;
  job.kit = null;
  if (job.staffId !== null) release(state, kit.objectId, 0, job.staffId);
  const carried = kit.at !== "store" && job.kind !== "return_kit";
  if (!returner || !carried || returner.jobId !== null || !state.objects[kit.objectId]) return;
  const back = postJob(state, {
    kind: "return_kit",
    roles: [returner.role],
    objectId: kit.objectId,
    roomType: "",
    dueTick: state.tick,
    durationTicks: 1,
  });
  back.kit = { objectId: kit.objectId, at: "staff" };
  back.staffId = returner.id;
  back.state = "assigned";
  returner.jobId = back.id;
  reserve(state, kit.objectId, 0, returner.id);
}

/**
 * Takes a job off whoever is doing it and puts it back on the board, keeping
 * its place and patient (they were dismissed, or pulled away to a crash call).
 */
export function unassignJob(state: SimState, job: Job): void {
  if (job.kind === "return_kit") {
    // Called away: the kit is left to go back on its own.
    removeJob(state, job);
    return;
  }
  dropKit(state, job);
  const staff = job.staffId === null ? undefined : state.staff[job.staffId];
  if (staff) {
    if (job.kind === "clean_toilet" && job.objectId !== null) {
      release(state, job.objectId, 0, staff.id);
    }
    staff.jobId = null;
  }
  job.staffId = null;
  job.state = "open";
  job.progress = 0;
}

/**
 * A couch was used: it needs cleaning before the next patient (`mins`:
 * longer for a deep clean after a death).
 */
export function dirtyCouch(
  state: SimState,
  objectId: number,
  mins: readonly [number, number] = CUBICLE_CLEAN_MINS,
): void {
  state.dirt[objectId] = (state.dirt[objectId] ?? 0) + 1;
  if (hasCleaningJob(state, objectId)) return;
  postJob(state, {
    kind: "clean_cubicle",
    roles: ["cleaner"],
    objectId,
    roomType: roomOfObject(state, objectId)?.typeId ?? "minors_cubicle",
    dueTick: state.tick,
    durationTicks: ticksFor(state.rng, mins),
  });
}

export function jobsForObject(state: SimState, objectId: number): Job[] {
  return Object.values(state.jobs).filter((j) => j.objectId === objectId);
}

/**
 * Jobs by patient id, built on first use and kept up to date by postJob and
 * removeJob (the only places jobs come and go). Rebuilt for a state loaded
 * from a save, which is a new object.
 */
const byPatient = new WeakMap<SimState, Map<number, Job[]>>();

function patientIndex(state: SimState): Map<number, Job[]> {
  let index = byPatient.get(state);
  if (!index) {
    index = new Map();
    for (const j of Object.values(state.jobs)) {
      if (j.patientId !== null) index.set(j.patientId, [...(index.get(j.patientId) ?? []), j]);
    }
    byPatient.set(state, index);
  }
  return index;
}

/** A patient's jobs, oldest first (a copy: safe to remove jobs while going through it). */
export function jobsForPatient(state: SimState, patientId: number): Job[] {
  // Still on the board: a stray `delete state.jobs[id]` mustn't leave a ghost.
  return (patientIndex(state).get(patientId) ?? []).filter((j) => state.jobs[j.id] === j);
}

/** Whether staff are working with a patient now (triage, treatment, obs…). */
export function isBeingSeen(state: SimState, patientId: number): boolean {
  return jobsForPatient(state, patientId).some((j) => j.state === "working");
}

/** Whether a cleaning job is already posted for an object. */
export function hasCleaningJob(state: SimState, objectId: number): boolean {
  return Object.values(state.jobs).some(
    (j) => j.objectId === objectId && (j.kind === "clean_cubicle" || j.kind === "clean_toilet"),
  );
}
