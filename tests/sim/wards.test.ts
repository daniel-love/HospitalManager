/**
 * Porters, wards, bed movement and central monitoring (ROADMAP M3 step 3).
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Patient } from "@sim/agents";
import { reserve, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import { decideToAdmit } from "@sim/systems/admissions";
import { spawnPatient } from "@sim/systems/arrivals";
import { removeJob } from "@sim/systems/jobBoard";
import { bedCover, observedBeds } from "@sim/systems/monitoring";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";
import { createFloorGrid, FloorType, tileIndex, WallType } from "@sim/world/grid";
import { findPath } from "@sim/world/pathfinding";
import { roomOfObject } from "@sim/world/rooms";
import { waitReason } from "@game/describe";
import { applyAll, type StaffCounts } from "../fixtures/smallAE";
import { MAJORS_TEAM, staffedMajorsAE, type MajorsOptions } from "../fixtures/majorsAE";
import { run } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;
const HOUR = 60 * MIN;

function runUntil(state: SimState, done: () => boolean, limit = 240 * MIN): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

const WITH_PORTER = { ...MAJORS_TEAM, porter: 1 };

function quiet(
  opts: MajorsOptions = { ward: "door_double" },
  team: StaffCounts = WITH_PORTER,
): SimState {
  const state = staffedMajorsAE(1, team, opts);
  state.settings.patientVolume = 0;
  return state;
}

/** A chest pain patient on a Majors trolley, decided for admission. */
function admitted(state: SimState): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
  p.deterioration = null;
  runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
  for (const j of Object.values(state.jobs)) if (j.patientId === p.id) removeJob(state, j);
  decideToAdmit(state, p);
  return p;
}

describe("bed movement", () => {
  // A 9×7 room split by a wall at x 4 with a 2-tile doorway.
  function grid(door: number) {
    const g = createFloorGrid(9, 7);
    g.floorType.fill(FloorType.Floor);
    for (let y = 0; y < 7; y++) g.wall[tileIndex(g, 4, y)] = WallType.Standard;
    g.wall[tileIndex(g, 4, 2)] = WallType.None;
    g.wall[tileIndex(g, 4, 3)] = WallType.None;
    g.door[tileIndex(g, 4, 2)] = door;
    g.door[tileIndex(g, 4, 3)] = door;
    return g;
  }

  it("fits through a double door", () => {
    expect(findPath(grid(2), 1, 2, 7, 2, true)).not.toBeNull();
  });

  it("can't fit through single doors, though people on foot can", () => {
    expect(findPath(grid(1), 1, 2, 7, 2, true)).toBeNull();
    expect(findPath(grid(1), 1, 2, 7, 2)).not.toBeNull();
  });

  it("needs corridors 2 tiles wide", () => {
    const g = createFloorGrid(9, 3);
    g.floorType.fill(FloorType.Floor);
    for (let x = 2; x < 7; x++) {
      g.wall[tileIndex(g, x, 0)] = WallType.Standard;
      g.wall[tileIndex(g, x, 2)] = WallType.Standard;
    }
    expect(findPath(g, 0, 1, 8, 1)).not.toBeNull();
    expect(findPath(g, 0, 1, 8, 1, true)).toBeNull();
  });
});

describe("admission", () => {
  it("waits on the A&E trolley, then a porter wheels the patient to a ward bed", () => {
    const state = quiet();
    const p = admitted(state);
    const trolley = p.bed!;
    expect(p.stage).toBe("awaiting_bed");
    runUntil(state, () => p.stage === "on_ward");
    expect(roomOfObject(state, p.bed!)!.typeId).toBe("ward");
    expect(state.dirt[trolley]).toBe(1);
    const stats = state.today.stats;
    expect(stats.admissions).toBe(1);
    expect(stats.departures).toBe(1);
    expect(p.times.admitted).not.toBeNull();
    expect(p.stayUntil).toBeGreaterThan(state.tick + 17 * HOUR);
    const porter = Object.values(state.staff).find((s) => s.role === "porter")!;
    expect(porter.jobId).toBeNull();

    // Well enough: the doctor's discharge review, then home with the inpatient tariff.
    const bed = p.bed!;
    p.stayUntil = state.tick;
    const before = state.money;
    runUntil(state, () => p.stage === "leaving", 8 * HOUR);
    expect(stats.wardDischarges).toBe(1);
    expect(state.money).toBeGreaterThan(before);
    expect(state.dirt[bed]).toBe(1);
  });

  it("stays on the trolley without a porter, and says why", () => {
    const state = quiet({ ward: "door_double" }, MAJORS_TEAM);
    const p = admitted(state);
    for (let i = 0; i < HOUR; i++) tick(state);
    expect(p.stage).toBe("awaiting_bed");
    expect(waitReason(state, p)).toMatch(/No Porters on staff/);
  });

  it("waits for a ward bed when the ward is full, and counts the trolley wait", () => {
    const state = quiet();
    const cleaner = Object.values(state.staff).find((s) => s.role === "cleaner")!;
    const wardBeds = Object.values(state.objects).filter((o) => o.defId === "hospital_bed");
    for (const b of wardBeds) reserve(state, b.id, 0, cleaner.id);
    const p = admitted(state);
    for (let i = 0; i < 5 * HOUR; i++) tick(state);
    expect(p.stage).toBe("awaiting_bed");
    expect(waitReason(state, p)).toMatch(/No free ward bed/);
    delete state.reserved[`${wardBeds[0]!.id}:0`];
    runUntil(state, () => p.stage === "on_ward");
    expect(state.today.stats.bedWaitsOver4h).toBe(1);
  });

  it("can't wheel a trolley through a single door into the ward", () => {
    const state = quiet({ ward: "door_single" });
    const p = admitted(state);
    for (let i = 0; i < HOUR; i++) tick(state);
    expect(p.stage).toBe("awaiting_bed");
    expect(waitReason(state, p)).toMatch(/No bed-width route/);
  });

  it("sends patients to another hospital when there's no ward at all", () => {
    const state = quiet({});
    const p = spawnPatient(state, siteEntrance(state)!, "sepsis");
    p.deterioration = null;
    const admission = conditionById.get("sepsis")!.admission!;
    const chance = admission.chance;
    admission.chance = 1;
    try {
      runUntil(state, () => p.stage === "leaving", 6 * HOUR);
    } finally {
      admission.chance = chance;
    }
    expect(p.outcome).toBe("transferred_out");
    expect(state.today.stats.transfersOut).toBe(1);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/no working Ward/);
  });
});

describe("central monitoring", () => {
  it("covers a monitored bed out of sight but within walking distance", () => {
    const state = quiet({ centralMonitor: true });
    const [bay1, , bay3] = observedBeds(state);
    runUntil(state, () => bedCover(state, bay1!.id) === "watched", 30 * MIN);
    // Bay 3 is behind a wall, but its monitor alarms on the central screens.
    expect(bedCover(state, bay3!.id)).toBe("remote");
  });

  it("lets the nurse spot a deteriorating patient on the screens", () => {
    const state = quiet({ centralMonitor: true }, { ...WITH_PORTER, junior_doctor: 0 });
    const [bay1, bay2, bay3] = observedBeds(state);
    const cleaner = Object.values(state.staff).find((s) => s.role === "cleaner")!;
    reserve(state, bay1!.id, 0, cleaner.id);
    reserve(state, bay2!.id, 0, cleaner.id);
    const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
    p.deterioration = null;
    runUntil(state, () => p.stage === "in_cubicle" && p.step === 1 && p.path.length === 0);
    expect(p.bed).toBe(bay3!.id);
    runUntil(state, () => bedCover(state, bay3!.id) === "remote", 30 * MIN);
    p.deterioration = { onset: state.tick, crash: state.tick + 20 * MIN, noticed: null };
    p.obs = { tick: state.tick, news: 1 };
    for (let i = 0; i < 15 * MIN; i++) tick(state);
    expect(p.deterioration.noticed).not.toBeNull();
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/on the central monitor/);
  });

  it("doesn't cover a bed beyond the response distance", () => {
    // A long corridor: the monitor at one end, a monitored Majors bay 30 tiles away.
    const state = createSimState({ seed: 1, width: 44, height: 10 });
    const r = (x0: number, y0: number, x1: number, y1: number) => ({
      x: x0,
      y: y0,
      w: x1 - x0 + 1,
      h: y1 - y0 + 1,
    });
    applyAll(state, [
      { type: "build_floor", floor: 0, rect: r(1, 1, 42, 8) },
      { type: "build_walls", floor: 0, rect: r(37, 1, 37, 5), wall: WallType.Standard },
      { type: "zone", floor: 0, rect: r(38, 1, 41, 3), roomType: "majors_bay" },
      { type: "build_walls", floor: 0, rect: r(38, 0, 42, 0), wall: WallType.Standard },
      { type: "place_object", floor: 0, defId: "trolley", x: 40, y: 1, rotation: 0 },
      { type: "place_object", floor: 0, defId: "bedside_monitor", x: 39, y: 1, rotation: 0 },
      { type: "place_object", floor: 0, defId: "oxygen_point", x: 41, y: 1, rotation: 0 },
      { type: "place_object", floor: 0, defId: "privacy_curtain", x: 38, y: 1, rotation: 0 },
      { type: "place_object", floor: 0, defId: "central_monitor", x: 2, y: 6, rotation: 0 },
    ]);
    const [bay] = observedBeds(state);
    expect(roomOfObject(state, bay!.id)!.valid).toBe(true);
    expect(bedCover(state, bay!.id)).toBe("blind");
  });
});

describe("a hospital with a ward over three days", () => {
  const state = staffedMajorsAE(3, WITH_PORTER, { ward: "door_double", ambulance: true });
  run(state, 3 * TICKS_PER_DAY);

  it("admits patients, fills the ward and discharges them home again", () => {
    const total = (k: "admissions" | "wardDischarges") =>
      state.history.reduce((n, d) => n + d.stats[k], 0);
    expect(total("admissions")).toBeGreaterThan(4);
    expect(total("wardDischarges")).toBeGreaterThan(0);
  });

  it("backs up into A&E once the six beds are full (exit block)", () => {
    const trolleyWaits = state.history.reduce((n, d) => n + d.stats.bedWaitsOver4h, 0);
    expect(trolleyWaits).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = staffedMajorsAE(3, WITH_PORTER, { ward: "door_double", ambulance: true });
    run(again, 3 * TICKS_PER_DAY);
    expect(again.history).toEqual(state.history);
  });
});
