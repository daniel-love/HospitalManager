/**
 * Exit block and a full Majors (ROADMAP M7 step 0): admitted patients who can
 * sit give up their Minors cubicle, 12-hour trolley waits are transferred,
 * unreachable ward beds are flagged, and a patient getting worse with every
 * Majors Bay taken is brought round to Resus.
 */
import { describe, expect, it } from "vitest";
import type { Patient } from "@sim/agents";
import { freeCouches, holder, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { decideToAdmit, wardBedsOutOfReach } from "@sim/systems/admissions";
import { spawnPatient } from "@sim/systems/arrivals";
import { removeJob } from "@sim/systems/jobBoard";
import { TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { MAJORS_TEAM, staffedMajorsAE, type MajorsOptions } from "../fixtures/majorsAE";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;
const HOUR = 60 * MIN;

function runUntil(state: SimState, done: () => boolean, limit = 4 * HOUR): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
    if (i % 100 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  throw new Error("timed out");
}

function quiet(opts: MajorsOptions = { ward: "door_double" }): SimState {
  const state = staffedMajorsAE(1, { ...MAJORS_TEAM, porter: 1 }, opts);
  state.settings.patientVolume = 0;
  for (let i = 0; i < 20 * MIN; i++) tick(state); // Staff walk in.
  return state;
}

function arrive(state: SimState, conditionId: string): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, conditionId);
  p.deterioration = null;
  return p;
}

const roomOf = (state: SimState, id: number | null) =>
  id === null ? undefined : roomOfObject(state, id)?.typeId;

/** Wards closed to admissions (as in an outbreak), so there's no bed. */
function closeWards(state: SimState, closed: boolean): void {
  for (const r of state.rooms) if (r.typeId === "ward") r.closed = closed;
}

/** Every Majors Bay taken by another chest pain patient. */
function fillMajors(state: SimState): void {
  const bays = freeCouches(state, "majors_bay", [], { x: 0, y: 0 }).length;
  const others = Array.from({ length: bays }, () => arrive(state, "chest_pain"));
  runUntil(state, () => others.every((q) => roomOf(state, q.bed) === "majors_bay"));
}

/** Their treatment in A&E is done; admitted, with jobs cleared. */
function admit(state: SimState, p: Patient): void {
  for (const j of Object.values(state.jobs)) if (j.patientId === p.id) removeJob(state, j);
  decideToAdmit(state, p);
}

describe("an admitted patient well enough to sit", () => {
  it("waits for their bed in the Waiting Area, not in a Minors cubicle", () => {
    const state = quiet();
    const p = arrive(state, "abdominal_pain");
    runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
    const cubicle = p.bed!;
    expect(roomOf(state, cubicle)).toBe("minors_cubicle");
    closeWards(state, true);
    admit(state, p);
    expect(p.stage).toBe("awaiting_bed");
    expect(p.bed).toBeNull();
    expect(holder(state, cubicle, 0)).toBeUndefined();

    runUntil(state, () => p.seat !== null && p.path.length === 0, HOUR);
    expect(roomOf(state, p.seat!.objectId)).toBe("waiting_area");

    closeWards(state, false);
    runUntil(state, () => p.stage === "on_ward");
    expect(p.seat).toBeNull();
    expect(roomOf(state, p.bed)).toBe("ward");
  });
});

describe("a 12-hour trolley wait", () => {
  it("is counted, and the site team finds a bed at another hospital", () => {
    const state = quiet();
    const p = arrive(state, "chest_pain");
    runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
    closeWards(state, true);
    admit(state, p);
    for (let i = 0; i < 30 * MIN; i++) tick(state);
    expect(p.transfer).toBeNull();

    p.times.decided = state.tick - 12 * HOUR;
    runUntil(state, () => p.transfer !== null, 2 * MIN);
    expect(p.transfer!.reason).toMatch(/^No ward bed 12 hours after the decision to admit/);
    expect(state.today.stats.bedWaitsOver12h).toBe(1);
    runUntil(state, () => !state.patients[p.id] || p.stage === "leaving", 6 * HOUR);
    expect(p.outcome).toBe("transferred_out");
  });
});

describe("free ward beds a trolley can't reach", () => {
  it("are flagged, and named as the hold-up", () => {
    const state = quiet({ ward: "door_single" });
    const p = arrive(state, "chest_pain");
    runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
    admit(state, p);
    expect(wardBedsOutOfReach(state, p)).toBe(true);
    runUntil(
      state,
      () => state.events.some((e) => e.text.includes("no bed-width route reaches them")),
      30 * MIN,
    );
  });
});

describe("a patient getting worse with every Majors Bay taken", () => {
  it("is brought round to Resus and treated there", () => {
    const state = quiet({ ambulance: true });
    fillMajors(state);
    const p = arrive(state, "chest_pain");
    runUntil(state, () => p.times.triaged !== null);
    expect(p.bed).toBeNull();
    // Getting worse, and spotted.
    p.deterioration = { onset: state.tick, crash: state.tick + 6 * HOUR, noticed: state.tick };
    runUntil(state, () => roomOf(state, p.bed) === "resus_bay" && p.path.length === 0, HOUR);
    const stabiliser = 1; // Doctor assessment and treatment.
    runUntil(state, () => p.step > stabiliser, 2 * HOUR);
    expect(roomOf(state, p.bed)).toBe("resus_bay");
    expect(p.stage).not.toBe("collapsed");
  });
});
