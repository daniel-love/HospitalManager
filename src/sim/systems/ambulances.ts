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
import {
  AMBULANCE_SPEED,
  AMBULANCE_TURNAROUND_MINS,
  HANDOVER_MINS,
  HANDOVER_TARGET_MINS,
} from "@data/patients";
import type { Ambulance, ParkingSpace, Patient, Point } from "../agents";
import { emit, warn } from "../events";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { tileIndex } from "../world/grid";
import { isStandable } from "../world/objects";
import { findPath } from "../world/pathfinding";
import type { Site } from "../world/site";
import { drivable, entryPoint, exitPoint } from "../world/vehicles";
import { nextFloat } from "../rng";
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
 * round), packed greedily from the top left, whether or not an ambulance can
 * get to them. Cached per layout.
 */
export function baySpaces(state: SimState): ParkingSpace[] {
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

/**
 * Spaces an ambulance can use. On a map with a public road, only those it can
 * drive to from the road (world/vehicles.ts).
 */
export function parkingSpaces(state: SimState): ParkingSpace[] {
  const all = baySpaces(state);
  if (!state.site) return all;
  const grid = state.floors[0]!;
  const { reachable } = drivable(state);
  return all.filter((s) => {
    const c = stretcherSpot(s);
    return reachable[tileIndex(grid, c.x, c.y)] === 1;
  });
}

/** Where the patient lies on the stretcher at a parked ambulance; also where the ambulance stops. */
export function stretcherSpot(space: ParkingSpace): Point {
  return { x: space.x + Math.floor(space.w / 2), y: space.y + Math.floor(space.h / 2) };
}

const sameSpace = (a: ParkingSpace, b: ParkingSpace) => a.x === b.x && a.y === b.y;

/**
 * A 999 call arrives: the ambulance reaches the hospital now. On a map with
 * a road it comes onto the map at either end and drives in.
 */
export function ambulanceArrives(state: SimState): Ambulance {
  const site = state.site;
  const from: 0 | 1 = site && nextFloat(state.rng) >= 0.5 ? 1 : 0;
  const at = site ? entryPoint(site, state.floors[0]!.width, from) : { x: 0, y: 0 };
  const a: Ambulance = {
    id: state.nextAmbulanceId++,
    arrived: state.tick,
    phase: "arriving",
    space: null,
    x: at.x,
    y: at.y,
    prevX: at.x,
    prevY: at.y,
    route: [],
    routeVersion: state.layoutVersion,
    from,
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
    if (a.phase !== "parked") continue;
    const p = a.patientId === null ? undefined : state.patients[a.patientId];
    // The patient has gone (e.g. to intensive care) without a handover.
    if (a.leaveAt === null && (!p || p.stage === "leaving" || p.death)) a.leaveAt = state.tick;
    if (a.leaveAt !== null && state.tick >= a.leaveAt) driveOff(state, a);
  }
  // Heading for a space that's no longer there: back to waiting for one.
  for (const a of all) {
    if (a.phase === "arriving" && a.space && !spaces.some((s) => sameSpace(s, a.space!))) {
      a.space = null;
    }
  }

  const waiting = all
    .filter((a) => state.ambulances[a.id] && a.phase === "arriving" && a.space === null)
    .sort((a, b) => a.arrived - b.arrived || a.id - b.id);
  if (waiting.length > 0 && spaces.length === 0) {
    // Nowhere to park at all (the bays were removed): they go to another hospital.
    for (const a of waiting) driveOff(state, a);
    warn(
      state,
      "ambulance_divert",
      6 * 60 * TICKS_PER_MINUTE,
      "Ambulances were sent to another hospital: there's no working Ambulance Bay they can reach.",
      "bad",
    );
  } else if (waiting.length > 0) {
    const taken = Object.values(state.ambulances).filter((a) => a.space !== null);
    for (const space of spaces) {
      const a = waiting[0];
      if (!a) break;
      if (taken.some((b) => sameSpace(b.space!, space))) continue;
      waiting.shift();
      a.space = space;
      taken.push(a);
      // With no road to drive along, it pulls straight in.
      if (!state.site) park(state, a);
    }
  }
  if (state.site) driveAll(state, state.site);
}

/** Drives off (or, with no road to drive along, is simply gone). */
function driveOff(state: SimState, a: Ambulance): void {
  if (!state.site) {
    delete state.ambulances[a.id];
    return;
  }
  a.phase = "leaving";
  a.space = null;
  a.route = [];
}

function park(state: SimState, a: Ambulance): void {
  const space = a.space!;
  const at = stretcherSpot(space);
  a.phase = "parked";
  a.x = a.prevX = at.x;
  a.y = a.prevY = at.y;
  a.route = [];
  const p = spawnPatient(state, at, undefined, "ambulance");
  p.ambulanceId = a.id;
  // The 4-hour and handover clocks start at arrival. (Deterioration is timed
  // from parking: until then the crew is managing them in the ambulance.)
  p.times.arrived = a.arrived;
  a.patientId = p.id;
  postHandover(state, p);
}

/** Tiles back from the turn-off where the first waiting ambulance stops, and between each. */
const QUEUE_GAP = 8;

/**
 * Where each ambulance waiting for a space queues: on its side of the public
 * road, short of the turn-off for the nearest space, one behind another.
 */
function queueSpots(state: SimState, site: Site): Map<number, Point> {
  const width = state.floors[0]!.width;
  const out = new Map<number, Point>();
  const target = parkingSpaces(state)[0];
  if (!target) return out;
  const turnX = stretcherSpot(target).x;
  const waiting = Object.values(state.ambulances)
    .filter((a) => a.phase === "arriving" && a.space === null)
    .sort((a, b) => a.arrived - b.arrived || a.id - b.id);
  const count = [0, 0];
  for (const a of waiting) {
    const back = QUEUE_GAP * ++count[a.from]!;
    const lane = entryPoint(site, width, a.from).y;
    const x = a.from === 0 ? Math.max(0, turnX - back) : Math.min(width - 1, turnX + back);
    out.set(a.id, { x, y: lane });
  }
  return out;
}

function driveAll(state: SimState, site: Site): void {
  const grid = state.floors[0]!;
  const queue = queueSpots(state, site);
  for (const a of Object.values(state.ambulances)) {
    a.prevX = a.x;
    a.prevY = a.y;
    if (a.phase === "parked") continue;
    const to =
      a.phase === "leaving"
        ? exitPoint(site, grid.width, a.from)
        : a.space
          ? stretcherSpot(a.space)
          : queue.get(a.id);
    if (!to) continue;
    const there = a.x === to.x && a.y === to.y;
    const stale =
      a.route.length === 0 ||
      a.routeVersion !== state.layoutVersion ||
      a.route[a.route.length - 2] !== to.x ||
      a.route[a.route.length - 1] !== to.y;
    if (!there && stale && !planRoute(state, a, to)) {
      // Cut off by a layout change: leave the map, or get there regardless.
      if (a.phase === "leaving") {
        delete state.ambulances[a.id];
        continue;
      }
      a.x = to.x;
      a.y = to.y;
      a.route = [];
    }
    drive(a);
    if (a.route.length > 0 || a.x !== to.x || a.y !== to.y) continue;
    if (a.phase === "leaving") delete state.ambulances[a.id];
    else if (a.space) park(state, a);
  }
}

/** Anything that drives along the road: an ambulance, or a funeral director's vehicle. */
export type Driven = Pick<Ambulance, "x" | "y" | "route" | "routeVersion">;

/** Plans a drive to `to` over drivable tiles; false if there's no way. */
export function planRoute(state: SimState, a: Driven, to: Point): boolean {
  const grid = state.floors[0]!;
  const tiles = findPath(grid, Math.round(a.x), Math.round(a.y), to.x, to.y, {
    vehicle: drivable(state),
  });
  a.routeVersion = state.layoutVersion;
  if (!tiles) return false;
  a.route = [];
  for (const i of tiles) a.route.push(i % grid.width, Math.floor(i / grid.width));
  if (a.route.length === 0) a.route.push(to.x, to.y);
  return true;
}

/** Drives one tick's distance along the route. */
export function drive(a: Driven): void {
  let budget = AMBULANCE_SPEED;
  while (budget > 1e-6 && a.route.length > 0) {
    const dx = a.route[0]! - a.x;
    const dy = a.route[1]! - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget) {
      a.x = a.route[0]!;
      a.y = a.route[1]!;
      a.route.splice(0, 2);
      budget -= dist;
    } else {
      a.x += (dx / dist) * budget;
      a.y += (dy / dist) * budget;
      budget = 0;
    }
  }
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
  return Object.values(state.ambulances).filter((a) => a.phase === "arriving" && a.space === null)
    .length;
}
