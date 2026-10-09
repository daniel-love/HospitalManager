/**
 * Posting and removing jobs. Kept separate from the job system that assigns
 * and runs them, so the patient system can post jobs without a circular
 * import.
 */
import { CUBICLE_CLEAN_MINS } from "@data/patients";
import type { Job } from "../agents";
import { release } from "../places";
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
  };
  state.jobs[job.id] = job;
  return job;
}

/** Removes a job, freeing whoever was doing it. */
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
}

/**
 * Takes a job off whoever is doing it and puts it back on the board, keeping
 * its place and patient (they were dismissed, or pulled away to a crash call).
 */
export function unassignJob(state: SimState, job: Job): void {
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

export function jobsForPatient(state: SimState, patientId: number): Job[] {
  return Object.values(state.jobs).filter((j) => j.patientId === patientId);
}

/** Whether a cleaning job is already posted for an object. */
export function hasCleaningJob(state: SimState, objectId: number): boolean {
  return Object.values(state.jobs).some(
    (j) => j.objectId === objectId && (j.kind === "clean_cubicle" || j.kind === "clean_toilet"),
  );
}
