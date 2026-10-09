/**
 * Hiring and dismissing staff, and what staff do between jobs. Clinical
 * staff and cleaners take work from the job board (systems/jobs.ts);
 * receptionists instead sit at a reception desk and book patients in. Free
 * staff nurses wait at a nurse station, if there's one, watching the beds;
 * everyone else waits at their role's base (systems/bases.ts). On-call
 * consultants stay at home until they're needed (see updateOnCall).
 */
import { specialtyById, staffRoleById } from "@data/catalogue";
import { MORALE_START } from "@data/deaths";
import { FIRST_NAMES, SURNAMES } from "@data/names";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import { ON_CALL } from "@data/staff";
import { onSite, type Job, type Staff } from "../agents";
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
import { TICKS_PER_MINUTE } from "../time";
import { waitAtBase } from "./bases";
import { removeJob, ticksFor, unassignJob } from "./jobBoard";
import { nurseStations, stationSpot } from "./monitoring";
import { headTo } from "./movement";

export type StaffCommand =
  | {
      type: "hire_staff";
      role: StaffRoleId;
      /** Consultants and registrars: their specialty. */
      specialty?: SpecialtyId;
      /** Consultants: on call from home rather than resident. */
      onCall?: boolean;
    }
  | { type: "dismiss_staff"; id: number }
  /** Gives a resident consultant the Medical Examiner duty, or takes it away. */
  | { type: "set_me_duty"; id: number; on: boolean };

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
    if (role.specialist && !cmd.specialty) return { ok: false, error: "Choose a specialty" };
    if (cmd.specialty && !specialtyById.get(cmd.specialty)) {
      return { ok: false, error: "Unknown specialty" };
    }
    if (cmd.onCall && cmd.role !== "consultant") {
      return { ok: false, error: "Only consultants can be on call" };
    }
    const at = siteEntrance(state) ?? fallbackEntrance(state);
    const staff: Staff = {
      id: state.nextAgentId++,
      name: `${pick(state.rng, FIRST_NAMES)} ${pick(state.rng, SURNAMES)}`,
      role: cmd.role,
      specialty: role.specialist ? cmd.specialty! : null,
      onCall: cmd.onCall ? { state: "home", at: state.tick } : null,
      meDuty: false,
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
    emit(
      state,
      `${staff.name} joined as ${staffTitle(staff)}`,
      "info",
      staff.onCall ? undefined : at,
    );
    return { ok: true, staff };
  }
  const staff = state.staff[cmd.id];
  if (!staff) return { ok: false, error: "No such member of staff" };
  if (cmd.type === "set_me_duty") {
    if (cmd.on && (staff.role !== "consultant" || staff.onCall)) {
      return { ok: false, error: "Only resident consultants can be Medical Examiners" };
    }
    staff.meDuty = cmd.on;
    return { ok: true, staff };
  }
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

/** "Cardiology Consultant (on call)", "Staff Nurse". */
export function staffTitle(s: Staff): string {
  const role = staffRoleById.get(s.role)!.name;
  const specialty = s.specialty ? `${specialtyById.get(s.specialty)!.name} ` : "";
  return `${specialty}${role}${s.onCall ? " (on call)" : ""}${s.meDuty ? ", Medical Examiner" : ""}`;
}

export function updateStaff(state: SimState): void {
  for (const s of Object.values(state.staff)) {
    if (s.role === "receptionist") staffDesk(state, s);
    else if (s.onCall?.state === "leaving") {
      if (s.jobId !== null) s.onCall = { state: "in", at: state.tick };
      else walkHome(state, s);
    } else if (onSite(s)) {
      if (s.role === "nurse") waitAtStation(state, s);
      if (s.desk === null) waitAtBase(state, s);
    }
  }
  updateOnCall(state);
}

/** Whether the hospital has a consultant or registrar of a specialty (on call counts). */
export function hasTeam(state: SimState, specialty: SpecialtyId): boolean {
  return Object.values(state.staff).some((s) => s.specialty === specialty);
}

/** Whether a member of staff could take a job: the right role, and specialty if it needs one. */
export function canDo(s: Staff, job: Job): boolean {
  return job.roles.includes(s.role) && (job.specialty === null || s.specialty === job.specialty);
}

/**
 * On-call consultants (GAME_DESIGN §6.1). One is called in when a job for
 * their specialty is waiting and nobody who could do it is in the hospital;
 * they arrive after the callout delay. Once there's been nothing for them
 * for a while, they go home.
 */
function updateOnCall(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const staff = Object.values(state.staff);
  const onCall = staff.filter((s) => s.onCall !== null);
  if (onCall.length === 0) return;
  const open = Object.values(state.jobs).filter((j) => j.state === "open" && j.specialty !== null);

  for (const job of open) {
    if (staff.some((s) => canDo(s, job) && (onSite(s) || s.onCall!.state === "called"))) continue;
    const home = onCall.find((s) => s.onCall!.state === "home" && canDo(s, job));
    if (!home) continue;
    const mins = ticksFor(state.rng, ON_CALL.calloutMins) / TICKS_PER_MINUTE;
    home.onCall = { state: "called", at: state.tick + Math.round(mins) * TICKS_PER_MINUTE };
    emit(
      state,
      `${home.name}, ${staffTitle(home)}, has been called in: about ${Math.round(mins)} minutes away`,
      "info",
    );
  }

  const exit = siteEntrance(state) ?? fallbackEntrance(state);
  for (const s of onCall) {
    const c = s.onCall!;
    if (c.state === "called" && state.tick >= c.at) {
      Object.assign(s, {
        x: exit.x,
        y: exit.y,
        prevX: exit.x,
        prevY: exit.y,
        path: [],
        dest: null,
      });
      s.onCall = { state: "in", at: state.tick };
      emit(state, `${s.name}, ${staffTitle(s)}, has arrived`, "info", exit);
    } else if (c.state === "in" || c.state === "leaving") {
      if (s.jobId !== null) {
        s.onCall = { state: "in", at: state.tick };
        continue;
      }
      const wanted = open.some((j) => canDo(s, j));
      if (c.state === "in") {
        if (wanted) c.at = state.tick;
        else if (state.tick - c.at >= ON_CALL.homeAfterIdleMins * TICKS_PER_MINUTE) {
          c.state = "leaving";
        }
      } else if (wanted) {
        s.onCall = { state: "in", at: state.tick };
      }
    }
  }
}

/** On-call consultants heading home walk out; once there, they're off the map. */
function walkHome(state: SimState, s: Staff): void {
  const exit = siteEntrance(state) ?? fallbackEntrance(state);
  const arrival = headTo(state, s, exit);
  if (arrival === "arrived" || arrival === "no_route") {
    s.onCall = { state: "home", at: state.tick };
    s.path = [];
    s.dest = null;
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
