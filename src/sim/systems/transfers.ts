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
import { conditionById, roomById, specialtyById } from "@data/catalogue";
import {
  ARRANGE_TRANSFER_MINS,
  TRANSFER_AMBULANCE_MINS,
  TRANSFER_COST,
  TRANSFER_DECISION_MINS,
  TRIAGE_CATEGORIES,
  URGENT_TRANSFER_AMBULANCE_MINS,
} from "@data/patients";
import type { SpecialtyId } from "@data/schema";
import type { Patient } from "../agents";
import { emit } from "../events";
import { hasRoomWith, missingRoom } from "../places";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { dirtyCouch, jobsForPatient, postJob, removeJob, ticksFor } from "./jobBoard";
import { analysers, leaveScanner } from "./diagnostics";
import { leave } from "./patients";

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
    { x: Math.round(p.x), y: Math.round(p.y) },
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
    const job = jobsForPatient(state, p.id).find((j) => j.kind === "treat" && j.state === "open");
    if (!job || state.tick - job.createdTick < TRANSFER_DECISION_MINS * TICKS_PER_MINUTE) continue;
    const reason = cantDoStep(state, p, job.roomType, job.capabilities);
    if (reason) decideToTransfer(state, p, reason);
  }
}

/**
 * Why a patient's waiting step can never happen here: no room for it, or
 * their blood tests can't be done without a lab. Null if it can.
 */
function cantDoStep(
  state: SimState,
  p: Patient,
  roomType: string,
  capabilities: readonly string[],
): string | null {
  if (!hasRoomWith(state, roomType, capabilities)) {
    const room = roomById.get(roomType)?.name ?? roomType;
    return missingRoom(state, roomType, capabilities) ?? `There's no working ${room}`;
  }
  const bloodsStuck = p.investigations.some((i) => i.test === "bloods" && i.ready === null);
  if (bloodsStuck && analysers(state).length === 0) {
    return "There's no working Pathology Lab to test their bloods";
  }
  return null;
}

/** The transfer crew takes them; the bed or cubicle they leave needs cleaning. */
function depart(state: SimState, p: Patient): void {
  const t = p.transfer!;
  const bed = p.bed;
  const stats = state.today.stats;
  stats.transferWaitMins += (state.tick - t.decided) / TICKS_PER_MINUTE;
  state.money -= TRANSFER_COST;
  state.today.ledger.transfers += TRANSFER_COST;
  leave(state, p, "transferred_out");
  if (bed !== null && state.objects[bed]) dirtyCouch(state, bed);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
