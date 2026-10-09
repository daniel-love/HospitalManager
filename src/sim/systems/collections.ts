/**
 * The funeral director's collection (GAME_DESIGN §5.6), the last step after
 * a death. Once the Medical Examiner (and any coroner) has finished, the
 * family's funeral director books a collection while the mortuary is staffed
 * (weekdays, office hours):
 *
 *   their private ambulance drives in and pulls up near the mortuary
 *     → two of their staff bring a stretcher in to the mortuary
 *     → a porter releases the deceased, checking identity against the paperwork
 *     → they wheel them out (complaints if it's through a public area)
 *     → load up, and drive away; the fridge space is free again
 *
 * On a map with no road they come and go on foot by the entrance. Porters
 * stand in for mortuary staff, who aren't modelled yet.
 */
import { COLLECTION_HOURS, LOADING_MINS, RELEASE_TO_FD_MINS } from "@data/deaths";
import type { Collection, Patient, Point } from "../agents";
import { emit } from "../events";
import { frontOf, release, siteEntrance } from "../places";
import { nextFloat } from "../rng";
import type { SimState } from "../state";
import { clockFromTick, isWeekday, TICKS_PER_MINUTE, tickAt } from "../time";
import { tileIndex } from "../world/grid";
import { findPath } from "../world/pathfinding";
import { drivable, entryPoint, exitPoint } from "../world/vehicles";
import { baySpaces, drive, planRoute } from "./ambulances";
import { complain, passesPublicArea } from "./deaths";
import { jobsForPatient, postJob, removeJob, ticksFor } from "./jobBoard";
import { headTo } from "./movement";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;
const CREW_NAME = "Funeral director's staff";

// ---------- Booking ----------

/** Whether funeral directors are collecting now: a weekday, in office hours. */
export function inCollectionHours(tick: number): boolean {
  const c = clockFromTick(tick);
  return isWeekday(c) && c.hour >= COLLECTION_HOURS.startHour && c.hour < COLLECTION_HOURS.endHour;
}

/**
 * When the funeral director will come, for a release from `tick`: then, if
 * it's in collection hours, or else some time during the next day's
 * collections (they don't all turn up at opening time).
 */
export function bookCollection(state: SimState, tick: number): number {
  if (inCollectionHours(tick)) return tick;
  const c = clockFromTick(tick);
  const { startHour, endHour } = COLLECTION_HOURS;
  for (let day = c.day; day < c.day + 8; day++) {
    const start = tickAt(day, startHour);
    if (start <= tick || !isWeekday(clockFromTick(start))) continue;
    // Spread over all but the last hour, so there's time to finish.
    const spread = (endHour - startHour - 1) * TICKS_PER_HOUR;
    return start + Math.floor(nextFloat(state.rng) * spread);
  }
  return tick;
}

/** The collection under way for a deceased patient, if any. */
export function collectionFor(state: SimState, patientId: number): Collection | undefined {
  return Object.values(state.collections).find((c) => c.patientId === patientId);
}

/** The deceased's release date has come: the funeral director sets out. */
export function startCollection(state: SimState, p: Patient): void {
  const pickup = pickupSpot(state, p);
  const site = state.site;
  const stop = site ? vehicleStop(state, pickup) : null;
  const width = state.floors[0]!.width;
  // Traffic keeps left, so it comes from the end whose lane is on its side
  // of the road and pulls in along the kerb.
  const from: 0 | 1 = site && stop && stop.y >= site.road.y + site.road.h / 2 ? 1 : 0;
  // With a road they drive in; otherwise they walk in by the entrance.
  const start = site && stop ? entryPoint(site, width, from) : siteEntrance(state);
  if (!start) {
    // Nowhere to come in from at all: the collection happens off the map.
    collected(state, p, undefined);
    return;
  }
  const c: Collection = {
    id: state.nextCollectionId++,
    patientId: p.id,
    phase: stop ? "arriving" : "to_mortuary",
    vehicle: stop
      ? {
          x: start.x,
          y: start.y,
          prevX: start.x,
          prevY: start.y,
          route: [],
          routeVersion: state.layoutVersion,
          from,
          stop,
        }
      : null,
    crew: {
      id: state.nextAgentId++,
      name: CREW_NAME,
      x: start.x,
      y: start.y,
      prevX: start.x,
      prevY: start.y,
      path: [],
      dest: null,
      pathVersion: 0,
    },
    leaveAt: null,
  };
  state.collections[c.id] = c;
}

/** Where the deceased is handed over: in front of their fridge. */
function pickupSpot(state: SimState, p: Patient): Point {
  const f = p.death?.fridge;
  const fridge = f ? state.objects[f.objectId] : undefined;
  return fridge ? frontOf(fridge) : { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * Where the private ambulance pulls up: a drivable spot as near the
 * mortuary as it can get, from which the crew can walk there. It keeps out
 * of Ambulance Bay spaces and off the public road if it can.
 */
function vehicleStop(state: SimState, to: Point): Point | null {
  const grid = state.floors[0]!;
  const { tiles, lane, reachable } = drivable(state);
  const inSpace = new Uint8Array(tiles.length);
  for (const s of baySpaces(state)) {
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) inSpace[tileIndex(grid, x, y)] = 1;
    }
  }
  const taken = Object.values(state.collections).flatMap((c) =>
    c.vehicle ? [c.vehicle.stop] : [],
  );
  const scored: { at: Point; score: number }[] = [];
  for (let y = 1; y < grid.height - 1; y++) {
    for (let x = 1; x < grid.width - 1; x++) {
      const i = tileIndex(grid, x, y);
      if (reachable[i] !== 1) continue;
      // The vehicle is centred here, so the whole 3×3 around it must be drivable.
      let clear = true;
      for (let dy = -1; dy <= 1 && clear; dy++) {
        for (let dx = -1; dx <= 1 && clear; dx++)
          clear = tiles[tileIndex(grid, x + dx, y + dy)] === 1;
      }
      if (!clear) continue;
      if (taken.some((t) => Math.abs(t.x - x) < 3 && Math.abs(t.y - y) < 6)) continue;
      const score =
        Math.abs(x - to.x) + Math.abs(y - to.y) + (inSpace[i] ? 40 : 0) + (lane[i] !== 0 ? 20 : 0);
      scored.push({ at: { x, y }, score });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  for (const { at } of scored.slice(0, 12)) {
    if (findPath(grid, at.x, at.y, to.x, to.y)) return at;
  }
  return null;
}

// ---------- Each tick ----------

export function updateCollections(state: SimState): void {
  for (const c of Object.values(state.collections)) {
    const p = state.patients[c.patientId];
    const v = c.vehicle;
    if (v) {
      v.prevX = v.x;
      v.prevY = v.y;
    }
    switch (c.phase) {
      case "arriving":
        if (v && driveTo(state, c, v.stop)) {
          c.phase = "to_mortuary";
          c.crew.x = c.crew.prevX = v.stop.x;
          c.crew.y = c.crew.prevY = v.stop.y;
        }
        break;
      case "to_mortuary": {
        if (!p || p.stage !== "in_mortuary") {
          goHome(state, c);
          break;
        }
        const spot = pickupSpot(state, p);
        // With their stretcher: by a bed-width route if there is one.
        let arrival = headTo(state, c.crew, spot, spot, true);
        if (arrival === "no_route") arrival = headTo(state, c.crew, spot);
        if (arrival !== "arrived") break;
        c.phase = "releasing";
        postJob(state, {
          kind: "release_body",
          roles: ["porter"],
          patientId: p.id,
          roomType: "",
          dueTick: state.tick,
          durationTicks: ticksFor(state.rng, RELEASE_TO_FD_MINS),
        });
        break;
      }
      case "releasing":
        if (!p || p.stage !== "in_mortuary") goHome(state, c);
        break;
      case "to_vehicle": {
        if (!p) {
          goHome(state, c);
          break;
        }
        const to = v ? v.stop : siteEntrance(state);
        if (!to) {
          collected(state, p, c);
          break;
        }
        const fresh = p.dest === null;
        let arrival = headTo(state, p, to, to, true);
        if (arrival === "no_route") arrival = headTo(state, p, to);
        if (fresh && passesPublicArea(state, p.path)) {
          complain(
            state,
            `${p.name} was taken out by the funeral director through a public waiting area. Families have complained.`,
            { x: Math.round(p.x), y: Math.round(p.y) },
          );
        }
        // The crew push the stretcher (the renderer draws them behind it).
        c.crew.prevX = c.crew.x;
        c.crew.prevY = c.crew.y;
        c.crew.x = p.x;
        c.crew.y = p.y;
        c.crew.path = [];
        c.crew.dest = null;
        if (arrival === "arrived") collected(state, p, c);
        break;
      }
      case "loading":
        if (c.leaveAt !== null && state.tick >= c.leaveAt) c.phase = "leaving";
        break;
      case "leaving": {
        // Pulled in at the kerb, it carries on the way it was going.
        const end = v && v.from === 0 ? 1 : 0;
        if (!v || driveTo(state, c, exitPoint(state.site!, state.floors[0]!.width, end))) {
          delete state.collections[c.id];
        }
        break;
      }
    }
  }
}

/** Drives the vehicle a tick towards `to`; true once it's there. */
function driveTo(state: SimState, c: Collection, to: Point): boolean {
  const v = c.vehicle!;
  if (v.x === to.x && v.y === to.y) return true;
  const stale =
    v.route.length === 0 ||
    v.routeVersion !== state.layoutVersion ||
    v.route[v.route.length - 2] !== to.x ||
    v.route[v.route.length - 1] !== to.y;
  if (stale && !planRoute(state, v, to)) {
    // Cut off by a layout change: get there regardless.
    v.x = to.x;
    v.y = to.y;
    v.route = [];
    return true;
  }
  drive(v);
  return v.route.length === 0 && v.x === to.x && v.y === to.y;
}

/** The deceased has gone (or the plan fell through): the crew leave empty-handed. */
function goHome(state: SimState, c: Collection): void {
  for (const job of jobsForPatient(state, c.patientId)) {
    if (job.kind === "release_body") removeJob(state, job);
  }
  if (c.vehicle) c.phase = "leaving";
  else delete state.collections[c.id];
}

/** The porter has released them: the crew take them out on their stretcher. */
export function releasedToFuneralDirector(state: SimState, p: Patient): void {
  const c = collectionFor(state, p.id);
  const f = p.death?.fridge;
  const at = pickupSpot(state, p);
  if (f) release(state, f.objectId, f.slot, p.id);
  if (p.death) p.death.fridge = null;
  if (!c) {
    collected(state, p, undefined);
    return;
  }
  p.stage = "with_funeral_director";
  p.x = p.prevX = at.x;
  p.y = p.prevY = at.y;
  p.path = [];
  p.dest = null;
  c.phase = "to_vehicle";
}

/** Gone with the funeral director: their mortuary space (if still held) is free. */
function collected(state: SimState, p: Patient, c: Collection | undefined): void {
  const f = p.death?.fridge;
  if (f) release(state, f.objectId, f.slot, p.id);
  emit(
    state,
    `The funeral director has collected ${p.name} from the mortuary.`,
    "info",
    c?.vehicle?.stop ?? { x: Math.round(p.x), y: Math.round(p.y) },
  );
  delete state.patients[p.id];
  if (!c) return;
  if (c.vehicle) {
    c.phase = "loading";
    c.leaveAt = state.tick + ticksFor(state.rng, LOADING_MINS);
  } else delete state.collections[c.id];
}

/** Whether the crew are out of the vehicle (and so drawn and moved). */
export function crewOnFoot(c: Collection): boolean {
  return c.phase === "to_mortuary" || c.phase === "releasing" || c.phase === "to_vehicle";
}
