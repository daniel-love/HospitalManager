/**
 * X-rays, CT scans and blood tests (ROADMAP M4 step 4).
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Patient } from "@sim/agents";
import { siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { spawnPatient } from "@sim/systems/arrivals";
import { pendingResults } from "@sim/systems/diagnostics";
import { TICKS_PER_MINUTE } from "@sim/time";
import { WallType } from "@sim/world/grid";
import { roomOfObject } from "@sim/world/rooms";
import { waitReason } from "@game/describe";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { applyAll, SMALL_AE_TEAM, staffedSmallAE } from "../fixtures/smallAE";
import { buildRoom } from "./roomFit";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;
const HOUR = 60 * MIN;

function runUntil(state: SimState, done: () => boolean, limit = 6 * HOUR): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
    if (i % 100 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  throw new Error("timed out");
}

function quiet(state: SimState): SimState {
  state.settings.patientVolume = 0;
  for (let i = 0; i < 20 * MIN; i++) tick(state); // Staff walk in.
  return state;
}

function arrive(state: SimState, conditionId: string): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, conditionId);
  p.deterioration = null;
  return p;
}

const stepIndex = (conditionId: string, test: (s: { name: string }) => boolean) =>
  conditionById.get(conditionId)!.pathway.findIndex(test);

describe("blood tests", () => {
  it("go to the lab with a porter, and the review waits for the results", () => {
    const state = quiet(staffedMajorsAE(1, MAJORS_TEAM));
    const p = arrive(state, "chest_pain");
    runUntil(state, () => p.investigations.length > 0);
    const bloods = p.investigations[0]!;
    expect(bloods.test).toBe("bloods");
    const review = stepIndex("chest_pain", (s) => s.name.startsWith("Doctor review"));
    expect(p.step).toBe(review);

    runUntil(state, () => bloods.ready !== null);
    expect(bloods.done).not.toBeNull();
    // The review hasn't started while the analyser runs.
    expect(waitReason(state, p)).toMatch(/blood results, back in about/);
    expect(p.step).toBe(review);
    runUntil(state, () => p.step > review || p.stage === "leaving" || !state.patients[p.id]);
    expect(state.tick).toBeGreaterThanOrEqual(bloods.ready!);
    expect(state.today.stats.bloodResults).toBe(1);
    expect(state.today.stats.bloodResultMins).toBeGreaterThan(30);
  });

  it("wait for a porter to take the sample, and say so", () => {
    const state = quiet(staffedMajorsAE(1, { ...MAJORS_TEAM, porter: 0 }));
    const p = arrive(state, "chest_pain");
    runUntil(state, () => p.investigations.length > 0);
    for (let i = 0; i < HOUR; i++) tick(state);
    expect(p.investigations[0]!.done).toBeNull();
    expect(waitReason(state, p)).toMatch(/no porter on staff/);
  });

  it("can't be done without a lab: the patient is transferred out", () => {
    const state = quiet(staffedMajorsAE(1, MAJORS_TEAM, { diagnostics: false }));
    const p = arrive(state, "chest_pain");
    runUntil(state, () => p.transfer !== null, 8 * HOUR);
    expect(p.transfer!.reason).toMatch(/no working Pathology Lab/);
  });
});

describe("X-rays", () => {
  it("send a walking patient from their cubicle to X-ray and back to wait", () => {
    const state = quiet(staffedSmallAE(1, SMALL_AE_TEAM));
    const p = arrive(state, "broken_ankle");
    const xray = stepIndex("broken_ankle", (s) => s.name === "Ankle X-ray");
    const atXray = () => p.bed !== null && roomOfObject(state, p.bed)?.typeId === "xray_room";
    runUntil(state, () => p.step === xray && atXray());
    expect(p.homeBed).toBeNull(); // A Minors cubicle isn't kept for them.

    runUntil(state, () => p.step > xray);
    expect(p.investigations.map((i) => i.test)).toEqual(["xray"]);
    expect(state.today.stats.xrays).toBe(1);
    // Off the X-ray table and back to the waiting area, then called to a cubicle.
    expect(["waiting_treatment", "called_treatment", "in_cubicle"]).toContain(p.stage);
    runUntil(state, () => !state.patients[p.id] || p.stage === "leaving", 4 * HOUR);
  });

  it("are only for some sprains (the Ottawa rules)", () => {
    const state = quiet(staffedSmallAE(1, SMALL_AE_TEAM));
    const patients: Patient[] = [];
    for (let i = 0; i < 12; i++) patients.push(arrive(state, "sprained_ankle"));
    runUntil(state, () => patients.every((p) => !state.patients[p.id]), 24 * HOUR);
    const xrayed = state.today.stats.xrays + (state.history[0]?.stats.xrays ?? 0);
    expect(xrayed).toBeGreaterThan(0);
    expect(xrayed).toBeLessThan(12);
  });

  it("need a room enclosed by lead-lined walls", () => {
    const lined = buildRoom("xray_room", 4, 4);
    applyAll(lined, [
      { type: "place_object", floor: 0, defId: "xray_unit", x: 2, y: 1, rotation: 0 },
    ]);
    expect(lined.rooms.find((r) => r.typeId === "xray_room")!.valid).toBe(true);
    // Swap one side for a standard wall.
    applyAll(lined, [
      { type: "build_walls", floor: 0, rect: { x: 0, y: 1, w: 1, h: 4 }, wall: WallType.Standard },
    ]);
    const room = lined.rooms.find((r) => r.typeId === "xray_room")!;
    expect(room.valid).toBe(false);
    expect(room.checks.find((c) => !c.ok)?.label).toBe("Lead-lined walls all round");
  });
});

describe("CT scans", () => {
  it("keep a Majors patient's trolley while they're scanned, and count door to CT", () => {
    const state = quiet(staffedMajorsAE(1, MAJORS_TEAM));
    const p = arrive(state, "elderly_fall");
    const ct = stepIndex("elderly_fall", (s) => s.name === "CT head");
    // Make sure they're one who needs the scan.
    const step = conditionById.get("elderly_fall")!.pathway[ct]!;
    const chance = step.chance;
    step.chance = 1;
    try {
      runUntil(state, () => p.step === ct && p.homeBed !== null);
      const trolley = p.homeBed!;
      expect(roomOfObject(state, trolley)!.typeId).toBe("majors_bay");
      runUntil(state, () => p.step > ct);
      expect(p.bed).toBe(trolley);
      expect(p.homeBed).toBeNull();
      expect(state.today.stats.ctScans).toBe(1);
      expect(state.today.stats.doorToCtMins).toBeGreaterThan(0);
      // The radiologist's report comes after the scan.
      expect(pendingResults(state, p).map((i) => i.test)).toContain("ct");
    } finally {
      step.chance = chance;
    }
  });
});
