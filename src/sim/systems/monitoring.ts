/**
 * Monitoring and line of sight (GAME_DESIGN §7, ARCHITECTURE §5.4).
 *
 * A nurse station lets a free staff nurse keep watch over every bed in
 * sight of it, within STATION_SIGHT_RANGE. A central monitoring station is a
 * nurse station that also covers beds with a bedside monitor anywhere within
 * MONITOR_RESPONSE_DISTANCE on foot, so its nurse can get there when an
 * alarm sounds. Which stations can see which beds
 * depends only on the layout, so it's cached until the layout changes;
 * whether a station is staffed right now is checked live.
 *
 * Patients whose condition needs monitoring also get observations (obs)
 * every so often after triage, wherever they are, as a job for a nurse.
 */
import { conditionById, equipmentById, roomById } from "@data/catalogue";
import {
  MONITOR_RESPONSE_DISTANCE,
  OBS_EVERY_MINS,
  OBS_MINS,
  STATION_SIGHT_RANGE,
  WARD_OBS_EVERY_MINS,
} from "@data/monitoring";
import type { Patient, Point, Staff } from "../agents";
import { bedside, deskStaffSpot, holder, isCouch } from "../places";
import type { PlacedObject, SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { FloorType, tileIndex } from "../world/grid";
import { hasLineOfSight, isOpaque } from "../world/los";
import { objectRect } from "../world/objects";
import { findPath } from "../world/pathfinding";
import { roomOfObject } from "../world/rooms";
import { rectTiles } from "../world/rect";
import { curtainsDrawn } from "./curtains";
import { postJob, ticksFor } from "./jobBoard";
import { isAt } from "./movement";

/**
 * watched: a staffed nurse station can see the bed. remote: a staffed
 * central monitor covers it. curtained: a station could see it, but its
 * privacy curtain is drawn. unstaffed: a station could, but no nurse is at
 * it right now. blind: no station sees or monitors it.
 */
export type BedCover = "watched" | "remote" | "curtained" | "unstaffed" | "blind";

const stationCache = new WeakMap<SimState, { version: number; stations: PlacedObject[] }>();

/**
 * Every nurse station, in id order. Cached per layout. Unlike most equipment
 * they work anywhere indoors, zoned or not: stations usually stand in open
 * corridors, and straddling two zones shouldn't switch one off.
 */
export function nurseStations(state: SimState): PlacedObject[] {
  const cached = stationCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.stations;
  const out = Object.values(state.objects).filter(
    (o) =>
      o.floor === 0 &&
      (equipmentById.get(o.defId)?.capabilities.includes("nurse_station") ?? false),
  );
  out.sort((a, b) => a.id - b.id);
  stationCache.set(state, { version: state.layoutVersion, stations: out });
  return out;
}

/** Where the nurse stands, and what the station sees from. */
export const stationSpot = deskStaffSpot;

/** The nurse at a station, if one is there and free to watch. */
export function stationNurse(state: SimState, station: PlacedObject): Staff | undefined {
  const id = holder(state, station.id, "staff");
  const s = id === undefined ? undefined : state.staff[id];
  return s && s.jobId === null && isAt(s, stationSpot(station)) ? s : undefined;
}

/** Beds and trolleys in valid rooms whose patients should be watched, in id order. */
export function observedBeds(state: SimState): PlacedObject[] {
  const out: PlacedObject[] = [];
  for (const room of state.rooms) {
    if (!room.valid || !roomById.get(room.typeId)?.observed) continue;
    for (const id of room.objectIds) {
      if (isCouch(state.objects[id]!.defId)) out.push(state.objects[id]!);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Whether a station can see a tile: in range and in line of sight. */
function sees(state: SimState, from: Point, t: Point): boolean {
  if (Math.hypot(t.x - from.x, t.y - from.y) > STATION_SIGHT_RANGE) return false;
  return hasLineOfSight(state.floors[0]!, from.x, from.y, t.x, t.y);
}

interface CoverageCache {
  version: number;
  /** Bed id → ids of the stations that can see it. */
  beds: Map<number, number[]>;
}
const coverageCache = new WeakMap<SimState, CoverageCache>();

/** Which stations can see each observed bed (any tile of it). Cached per layout. */
export function stationsSeeing(state: SimState): Map<number, number[]> {
  const cached = coverageCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.beds;
  const stations = nurseStations(state).map((s) => ({ id: s.id, at: stationSpot(s) }));
  const beds = new Map<number, number[]>();
  for (const bed of observedBeds(state)) {
    const tiles = rectTiles(objectRect(bed));
    beds.set(
      bed.id,
      stations.filter((s) => tiles.some((t) => sees(state, s.at, t))).map((s) => s.id),
    );
  }
  coverageCache.set(state, { version: state.layoutVersion, beds });
  return beds;
}

const remoteCache = new WeakMap<SimState, { version: number; beds: Map<number, number[]> }>();

/**
 * Which central monitors cover each observed bed with a bedside monitor:
 * within MONITOR_RESPONSE_DISTANCE of walking. Cached per layout.
 */
export function monitorsCovering(state: SimState): Map<number, number[]> {
  const cached = remoteCache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.beds;
  const monitors = nurseStations(state).filter((s) => isCentralMonitor(s.defId));
  const beds = new Map<number, number[]>();
  for (const bed of observedBeds(state)) {
    const ids: number[] = [];
    if (roomOfObject(state, bed.id)?.capabilities.includes("continuous_monitoring")) {
      for (const m of monitors) {
        const d = walkingDistance(state, stationSpot(m), bedside(state, bed));
        if (d !== null && d <= MONITOR_RESPONSE_DISTANCE) ids.push(m.id);
      }
    }
    beds.set(bed.id, ids);
  }
  remoteCache.set(state, { version: state.layoutVersion, beds });
  return beds;
}

function isCentralMonitor(defId: string): boolean {
  return equipmentById.get(defId)?.capabilities.includes("central_monitoring") ?? false;
}

/** Path length in tiles between two points, or null if there's no route. */
export function walkingDistance(state: SimState, a: Point, b: Point): number | null {
  const path = findPath(state.floors[0]!, a.x, a.y, b.x, b.y);
  return path === null ? null : path.length;
}

/**
 * The nearest central monitor's walking distance to a monitored bed, if it's
 * beyond the response distance (for explaining why a bed isn't covered).
 */
export function monitorTooFar(state: SimState, bedId: number): number | null {
  const bed = state.objects[bedId];
  if (!bed || !roomOfObject(state, bedId)?.capabilities.includes("continuous_monitoring")) {
    return null;
  }
  let best: number | null = null;
  for (const m of nurseStations(state).filter((s) => isCentralMonitor(s.defId))) {
    const d = walkingDistance(state, stationSpot(m), bedside(state, bed));
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best !== null && best > MONITOR_RESPONSE_DISTANCE ? best : null;
}

/** Stations that can see a bed right now: none while its curtain is drawn. */
function seeingNow(state: SimState, bedId: number): number[] {
  const seeing = stationsSeeing(state).get(bedId) ?? [];
  return seeing.length > 0 && curtainsDrawn(state, bedId) ? [] : seeing;
}

/** How well a bed is watched right now. Beds that don't need watching count as blind. */
export function bedCover(state: SimState, bedId: number): BedCover {
  const seeing = seeingNow(state, bedId);
  const remote = monitorsCovering(state).get(bedId) ?? [];
  const staffed = (id: number) => stationNurse(state, state.objects[id]!) !== undefined;
  if (seeing.some(staffed)) return "watched";
  if (remote.some(staffed)) return "remote";
  if ((stationsSeeing(state).get(bedId)?.length ?? 0) > seeing.length) return "curtained";
  return seeing.length + remote.length > 0 ? "unstaffed" : "blind";
}

/**
 * The nurse watching a bed, if any: from a station in sight, or (`remote`)
 * on a central monitor's screens.
 */
export function watcherOf(
  state: SimState,
  bedId: number,
): { nurse: Staff; remote: boolean } | undefined {
  for (const [ids, remote] of [
    [seeingNow(state, bedId), false],
    [monitorsCovering(state).get(bedId) ?? [], true],
  ] as const) {
    for (const id of ids) {
      const nurse = stationNurse(state, state.objects[id]!);
      if (nurse) return { nurse, remote };
    }
  }
  return undefined;
}

/** Floor tiles a station can see (for the coverage overlay), as tile indices. */
export function visibleTiles(state: SimState, station: PlacedObject): number[] {
  const grid = state.floors[0]!;
  const at = stationSpot(station);
  const r = STATION_SIGHT_RANGE;
  const out: number[] = [];
  for (let y = Math.max(0, at.y - r); y <= Math.min(grid.height - 1, at.y + r); y++) {
    for (let x = Math.max(0, at.x - r); x <= Math.min(grid.width - 1, at.x + r); x++) {
      const i = tileIndex(grid, x, y);
      if (grid.floorType[i] !== FloorType.Floor || isOpaque(grid, x, y)) continue;
      if (sees(state, at, { x, y })) out.push(i);
    }
  }
  return out;
}

/** What the coverage overlay draws. */
export interface CoverageView {
  beds: { id: number; x: number; y: number; w: number; h: number; cover: BedCover }[];
  stations: { id: number; at: Point; staffed: boolean; central: boolean }[];
  /** Tiles some nurse station can see. */
  seen: number[];
}

export function coverageView(state: SimState): CoverageView {
  const seen = new Set<number>();
  const stations = nurseStations(state).map((s) => {
    for (const i of visibleTiles(state, s)) seen.add(i);
    return {
      id: s.id,
      at: stationSpot(s),
      staffed: stationNurse(state, s) !== undefined,
      central: isCentralMonitor(s.defId),
    };
  });
  return {
    beds: observedBeds(state).map((b) => ({
      id: b.id,
      ...objectRect(b),
      cover: bedCover(state, b.id),
    })),
    stations,
    seen: [...seen],
  };
}

// ---------- Observations ----------

/** Minutes between obs for a patient, or null if their condition doesn't need them. */
export function obsInterval(p: Patient): number | null {
  if (p.stage === "on_ward") return WARD_OBS_EVERY_MINS;
  const need = conditionById.get(p.conditionId)!.monitoring;
  return need === "none" ? null : OBS_EVERY_MINS[need];
}

/** Obs are posted this long before they're due, so the nurse arrives on time. */
const OBS_LEAD_TICKS = 5 * TICKS_PER_MINUTE;

/** Posts an obs job for each monitored patient whose next set is nearly due. */
export function postObservations(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const hasObs = new Set<number>();
  for (const j of Object.values(state.jobs)) {
    if (j.kind === "obs" && j.patientId !== null) hasObs.add(j.patientId);
  }
  for (const p of Object.values(state.patients)) {
    if (p.category === 0 || p.death || p.stage === "leaving" || p.stage === "collapsed") continue;
    if (p.stage === "transferring") continue;
    if (hasObs.has(p.id)) continue;
    const every = obsInterval(p);
    if (every === null) continue;
    const due = (p.obs?.tick ?? p.times.triaged ?? state.tick) + every * TICKS_PER_MINUTE;
    if (state.tick < due - OBS_LEAD_TICKS) continue;
    postJob(state, {
      kind: "obs",
      roles: ["nurse"],
      patientId: p.id,
      roomType: "",
      dueTick: due,
      durationTicks: ticksFor(state.rng, OBS_MINS),
    });
  }
}
