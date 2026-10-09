/**
 * Escorts to scans (GAME_DESIGN §4.4): a patient on a Majors or Resus
 * trolley goes to X-ray or CT on it, wheeled by a porter, and back again
 * once the scan's done. One who shouldn't leave their monitoring
 * (unwellToTravel) has a nurse with them the whole way, scan included.
 *
 * Until the porter (and nurse) come, the patient stays where they are: on
 * their trolley in the bay, with the scanner kept for them, or on the
 * scanner afterwards, which stays taken until they're collected.
 *
 * Each escort is an "escort" job: `step` 0 there, 1 back; `roles` says who
 * (porter or nurse); `objectId` is where the porter's taking them.
 */
import { conditionById, roomById } from "@data/catalogue";
import type { Job, Patient, Point, Staff } from "../agents";
import { warn } from "../events";
import { bedside, release, restPoint } from "../places";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { tileIndex } from "../world/grid";
import { roomOfObject } from "../world/rooms";
import { trolleyStop } from "./admissions";
import { jobsForPatient, postJob, removeJob } from "./jobBoard";
import { headTo } from "./movement";

/** How close the nurse must be before the porter sets off, in tiles. */
const WITH_PATIENT = 1.5;

/**
 * Whether a patient shouldn't leave their monitoring without a nurse: in
 * Resus, very sick (category 1) or deteriorating, or on continuous
 * monitoring. Only patients on a Majors or Resus trolley.
 */
export function unwellToTravel(state: SimState, p: Patient): boolean {
  const lying = p.homeBed ?? p.bed;
  const room = lying === null ? undefined : roomOfObject(state, lying);
  if (!room || !roomById.get(room.typeId)?.observed) return false;
  if (room.typeId === "resus_bay" || p.category === 1) return true;
  if (p.deterioration?.noticed != null) return true;
  return conditionById.get(p.conditionId)?.monitoring === "continuous";
}

function escortsOf(state: SimState, p: Patient): Job[] {
  return jobsForPatient(state, p.id).filter((j) => j.kind === "escort");
}

/** Whether a patient is waiting for, or being taken by, a porter: they don't move on their own. */
export function isEscorted(state: SimState, p: Patient): boolean {
  return escortsOf(state, p).some((j) => j.roles.includes("porter"));
}

/** Their porter's job, if they have one. */
export function porterJob(state: SimState, p: Patient): Job | undefined {
  return escortsOf(state, p).find((j) => j.roles.includes("porter"));
}

function postEscort(
  state: SimState,
  p: Patient,
  role: "porter" | "nurse",
  to: number,
  step: number,
) {
  postJob(state, {
    kind: "escort",
    roles: [role],
    patientId: p.id,
    objectId: to,
    roomType: "",
    step,
    // As soon as possible, in turn with their other work.
    dueTick: state.tick,
    durationTicks: 1,
  });
}

/**
 * Called to a scanner from their trolley (patients.callToBed has kept it as
 * their homeBed): a porter, and a nurse if they need one, will take them.
 */
export function sendForScan(state: SimState, p: Patient, scanner: number): void {
  postEscort(state, p, "porter", scanner, 0);
  if (unwellToTravel(state, p)) postEscort(state, p, "nurse", scanner, 0);
}

/**
 * Scanned (or the scanner stopped working): a porter takes them back to
 * their trolley. If they never left it, they're simply back on it.
 */
export function sendBack(state: SimState, p: Patient): void {
  const out = porterJob(state, p);
  if (out && out.step === 0 && out.state !== "working") {
    // Still in their bay: no trip needed.
    for (const j of escortsOf(state, p)) removeJob(state, j);
    if (p.bed !== null) release(state, p.bed, 0, p.id);
    p.bed = p.homeBed;
    p.homeBed = null;
    p.stage = "in_cubicle";
    return;
  }
  if (out) removeJob(state, out);
  postEscort(state, p, "porter", p.homeBed!, 1);
}

/** The object a patient is lying on, if any: where they really are. */
function lyingOn(state: SimState, p: Patient): number | null {
  if (p.path.length > 0) return null;
  const grid = state.floors[0]!;
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  const id = grid.objectId[tileIndex(grid, x, y)]!;
  return id === -1 || !state.objects[id] ? null : id;
}

/** Where staff stand to collect or stay with them. */
export function escortSpot(state: SimState, p: Patient): Point {
  const on = lyingOn(state, p);
  if (on !== null) return bedside(state, state.objects[on]!);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function near(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= WITH_PATIENT;
}

/** Walks the escort to the patient, and (for the porter) wheels them there. */
export function runEscort(state: SimState, job: Job, staff: Staff, p: Patient): void {
  if (job.roles.includes("nurse")) {
    // Stay with them, wherever they go, until they're back.
    headTo(state, staff, escortSpot(state, p));
    if (job.state === "assigned" && near(staff, p)) job.state = "working";
    return;
  }
  const to = job.objectId === null ? undefined : state.objects[job.objectId];
  if (!to) {
    // Where they were going is gone: the job system puts things right.
    removeJob(state, job);
    if (p.homeBed !== null) sendBack(state, p);
    return;
  }
  if (job.state === "assigned") {
    if (headTo(state, staff, escortSpot(state, p)) !== "arrived") return;
    const nurse = escortsOf(state, p).find((j) => j.roles.includes("nurse"));
    if (nurse && nurse.state !== "working") return; // Waiting for the nurse.
    job.state = "working";
    if (job.step === 1 && p.homeBed !== null) {
      // Off the scanner: it's free for the next patient.
      if (p.bed !== null) release(state, p.bed, 0, p.id);
      p.bed = p.homeBed;
      p.homeBed = null;
    }
    p.stage = "called_treatment";
  }
  const stop = trolleyStop(state, { x: Math.round(p.x), y: Math.round(p.y) }, to);
  let arrival = stop
    ? headTo(state, p, restPoint(to), stop, true)
    : headTo(state, p, restPoint(to), bedside(state, to));
  if (arrival === "no_route" || !stop) {
    warn(
      state,
      "no_bed_route_scan",
      6 * 60 * TICKS_PER_MINUTE,
      `A porter couldn't find a bed-width route for ${p.name}'s scan. Trolleys need double doors and corridors at least 2 tiles wide.`,
      "warn",
      { x: Math.round(p.x), y: Math.round(p.y) },
    );
    // Rather than strand them, squeeze through on foot.
    arrival = headTo(state, p, restPoint(to), bedside(state, to));
  }
  // The porter pushes the trolley.
  staff.prevX = staff.x;
  staff.prevY = staff.y;
  staff.x = p.x;
  staff.y = p.y;
  staff.path = [];
  staff.dest = null;
  if (arrival !== "arrived") return;
  p.stage = "in_cubicle";
  removeJob(state, job);
  if (job.step === 1) {
    for (const j of escortsOf(state, p)) removeJob(state, j); // The nurse is done.
  }
}
