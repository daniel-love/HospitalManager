/**
 * Privacy curtains round a bay (GAME_DESIGN §7). A bay's curtain is drawn
 * while a clinician examines or treats the patient, and stays drawn for a
 * while afterwards as they dress and settle. While it's drawn a nurse
 * station can't see the bed: whoever is inside is watching instead, but once
 * they've gone it's a blind spot until the curtain is opened again.
 */
import { CURTAIN_LINGER_MINS } from "@data/monitoring";
import type { Job, JobKind } from "../agents";
import { holder } from "../places";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { roomOfObject } from "../world/rooms";

/** Jobs done at the bedside that need the curtain drawn. Obs don't. */
const HANDS_ON: ReadonlySet<JobKind> = new Set<JobKind>([
  "treat",
  "referral",
  "resus",
  "verify_death",
  "last_offices",
]);

/** Whether a bed or trolley stands in a bay with a privacy curtain. */
function curtained(state: SimState, bedId: number): boolean {
  return roomOfObject(state, bedId)?.capabilities.includes("privacy") ?? false;
}

/** Whether the curtain round a bed is drawn now (its living patient is screened). */
export function curtainsDrawn(state: SimState, bedId: number): boolean {
  const id = holder(state, bedId, 0);
  const p = id === undefined ? undefined : state.patients[id];
  if (!p || p.death || p.bed !== bedId || !curtained(state, bedId)) return false;
  if (p.curtainUntil !== null && state.tick < p.curtainUntil) return true;
  return inCare(state, p.id);
}

/** Whether a clinician is with the patient now, giving bedside care. */
export function inCare(state: SimState, patientId: number): boolean {
  return Object.values(state.jobs).some(
    (j) => j.patientId === patientId && j.state === "working" && HANDS_ON.has(j.kind),
  );
}

/**
 * A job is ending: if it was hands-on care in a curtained bay, the curtain
 * stays drawn a while longer.
 */
export function noteCareEnded(state: SimState, job: Job): void {
  if (job.state !== "working" || job.patientId === null || !HANDS_ON.has(job.kind)) return;
  const p = state.patients[job.patientId];
  if (!p || p.death || p.bed === null || !curtained(state, p.bed)) return;
  p.curtainUntil = state.tick + CURTAIN_LINGER_MINS * TICKS_PER_MINUTE;
}
