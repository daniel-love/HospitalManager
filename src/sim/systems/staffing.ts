/**
 * Hiring and dismissing staff, and what staff do between jobs. Clinical
 * staff and cleaners take work from the job board (systems/jobs.ts);
 * receptionists instead sit at a reception desk and book patients in. Free
 * staff nurses wait at a nurse station, if there's one, watching the beds.
 */
import { staffRoleById } from "@data/catalogue";
import { MORALE_START } from "@data/deaths";
import { FIRST_NAMES, SURNAMES } from "@data/names";
import type { StaffRoleId } from "@data/schema";
import type { Staff } from "../agents";
import { emit } from "../events";
import {
  deskStaffSpot,
  fallbackEntrance,
  holder,
  inValidRoom,
  receptionDesks,
  release,
  reserve,
  siteEntrance,
} from "../places";
import { pick } from "../rng";
import type { SimState } from "../state";
import { removeJob, unassignJob } from "./jobBoard";
import { nurseStations, stationSpot } from "./monitoring";
import { headTo } from "./movement";

export type StaffCommand =
  { type: "hire_staff"; role: StaffRoleId } | { type: "dismiss_staff"; id: number };

export type StaffResult = { ok: true; staff: Staff } | { ok: false; error: string };

/**
 * Hiring is instant until recruitment arrives (M5): the new starter walks in
 * from the site entrance. Dismissal takes effect at once; any job they were
 * doing goes back on the board.
 */
export function applyStaffCommand(state: SimState, cmd: StaffCommand): StaffResult {
  if (cmd.type === "hire_staff") {
    const role = staffRoleById.get(cmd.role);
    if (!role) return { ok: false, error: "Unknown role" };
    const at = siteEntrance(state) ?? fallbackEntrance(state);
    const staff: Staff = {
      id: state.nextAgentId++,
      name: `${pick(state.rng, FIRST_NAMES)} ${pick(state.rng, SURNAMES)}`,
      role: cmd.role,
      x: at.x,
      y: at.y,
      prevX: at.x,
      prevY: at.y,
      path: [],
      dest: null,
      pathVersion: state.layoutVersion,
      jobId: null,
      desk: null,
      hiredTick: state.tick,
      morale: MORALE_START,
    };
    state.staff[staff.id] = staff;
    emit(state, `${staff.name} joined as ${role.name}`, "info", at);
    return { ok: true, staff };
  }
  const staff = state.staff[cmd.id];
  if (!staff) return { ok: false, error: "No such member of staff" };
  const job = staff.jobId === null ? undefined : state.jobs[staff.jobId];
  if (job) {
    // Back on the board for someone else, keeping its place and patient.
    unassignJob(state, job);
    if (job.patientId === null && job.objectId === null) removeJob(state, job);
  }
  if (staff.desk !== null) release(state, staff.desk, "staff", staff.id);
  delete state.staff[staff.id];
  return { ok: true, staff };
}

export function updateStaff(state: SimState): void {
  for (const s of Object.values(state.staff)) {
    if (s.role === "receptionist") staffDesk(state, s);
    else if (s.role === "nurse") waitAtStation(state, s);
  }
}

/** A free nurse goes to the nearest free nurse station; one with a job leaves it. */
function waitAtStation(state: SimState, s: Staff): void {
  const valid = s.desk !== null && nurseStations(state).some((n) => n.id === s.desk);
  if (s.desk !== null && (s.jobId !== null || !valid)) {
    release(state, s.desk, "staff", s.id);
    s.desk = null;
  }
  if (s.jobId !== null) return;
  if (s.desk === null) {
    // Staggered: looking for a station isn't urgent.
    if ((state.tick + s.id) % 10 !== 0) return;
    let best: number | null = null;
    let bestD = Infinity;
    for (const n of nurseStations(state)) {
      if (holder(state, n.id, "staff") !== undefined) continue;
      const spot = stationSpot(n);
      const d = Math.abs(spot.x - s.x) + Math.abs(spot.y - s.y);
      if (d < bestD) {
        best = n.id;
        bestD = d;
      }
    }
    if (best === null) return;
    reserve(state, best, "staff", s.id);
    s.desk = best;
  }
  headTo(state, s, stationSpot(state.objects[s.desk]!));
}

/** Receptionists find a free desk in a valid A&E reception and sit behind it. */
function staffDesk(state: SimState, s: Staff): void {
  if (s.desk !== null && !inValidRoom(state, s.desk, "ae_reception")) {
    release(state, s.desk, "staff", s.id);
    s.desk = null;
  }
  if (s.desk === null) {
    const desk = receptionDesks(state).find((d) => holder(state, d.id, "staff") === undefined);
    if (!desk) return;
    reserve(state, desk.id, "staff", s.id);
    s.desk = desk.id;
  }
  headTo(state, s, deskStaffSpot(state.objects[s.desk]!));
}
