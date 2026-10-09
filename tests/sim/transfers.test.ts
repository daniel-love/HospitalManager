/**
 * Specialty gating and A&E transfer-out (ROADMAP M4 step 3, GAME_DESIGN §5.1).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import { TRANSFER_COST, TRANSFER_DECISION_MINS } from "@data/patients";
import type { Patient } from "@sim/agents";
import { siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { finishPathway } from "@sim/systems/admissions";
import { spawnPatient } from "@sim/systems/arrivals";
import { removeJob } from "@sim/systems/jobBoard";
import { TICKS_PER_MINUTE } from "@sim/time";
import { describePatient } from "@game/describe";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { hireRegistrars, staffedSmallAE } from "../fixtures/smallAE";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;
const HOUR = 60 * MIN;

function runUntil(state: SimState, done: () => boolean, limit = 8 * HOUR): void {
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

const status = (state: SimState, p: Patient) => {
  const info = describePatient(state, p);
  if (info.kind !== "patient") throw new Error("expected a patient");
  return info;
};

describe("a majors walk-in at an A&E with no Majors Bay", () => {
  it("is triaged, then transferred out once it's clear there's nowhere to treat them", () => {
    const state = quiet(staffedSmallAE(1));
    const money = state.money;
    const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
    p.deterioration = null;
    runUntil(state, () => p.times.triaged !== null);
    expect(p.transfer).toBeNull();

    runUntil(state, () => p.transfer !== null, (TRANSFER_DECISION_MINS + 5) * MIN);
    expect(p.transfer!.reason).toBe("No working Majors Bay");
    expect(state.events.some((e) => e.text.includes("is to be transferred"))).toBe(true);
    expect(status(state, p).status).toMatch(/transfer/i);

    runUntil(state, () => p.transfer!.arranged !== null, HOUR);
    expect(p.transfer!.ambulanceAt! - state.tick).toBeGreaterThanOrEqual(30 * MIN);
    expect(status(state, p).status).toMatch(/Waiting for the transfer ambulance/);

    runUntil(state, () => p.stage === "leaving" || !state.patients[p.id], 5 * HOUR);
    const stats = state.today.stats;
    expect(stats.transfersOut).toBe(1);
    expect(stats.transferWaitMins).toBeGreaterThan(30);
    expect(state.today.ledger.transfers).toBe(TRANSFER_COST);
    // Their attendance is still paid; the ambulance comes out of the budget.
    expect(state.money).toBeLessThan(money + conditionById.get("chest_pain")!.tariff);
  });
});

describe("specialty gating of admissions", () => {
  // Every chest pain patient who finishes A&E here needs admitting.
  const admission = conditionById.get("chest_pain")!.admission!;
  let chance = 0;
  beforeEach(() => {
    chance = admission.chance;
    admission.chance = 1;
  });
  afterEach(() => {
    admission.chance = chance;
  });

  /** A chest pain patient on a Majors trolley who has finished their A&E steps. */
  function finished(state: SimState): Patient {
    const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
    p.deterioration = null;
    runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
    for (const j of Object.values(state.jobs)) if (j.patientId === p.id) removeJob(state, j);
    p.step = conditionById.get("chest_pain")!.pathway.length;
    finishPathway(state, p, state.objects[p.bed!]!);
    return p;
  }

  it("transfers them out with no ward, keeping their trolley until the ambulance comes", () => {
    const state = quiet(staffedMajorsAE(1, MAJORS_TEAM));
    hireRegistrars(state);
    const p = finished(state);
    const trolley = p.bed!;
    expect(p.transfer?.reason).toBe("There's no working Ward, so they can't be admitted here");
    runUntil(state, () => p.transfer!.ambulanceAt !== null && state.tick < p.transfer!.ambulanceAt);
    expect(p.bed).toBe(trolley);
    runUntil(state, () => !state.patients[p.id] || p.stage === "leaving", 5 * HOUR);
    expect(state.dirt[trolley]).toBe(1);
  });

  it("refers them to the specialty when the hospital can admit them", () => {
    const state = quiet(staffedMajorsAE(1, { ...MAJORS_TEAM, porter: 1 }, { ward: "door_double" }));
    hireRegistrars(state);
    const p = finished(state);
    expect(p.transfer).toBeNull();
    expect(
      Object.values(state.jobs).some((j) => j.patientId === p.id && j.kind === "referral"),
    ).toBe(true);
  });
});
