/**
 * Blood tests and scans (GAME_DESIGN §4.4, §5.2).
 *
 * Bloods: a pathway step takes a sample (`sample`) → a porter takes it to a
 * blood analyser in the Pathology Lab → a biomedical scientist books it in
 * and loads it → results are back once the analyser has run.
 *
 * Scans: an `imaging` step happens at an X-ray unit or CT scanner, done by a
 * radiographer. Walking patients go back to wait afterwards; a patient on a
 * Majors or Resus trolley keeps it while they're away (`homeBed`) and returns
 * to it. X-rays are read at once; a radiologist reports CT a little later.
 *
 * A step with `needsResults` waits until every result is back.
 */
import { ANALYSER_MINS, CT_REPORT_MINS, CT_TARGET_MINS, LAB_PROCESS_MINS } from "@data/diagnostics";
import { roomById } from "@data/catalogue";
import type { Investigation, Job, Patient, Point, Staff } from "../agents";
import { bedside, frontOf, release } from "../places";
import type { PlacedObject, SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { roomOfObject } from "../world/rooms";
import { postJob, removeJob, ticksFor } from "./jobBoard";
import { headTo } from "./movement";

/** Jobs this module runs: carrying samples to the lab, and processing them there. */
export const DIAGNOSTIC_JOBS = new Set<Job["kind"]>(["carry_sample", "lab_test"]);

/** Tests and scans whose results aren't back yet. */
export function pendingResults(state: SimState, p: Patient): Investigation[] {
  return p.investigations.filter((i) => i.ready === null || i.ready > state.tick);
}

/** Blood analysers in working Pathology Labs. */
export function analysers(state: SimState): PlacedObject[] {
  const out: PlacedObject[] = [];
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== "lab") continue;
    for (const id of room.objectIds) {
      if (state.objects[id]!.defId === "blood_analyser") out.push(state.objects[id]!);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A blood sample has been taken: it needs a porter to take it to the lab. */
export function sendSample(state: SimState, p: Patient): void {
  p.investigations.push({ test: "bloods", requested: state.tick, done: null, ready: null });
  postJob(state, {
    kind: "carry_sample",
    roles: ["porter"],
    patientId: p.id,
    roomType: "lab",
    // In turn with porters' other work: as soon as they can.
    dueTick: state.tick,
    durationTicks: 1,
  });
}

/** Where a porter collects the sample: from the patient's bedside, or where they are. */
function sampleSpot(state: SimState, p: Patient): Point {
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  return bed ? bedside(state, bed) : { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Where a diagnostic job happens, or null if it can't start yet. */
export function claimDiagnosticPlace(state: SimState, job: Job): Point | null {
  const p = job.patientId === null ? undefined : state.patients[job.patientId];
  const labs = analysers(state);
  if (!p || labs.length === 0) return null;
  if (job.kind === "carry_sample") {
    const from = sampleSpot(state, p);
    const nearest = labs.reduce((a, b) =>
      Math.abs(b.x - from.x) + Math.abs(b.y - from.y) <
      Math.abs(a.x - from.x) + Math.abs(a.y - from.y)
        ? b
        : a,
    );
    job.objectId = nearest.id;
    job.step = 0;
    return from;
  }
  // lab_test: at the analyser the sample went to, or another if that one's gone.
  const analyser = labs.find((a) => a.id === job.objectId) ?? labs[0]!;
  job.objectId = analyser.id;
  return frontOf(analyser);
}

/** Walks staff to the job and works it. */
export function runDiagnosticJob(state: SimState, job: Job, staff: Staff, p: Patient): void {
  const analyser = job.objectId === null ? undefined : state.objects[job.objectId];
  if (!analyser || !analysers(state).includes(analyser)) {
    // The lab stopped working: back on the board until there's one.
    staff.jobId = null;
    job.staffId = null;
    job.state = "open";
    job.objectId = null;
    job.step = 0;
    job.progress = 0;
    return;
  }
  const sample = p.investigations.find((i) => i.test === "bloods" && i.done === null);
  if (job.kind === "carry_sample") {
    if (job.step === 0) {
      if (headTo(state, staff, sampleSpot(state, p)) !== "arrived") return;
      job.step = 1; // Got it: now to the lab.
      job.state = "working";
    }
    if (headTo(state, staff, frontOf(analyser)) !== "arrived") return;
    removeJob(state, job);
    if (!sample) return;
    sample.done = state.tick;
    postJob(state, {
      kind: "lab_test",
      roles: ["biomedical_scientist"],
      patientId: p.id,
      objectId: analyser.id,
      roomType: "lab",
      dueTick: sample.requested,
      durationTicks: ticksFor(state.rng, LAB_PROCESS_MINS),
    });
    return;
  }
  if (job.state === "assigned") {
    if (headTo(state, staff, frontOf(analyser)) !== "arrived") return;
    job.state = "working";
  }
  if (++job.progress < job.durationTicks) return;
  removeJob(state, job);
  const tested = p.investigations.find(
    (i) => i.test === "bloods" && i.done !== null && i.ready === null,
  );
  if (!tested) return;
  tested.ready = state.tick + ticksFor(state.rng, ANALYSER_MINS);
  const stats = state.today.stats;
  stats.bloodResults++;
  stats.bloodResultMins += (tested.ready - tested.requested) / TICKS_PER_MINUTE;
}

/**
 * A scan is done: the result is recorded (a CT is reported later), and the
 * patient leaves the scanner: back to their trolley if they kept one,
 * otherwise back to wait.
 */
export function scanned(state: SimState, p: Patient, test: "xray" | "ct", job: Job): void {
  const started = state.tick - job.durationTicks;
  p.investigations.push({
    test,
    requested: job.createdTick,
    done: state.tick,
    ready: test === "ct" ? state.tick + ticksFor(state.rng, CT_REPORT_MINS) : state.tick,
  });
  const stats = state.today.stats;
  if (test === "xray") stats.xrays++;
  else {
    stats.ctScans++;
    stats.doorToCtMins += (started - p.times.arrived) / TICKS_PER_MINUTE;
    if (started - job.createdTick <= CT_TARGET_MINS * TICKS_PER_MINUTE) stats.ctWithinTarget++;
  }
  leaveScanner(state, p);
}

/**
 * Off the scanner (or out of the scan room): back to the trolley they kept,
 * or to the waiting area.
 */
export function leaveScanner(state: SimState, p: Patient): void {
  if (p.bed !== null) release(state, p.bed, 0, p.id);
  if (p.homeBed !== null && state.objects[p.homeBed]) {
    p.bed = p.homeBed;
    p.homeBed = null;
    p.stage = "called_treatment"; // Walks back, then lies on it again.
    return;
  }
  p.homeBed = null;
  p.bed = null;
  p.stage = "waiting_treatment";
}

/** Whether a patient going to `couchId` for this step keeps their current trolley. */
export function keepsTrolley(state: SimState, p: Patient, imaging: boolean): boolean {
  if (!imaging || p.bed === null) return false;
  const room = roomOfObject(state, p.bed);
  return !!room && (roomById.get(room.typeId)?.observed ?? false);
}
