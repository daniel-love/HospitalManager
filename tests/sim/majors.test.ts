/**
 * Majors, monitoring and deterioration (ROADMAP M3 "done when"): the
 * coverage overlay flags blind spots, and an unmonitored deteriorating
 * patient produces an incident with a readable cause.
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Patient } from "@sim/agents";
import { reserve, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import { createSimState, type Rotation, type SimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import { spawnPatient } from "@sim/systems/arrivals";
import { bedCover, coverageView, observedBeds, stationsSeeing } from "@sim/systems/monitoring";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";
import { tileIndex } from "@sim/world/grid";
import {
  BAY_ROWS,
  buildMajorsAE,
  MAJORS_TEAM,
  STATION_SPOT,
  staffedMajorsAE,
} from "../fixtures/majorsAE";
import { applyAll, staffedSmallAE } from "../fixtures/smallAE";
import { invariantProblems, run } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;

function runFor(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) tick(state);
}

/** Runs until `done` holds, failing if it takes longer than `limit` ticks. */
function runUntil(state: SimState, done: () => boolean, limit = 240 * MIN): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

/** A quiet department (no walk-ins) with no doctors, so majors patients wait in their bay. */
function quietMajors(opts: { station?: boolean } = {}): SimState {
  const state = staffedMajorsAE(1, { ...MAJORS_TEAM, junior_doctor: 0 }, opts);
  state.settings.patientVolume = 0;
  return state;
}

/** A chest pain patient who won't deteriorate on their own. */
function chestPain(state: SimState): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
  p.deterioration = null;
  return p;
}

/** Waits until they've had their ECG and lie in a bay waiting for the doctor. */
function waitInBay(state: SimState, p: Patient): void {
  runUntil(state, () => p.stage === "in_cubicle" && p.step === 1 && p.path.length === 0);
}

/** Starts warning signs now; collapse in `mins` unless someone notices. Obs were just done. */
function deteriorate(state: SimState, p: Patient, mins: number): void {
  p.deterioration = { onset: state.tick, crash: state.tick + mins * MIN, noticed: null };
  p.obs = { tick: state.tick, news: 1 };
}

const allText = (state: SimState) => state.events.map((e) => e.text).join("\n");

describe("coverage from a nurse station", () => {
  it("sees the two bays in sight of the station and flags the third as a blind spot", () => {
    const state = buildMajorsAE();
    const beds = observedBeds(state);
    expect(beds.map((b) => b.y)).toEqual([...BAY_ROWS]);
    const seeing = stationsSeeing(state);
    expect(beds.map((b) => seeing.get(b.id)!.length)).toEqual([1, 1, 0]);
    // Nobody is at the station yet.
    expect(beds.map((b) => bedCover(state, b.id))).toEqual(["unstaffed", "unstaffed", "blind"]);
  });

  it("shows what the station can see for the overlay", () => {
    const view = coverageView(buildMajorsAE());
    const grid = buildMajorsAE().floors[0]!;
    const seen = new Set(view.seen);
    expect(seen.has(tileIndex(grid, 16, BAY_ROWS[0]))).toBe(true);
    expect(seen.has(tileIndex(grid, 16, BAY_ROWS[2]))).toBe(false);
    expect(view.stations).toEqual([expect.objectContaining({ at: STATION_SPOT, staffed: false })]);
  });

  it("works on unzoned floor, facing either way, right in front of a bay", () => {
    const r = (x0: number, y0: number, x1: number, y1: number) => ({
      x: x0,
      y: y0,
      w: x1 - x0 + 1,
      h: y1 - y0 + 1,
    });
    const at = (defId: string, x: number, y: number, rotation: Rotation = 0) => ({
      type: "place_object" as const,
      floor: 0,
      defId,
      x,
      y,
      rotation,
    });
    for (const rotation of [1, 3] as Rotation[]) {
      const state = createSimState({ seed: 1, width: 20, height: 12 });
      // A bay open to the left, with a sideways trolley; the floor beside it isn't zoned.
      applyAll(state, [
        { type: "build_floor", floor: 0, rect: r(1, 1, 10, 8) },
        { type: "build_walls", floor: 0, rect: r(4, 0, 8, 4), wall: WallType.Standard },
        { type: "demolish", floor: 0, rect: r(4, 1, 4, 3) },
        { type: "zone", floor: 0, rect: r(4, 1, 7, 3), roomType: "majors_bay" },
        at("trolley", 6, 2, 1),
        at("oxygen_point", 5, 1, 0),
        at("bedside_monitor", 5, 3, 2),
        at("privacy_curtain", 4, 1),
        at("nurse_station", 2, 1, rotation),
      ]);
      const [bed] = observedBeds(state);
      expect(stationsSeeing(state).get(bed!.id)).toHaveLength(1);
    }
  });

  it("treats every bay as blind without a station", () => {
    const state = buildMajorsAE(1, { station: false });
    expect(observedBeds(state).map((b) => bedCover(state, b.id))).toEqual([
      "blind",
      "blind",
      "blind",
    ]);
  });

  it("sends a free nurse to the station, who leaves it to do a job", () => {
    const state = staffedMajorsAE(1, { ...MAJORS_TEAM, nurse: 1 });
    state.settings.patientVolume = 0;
    runUntil(state, () => bedCover(state, observedBeds(state)[0]!.id) === "watched", 30 * MIN);
    const watcher = Object.values(state.staff).find((s) => s.role === "nurse")!;
    expect({ x: watcher.x, y: watcher.y }).toEqual(STATION_SPOT);
    // The only nurse goes to triage a new arrival, and the station empties.
    chestPain(state);
    runUntil(state, () => watcher.jobId !== null && watcher.desk === null, 60 * MIN);
    expect(bedCover(state, observedBeds(state)[0]!.id)).toBe("unstaffed");
  });
});

describe("observations", () => {
  it("are repeated every 30 minutes for a chest pain patient", () => {
    const state = quietMajors();
    const p = chestPain(state);
    waitInBay(state, p);
    const times = new Set<number>();
    for (let i = 0; i < 120 * MIN; i++) {
      tick(state);
      if (p.obs) times.add(p.obs.tick);
    }
    expect(times.size).toBeGreaterThanOrEqual(3);
    expect(times.size).toBeLessThanOrEqual(5);
  });
});

describe("a deteriorating patient", () => {
  it("in a blind spot collapses unnoticed, and the incident says why", () => {
    const state = quietMajors();
    // Fill bays 1 and 2 so the patient is put in bay 3, out of the station's sight.
    const [bay1, bay2, bay3] = observedBeds(state);
    const cleaner = Object.values(state.staff).find((s) => s.role === "cleaner")!;
    reserve(state, bay1!.id, 0, cleaner.id);
    reserve(state, bay2!.id, 0, cleaner.id);
    const p = chestPain(state);
    waitInBay(state, p);
    expect(p.bed).toBe(bay3!.id);
    runUntil(state, () => bedCover(state, bay1!.id) === "watched", 30 * MIN);

    deteriorate(state, p, 20);
    runFor(state, 21 * MIN);
    expect(p.stage).toBe("collapsed");
    expect(p.deterioration!.noticed).toBeNull();
    expect(state.incidents).toHaveLength(1);
    const incident = state.incidents[0]!;
    expect(incident.summary).toBe("Cardiac arrest after deteriorating unnoticed");
    expect(incident.where).toBe("Majors Bay");
    expect(incident.causes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^Warning signs began 2[01] min before the arrest, and nobody noticed/,
        ),
        "Their trolley in the Majors Bay isn't visible from any nurse station",
        expect.stringMatching(/^Last observations at \d\d:\d\d scored NEWS2 1$/),
        "4 staff nurses on duty for 1 patient in A&E",
      ]),
    );
    expect(allText(state)).toMatch(/Crash call: .* cardiac arrest in the Majors Bay/);
    expect(state.today.stats.incidents).toBe(1);

    // No doctor on staff: the hospital's arrest team takes over, and it's on the record.
    // With that delay the heart rarely restarts.
    runFor(state, 20 * MIN);
    const { transferred, deaths } = state.today.stats;
    expect(transferred + deaths).toBe(1);
    expect(incident.causes).toContainEqual(
      expect.stringMatching(/No A&E doctor reached the cardiac arrest/),
    );
    if (deaths === 1) {
      expect(state.patients[p.id]!.stage).toBe("deceased");
      expect(incident.summary).toBe("Death: cardiac arrest after deteriorating unnoticed");
    } else {
      expect(state.patients[p.id]).toBeUndefined();
      expect(state.dirt[bay3!.id]).toBe(1);
    }
  });

  it("with no nurse station at all, the incident says so", () => {
    const state = quietMajors({ station: false });
    const p = chestPain(state);
    waitInBay(state, p);
    deteriorate(state, p, 20);
    runFor(state, 21 * MIN);
    expect(state.incidents[0]!.causes).toContain(
      "There's no nurse station, so nobody was watching their trolley in the Majors Bay",
    );
  });

  it("in sight of a staffed station is noticed and escalated", () => {
    const state = quietMajors();
    const p = chestPain(state);
    waitInBay(state, p);
    runUntil(state, () => bedCover(state, p.bed!) === "watched", 30 * MIN);

    deteriorate(state, p, 20);
    runFor(state, 15 * MIN);
    expect(p.deterioration!.noticed).not.toBeNull();
    expect(p.stage).toBe("in_cubicle");
    expect(state.incidents).toEqual([]);
    expect(allText(state)).toMatch(
      /Staff Nurse .* noticed .* getting worse from the nurse station \(NEWS2 [5-9]\)/,
    );

    // Escalation buys an hour, but with no doctor the treatment never comes.
    runFor(state, 70 * MIN);
    expect(p.stage).not.toBe("in_cubicle");
    const incident = state.incidents[0]!;
    expect(incident.summary).toBe("Cardiac arrest after escalation, before treatment");
    expect(incident.causes[0]).toMatch(
      /^Escalated at \d\d:\d\d, but doctor assessment and treatment hadn't started 1h \d\dm later: there are no Junior Doctors$/,
    );
  });

  it("is stabilised by timely treatment", () => {
    const state = staffedMajorsAE(1);
    state.settings.patientVolume = 0;
    const p = chestPain(state);
    p.deterioration = {
      onset: state.tick + 200 * MIN,
      crash: state.tick + 300 * MIN,
      noticed: null,
    };
    runUntil(state, () => p.step >= 2);
    expect(p.deterioration).toBeNull();
    runUntil(state, () => !state.patients[p.id]);
    expect(state.incidents).toEqual([]);
    // Home, or admitted (to another hospital: this one has no ward), but alive.
    expect(state.today.stats.departures).toBe(1);
    expect(state.today.stats.deaths).toBe(0);
  });
});

describe("a crash call", () => {
  it("pulls a busy doctor off other work, which goes back on the board", () => {
    const state = staffedMajorsAE(2, { ...MAJORS_TEAM, junior_doctor: 1 });
    const doctor = Object.values(state.staff).find((s) => s.role === "junior_doctor")!;
    runUntil(state, () => state.jobs[doctor.jobId ?? -1]?.state === "working", TICKS_PER_DAY);
    const interrupted = state.jobs[doctor.jobId!]!;
    const victim = chestPain(state);
    victim.deterioration = { onset: state.tick - 30 * MIN, crash: state.tick, noticed: null };
    runUntil(state, () => state.jobs[doctor.jobId ?? -1]?.kind === "resus", 2 * MIN);
    expect(interrupted).toMatchObject({ state: "open", staffId: null, progress: 0 });
    expect(invariantProblems(state)).toEqual([]);
  });
});

describe("majors arrivals", () => {
  const isMajors = (id: string) => conditionById.get(id)!.pathway[0]!.room === "majors_bay";

  it("only come once there's a working Majors Bay", () => {
    const seen = (state: SimState) => {
      const ids = new Set<string>();
      runFor(state, 0);
      for (let i = 0; i < TICKS_PER_DAY; i++) {
        tick(state);
        for (const p of Object.values(state.patients)) ids.add(p.conditionId);
      }
      return [...ids];
    };
    expect(seen(staffedSmallAE(4)).some(isMajors)).toBe(false);
    expect(seen(staffedMajorsAE(4)).some(isMajors)).toBe(true);
  });
});

describe("a staffed A&E with Majors over 24 hours", () => {
  const state = staffedMajorsAE(3);
  run(state, TICKS_PER_DAY);
  const day1 = state.history[0]!;

  it("treats majors patients alongside minors", () => {
    expect(day1.stats.discharged).toBeGreaterThan(25);
    expect(day1.ledger.tariff).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = staffedMajorsAE(3);
    run(again, TICKS_PER_DAY);
    expect(again.history).toEqual(state.history);
    expect(again.incidents).toEqual(state.incidents);
    expect(again.rng).toEqual(state.rng);
  });
});
