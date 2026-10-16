/**
 * Transfers out to another hospital (GAME_DESIGN §5.1). A&E is the one door
 * anyone can walk through, so it sees patients the hospital can't treat or
 * admit: a chest pain with no Majors Bay, a fall that needs admitting with no
 * ward or no medical team. Staff stabilise them and transfer them:
 *
 *   decision to transfer → a doctor assesses them and arranges it with the
 *     receiving hospital → wait for an inter-hospital ambulance → crew takes them
 *
 * They wait where they are (a trolley, a cubicle, or the waiting area) and
 * can still deteriorate. The 4-hour clock runs until they leave, and A&E pays
 * for the ambulance.
 */
import { conditionById, roleNames, roomById, specialtyById } from "@data/catalogue";
import {
  ARRANGE_TRANSFER_MINS,
  TRANSFER_AMBULANCE_MINS,
  TRANSFER_COST,
  TRANSFER_DECISION_MINS,
  TRIAGE_CATEGORIES,
  URGENT_TRANSFER_AMBULANCE_MINS,
} from "@data/patients";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { Job, Patient } from "../agents";
import { emit } from "../events";
import { hasRoomWith, missingRoom } from "../places";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { dirtyCouch, jobsForPatient, postJob, removeJob, ticksFor } from "./jobBoard";
import { analysers, leaveScanner } from "./diagnostics";
import { inAE, leave } from "./patients";
import { onEscalationBed } from "./escalation";
import { book } from "./serviceLines";
import { traumaTransferred } from "./scenarios";
import { canDo } from "./staffing";

/** Doctors who can assess a patient and arrange their transfer, most preferred first. */
const ARRANGERS = ["junior_doctor", "registrar", "consultant"] as const;

/** Why a patient who needs admitting can't be admitted here, or null if they can. */
export function cantAdmit(state: SimState, specialty: SpecialtyId): string | null {
  if (!state.rooms.some((r) => r.valid && r.typeId === "ward")) return "There's no working Ward";
  if (!Object.values(state.staff).some((s) => s.specialty === specialty)) {
    return `There's no ${specialtyById.get(specialty)!.name} consultant or registrar to take them`;
  }
  return null;
}

/**
 * The decision to transfer: whatever they were waiting for here is called
 * off, and a doctor is asked to arrange it. `reason` is in plain English.
 */
export function decideToTransfer(state: SimState, p: Patient, reason: string): void {
  if (p.transfer) return;
  for (const job of jobsForPatient(state, p.id)) {
    if (job.kind !== "obs") removeJob(state, job);
  }
  // Waiting on a scanner: back to their trolley (or to wait) instead.
  if (p.homeBed !== null) leaveScanner(state, p);
  p.transfer = { reason, decided: state.tick, arranged: null, ambulanceAt: null };
  const target = TRIAGE_CATEGORIES[p.category]?.targetMins ?? 240;
  postJob(state, {
    kind: "arrange_transfer",
    roles: [...ARRANGERS],
    patientId: p.id,
    roomType: "",
    dueTick: p.times.arrived + target * TICKS_PER_MINUTE,
    durationTicks: ticksFor(state.rng, ARRANGE_TRANSFER_MINS),
  });
  const condition = conditionById.get(p.conditionId)!;
  emit(
    state,
    `${p.name} (${condition.name.toLowerCase()}) is to be transferred to another hospital: ${lowerFirst(reason)}`,
    "warn",
    { x: Math.round(p.x), y: Math.round(p.y), floor: p.floor },
  );
}

/** The doctor has spoken to the receiving hospital: an ambulance is booked. */
export function transferArranged(state: SimState, p: Patient): void {
  if (!p.transfer) return;
  const mins = p.category <= 2 ? URGENT_TRANSFER_AMBULANCE_MINS : TRANSFER_AMBULANCE_MINS;
  p.transfer.arranged = state.tick;
  p.transfer.ambulanceAt = state.tick + ticksFor(state.rng, mins);
}

/**
 * Every minute: patients whose next step can't happen anywhere in the
 * hospital are transferred once it's clear (TRANSFER_DECISION_MINS), and
 * transfer ambulances collect their patients.
 */
export function updateTransfers(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  for (const p of Object.values(state.patients)) {
    if (p.death || p.stage === "leaving" || p.stage === "collapsed") continue;
    if (p.transfer) {
      if (p.transfer.ambulanceAt !== null && state.tick >= p.transfer.ambulanceAt) depart(state, p);
      continue;
    }
    if (trolleyWaitTooLong(state, p)) {
      // Still counted as the trolley waits they were.
      state.today.stats.bedWaitsOver4h++;
      state.today.stats.bedWaitsOver12h++;
      decideToTransfer(
        state,
        p,
        `No ward bed ${TROLLEY_WAIT_LIMIT_HOURS} hours after the decision to admit: the site team found one at another hospital`,
      );
      continue;
    }
    const job = jobsForPatient(state, p.id).find((j) => j.kind === "treat" && j.state === "open");
    if (!job || state.tick - job.createdTick < TRANSFER_DECISION_MINS * TICKS_PER_MINUTE) continue;
    const reason = cantDoStep(state, p, job);
    if (reason) decideToTransfer(state, p, reason);
  }
}

/**
 * A 12-hour trolley wait: an admitted patient still in A&E this long after
 * the decision to admit. UK trusts report every one, and at the worst of it
 * the site team finds a bed at a neighbouring hospital rather than leave them.
 * Escalation trolleys don't count (they're out of A&E), and nor does someone
 * waiting there for their emergency operation.
 */
const TROLLEY_WAIT_LIMIT_HOURS = 12;

function trolleyWaitTooLong(state: SimState, p: Patient): boolean {
  if (p.stage !== "awaiting_bed" || p.times.decided === null || !inAE(p)) return false;
  if (onEscalationBed(state, p) || (p.emergencyOp && !p.emergencyOp.done)) return false;
  return state.tick - p.times.decided >= TROLLEY_WAIT_LIMIT_HOURS * 60 * TICKS_PER_MINUTE;
}

/**
 * Why a patient's waiting step can never happen here: no room for it, nobody
 * on the staff to take their scan (an X-ray Room with no radiographer), or
 * their blood tests can't be done without a lab and someone to run it. Null
 * if it can.
 */
function cantDoStep(state: SimState, p: Patient, job: Job): string | null {
  if (!hasRoomWith(state, job.roomType, job.capabilities)) {
    const room = roomById.get(job.roomType)?.name ?? job.roomType;
    return missingRoom(state, job.roomType, job.capabilities) ?? `There's no working ${room}`;
  }
  // A scan with nobody to take it. (Missing doctors and nurses are named in
  // the wait reason instead: hiring them is the fix, not sending patients away.)
  const imaging = conditionById.get(p.conditionId)!.pathway[job.step]?.imaging;
  if (imaging && !anyoneFor(state, job)) return `There's no ${roleNames(job.roles)} on the staff`;
  const bloodsStuck = p.investigations.some((i) => i.test === "bloods" && i.ready === null);
  if (bloodsStuck) {
    if (analysers(state).length === 0)
      return "There's no working Pathology Lab to test their bloods";
    if (!anyoneWithRole(state, ["biomedical_scientist"])) {
      return "There's no Biomedical Scientist on the staff to test their bloods";
    }
  }
  return null;
}

/**
 * Whether anyone could ever come to do a job: someone on the staff who can,
 * on duty or not, or a rota that brings bank or agency cover for the role.
 */
function anyoneFor(state: SimState, job: Job): boolean {
  if (Object.values(state.staff).some((s) => canDo(state, s, job))) return true;
  return rotaBrings(state, job.roles);
}

function anyoneWithRole(state: SimState, roles: readonly StaffRoleId[]): boolean {
  if (Object.values(state.staff).some((s) => roles.includes(s.role))) return true;
  return rotaBrings(state, roles);
}

/** Bank and agency staff fill rota gaps at each shift change, if the policy allows. */
function rotaBrings(state: SimState, roles: readonly StaffRoleId[]): boolean {
  if (!state.settings.rotas || state.policies.gapFill === "none") return false;
  return Object.entries(state.cover).some(
    ([key, c]) => c.day + c.night > 0 && roles.includes(key.split(":")[0] as StaffRoleId),
  );
}

/** The transfer crew takes them; the bed or cubicle they leave needs cleaning. */
function depart(state: SimState, p: Patient): void {
  const t = p.transfer!;
  const bed = p.bed;
  const stats = state.today.stats;
  stats.transferWaitMins += (state.tick - t.decided) / TICKS_PER_MINUTE;
  state.money -= TRANSFER_COST;
  book(state, "transfers", TRANSFER_COST, p.times.admitted !== null ? "wards" : "ae");
  // A major incident scenario counts trauma transfers that were too slow.
  if (p.conditionId === "major_trauma") traumaTransferred(state, p.times.arrived);
  leave(state, p, "transferred_out");
  if (bed !== null && state.objects[bed]) dirtyCouch(state, bed);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
