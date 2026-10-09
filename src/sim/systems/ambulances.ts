/**
 * Ambulance arrivals and handover (GAME_DESIGN §4.1, §5.1).
 *
 *   999 call → ambulance arrives → parks in a free Ambulance Bay space (or
 *     waits outside) → the crew waits with the patient for an A&E nurse →
 *     handover (which includes triage) → the crew turns round and leaves
 *
 * A patient who needs a trolley is handed over at a free trolley in the room
 * their first pathway step needs (Majors or Resus), so handover waits for
 * one: full Majors means ambulances stack up outside. A patient who can sit
 * is handed over where they are and then waits like a walk-in.
 *
 * The handover clock runs from arrival, queueing included (target 15
 * minutes; over 30 is a breach, over 60 severe).
 */
import { conditionById, roomById } from "@data/catalogue";
import { AMBULANCE_TURNAROUND_MINS, HANDOVER_MINS, HANDOVER_TARGET_MINS } from "@data/patients";
import type { Ambulance, ParkingSpace, Patient, Point } from "../agents";
import { emit, warn } from "../events";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { tileIndex } from "../world/grid";
import { isStandable } from "../world/objects";
import { spawnPatient } from "./arrivals";
import { newsScore } from "./deterioration";
import { ESCALATED_DUE, postJob, ticksFor } from "./jobBoard";
import { postTreatment } from "./patients";

/** Tiles one ambulance needs: about 2.5 m × 7 m with room to open the doors. */
export const SPACE_W = 3;
export const SPACE_L = 6;

const spaceCache = new WeakMap<SimState, { version: number; spaces: ParkingSpace[] }>();

/**
 * Parking spaces in valid Ambulance Bays: clear 3×6 rectangles (either way
 * round), packed greedily from the top left. Cached per layout.
 */
export function parkingSpaces(state: SimState): ParkingSpace[] {
  const cached = spaceCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.spaces;
  const grid = state.floors[0]!;
  const spaces: ParkingSpace[] = [];
  for (const room of state.rooms) {
    if (!room.valid || room.typeId !== "ambulance_bay" || room.floor !== 0) continue;
    const free = new Set(
      room.tiles.filter((i) => isStandable(grid, i % grid.width, Math.floor(i / grid.width))),
    );
    const fits = (x: number, y: number, w: number, h: number) => {
      for (let ty = y; ty < y + h; ty++) {
        for (let tx = x; tx < x + w; tx++) {
          if (tx >= grid.width || !free.has(tileIndex(grid, tx, ty))) return false;
        }
      }
      return true;
    };
    for (const i of [...room.tiles].sort((a, b) => a - b)) {
      if (!free.has(i)) continue;
      const x = i % grid.width;
      const y = Math.floor(i / grid.width);
      for (const [w, h] of [
        [SPACE_W, SPACE_L],
        [SPACE_L, SPACE_W],
      ] as const) {
        if (!fits(x, y, w, h)) continue;
        spaces.push({ x, y, w, h });
        for (let ty = y; ty < y + h; ty++) {
          for (let tx = x; tx < x + w; tx++) free.delete(tileIndex(grid, tx, ty));
        }
        break;
      }
    }
  }
  spaceCache.set(state, { version: state.layoutVersion, spaces });
  return spaces;
}

/** Where the patient lies on the stretcher at a parked ambulance. */
export function stretcherSpot(space: ParkingSpace): Point {
  return { x: space.x + Math.floor(space.w / 2), y: space.y + Math.floor(space.h / 2) };
}

const sameSpace = (a: ParkingSpace, b: ParkingSpace) => a.x === b.x && a.y === b.y;

/** A 999 call arrives: the ambulance reaches the hospital now. */
export function ambulanceArrives(state: SimState): Ambulance {
  const a: Ambulance = {
    id: state.nextAmbulanceId++,
    arrived: state.tick,
    space: null,
    patientId: null,
    handedOver: null,
    leaveAt: null,
  };
  state.ambulances[a.id] = a;
  state.today.stats.ambulances++;
  return a;
}

export function updateAmbulances(state: SimState): void {
  const all = Object.values(state.ambulances);
  if (all.length === 0) return;
  const spaces = parkingSpaces(state);

  for (const a of all) {
    if (a.space === null) continue;
    const p = a.patientId === null ? undefined : state.patients[a.patientId];
    // The patient has gone (e.g. to intensive care) without a handover.
    if (a.leaveAt === null && (!p || p.stage === "leaving" || p.death)) a.leaveAt = state.tick;
    if (a.leaveAt !== null && state.tick >= a.leaveAt) delete state.ambulances[a.id];
  }

  const waiting = all
    .filter((a) => a.space === null && state.ambulances[a.id])
    .sort((a, b) => a.arrived - b.arrived || a.id - b.id);
  if (waiting.length === 0) return;
  if (spaces.length === 0) {
    // Nowhere to park at all (the bays were removed): they go to another hospital.
    for (const a of waiting) delete state.ambulances[a.id];
    warn(
      state,
      "ambulance_divert",
      6 * 60 * TICKS_PER_MINUTE,
      "Ambulances were sent to another hospital: there's no working Ambulance Bay.",
      "bad",
    );
    return;
  }
  const parked = Object.values(state.ambulances).filter((a) => a.space !== null);
  for (const space of spaces) {
    const a = waiting[0];
    if (!a) break;
    if (parked.some((b) => sameSpace(b.space!, space))) continue;
    waiting.shift();
    park(state, a, space);
    parked.push(a);
  }
}

function park(state: SimState, a: Ambulance, space: ParkingSpace): void {
  a.space = space;
  const p = spawnPatient(state, stretcherSpot(space), undefined, "ambulance");
  p.ambulanceId = a.id;
  // The 4-hour and handover clocks start at arrival. (Deterioration is timed
  // from parking: until then the crew is managing them in the ambulance.)
  p.times.arrived = a.arrived;
  a.patientId = p.id;
  postHandover(state, p);
}

/** Needs a trolley (Majors, Resus) rather than being able to sit and wait. */
export function needsTrolley(p: Patient): boolean {
  const first = conditionById.get(p.conditionId)!.pathway[0]!;
  return roomById.get(first.room)?.observed ?? false;
}

/** Posts the job for a nurse to take over the patient from the crew. */
export function postHandover(state: SimState, p: Patient): void {
  const first = conditionById.get(p.conditionId)!.pathway[0]!;
  const trolley = needsTrolley(p);
  postJob(state, {
    kind: "handover",
    roles: ["nurse"],
    patientId: p.id,
    roomType: trolley ? first.room : "",
    capabilities: trolley ? first.capabilities : [],
    dueTick:
      p.deterioration?.noticed != null
        ? ESCALATED_DUE
        : p.times.arrived + HANDOVER_TARGET_MINS * TICKS_PER_MINUTE,
    durationTicks: ticksFor(state.rng, HANDOVER_MINS),
  });
}

/**
 * The crew has handed over (and the nurse has triaged): the ambulance can
 * go, and the patient starts their pathway on the trolley `bedId`, or
 * (sitting) in the waiting area.
 */
export function handoverDone(state: SimState, p: Patient, bedId: number | null): void {
  const condition = conditionById.get(p.conditionId)!;
  const escalated = p.deterioration?.noticed != null;
  p.category = escalated ? Math.min(condition.acuity, 2) : condition.acuity;
  p.times.booked = state.tick;
  p.times.triaged = state.tick;
  p.obs = { tick: state.tick, news: newsScore(state, p) };
  p.step = 0;

  const stats = state.today.stats;
  const mins = (state.tick - p.times.arrived) / TICKS_PER_MINUTE;
  stats.triaged++;
  stats.triageWaitMins += mins;
  stats.handovers++;
  stats.handoverMins += mins;
  if (mins > 30) stats.handoversOver30++;
  if (mins > 60) {
    stats.handoversOver60++;
    emit(
      state,
      `${p.name}'s ambulance crew waited ${Math.round(mins)} minutes to hand over`,
      "warn",
      { x: Math.round(p.x), y: Math.round(p.y) },
    );
  }

  const a = p.ambulanceId === null ? undefined : state.ambulances[p.ambulanceId];
  if (a) {
    a.handedOver = state.tick;
    a.leaveAt = state.tick + ticksFor(state.rng, AMBULANCE_TURNAROUND_MINS);
  }
  if (bedId === null) p.stage = "waiting_treatment";
  postTreatment(state, p, bedId);
}

/** Ambulances waiting outside for a space right now. */
export function ambulancesWaiting(state: SimState): number {
  return Object.values(state.ambulances).filter((a) => a.space === null).length;
}
