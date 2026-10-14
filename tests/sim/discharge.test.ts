/**
 * Discharge from the wards (ROADMAP M6 step 3, part 1): delayed discharges
 * waiting for social care, discharge coordinators, the discharge lounge and
 * social care crises.
 */
import { describe, expect, it } from "vitest";
import { CARE_NEED } from "@data/discharge";
import { pressureEventById } from "@data/pressure";
import type { Patient } from "@sim/agents";
import { applyCommand } from "@sim/commands";
import { siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { decideToAdmit } from "@sim/systems/admissions";
import { spawnPatient } from "@sim/systems/arrivals";
import { careDelayFactor, delayedDischarge } from "@sim/systems/discharge";
import { removeJob } from "@sim/systems/jobBoard";
import { announce } from "@sim/systems/pressure";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_MINUTE } from "@sim/time";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";

const HOUR = 60 * TICKS_PER_MINUTE;

function runUntil(state: SimState, done: () => boolean, limit = 240 * 60 * TICKS_PER_MINUTE): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

function quiet(): SimState {
  const state = staffedMajorsAE(1, { ...MAJORS_TEAM, porter: 1 }, { ward: "door_double" });
  state.settings.patientVolume = 0;
  return state;
}

/** A chest pain patient, admitted and on the ward. */
function onWard(state: SimState): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
  p.deterioration = null;
  runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
  for (const j of Object.values(state.jobs)) if (j.patientId === p.id) removeJob(state, j);
  decideToAdmit(state, p);
  runUntil(state, () => p.stage === "on_ward");
  return p;
}

describe("discharge", () => {
  it("keeps someone fit to go in their bed until social care is in place", () => {
    const state = quiet();
    const p = onWard(state);
    Object.assign(p.discharge!, { needsCare: true, careHours: 24 });
    p.stayUntil = state.tick;
    runUntil(state, () => p.discharge!.fit !== null);
    // Without a coordinator, a nurse asks for care only now.
    runUntil(state, () => p.discharge!.planned !== null, 2 * HOUR * 3);
    const asked = p.discharge!.planned!;
    expect(p.discharge!.careReady).toBe(asked + 24 * HOUR);
    for (let i = 0; i < 12 * HOUR; i++) tick(state);
    expect(p.stage).toBe("on_ward");
    expect(delayedDischarge(state, p)).toBe(true);
    expect(
      state.today.stats.delayedBedHours + (state.history.at(-1)?.stats.delayedBedHours ?? 0),
    ).toBeGreaterThan(0);
    runUntil(state, () => p.stage === "leaving", 20 * HOUR);
    expect(state.tick).toBeGreaterThanOrEqual(asked + 24 * HOUR);
  }, 60_000);

  it("with a discharge coordinator, asks for care on admission, so the wait runs alongside the stay", () => {
    const state = quiet();
    const r = applyStaffCommand(state, { type: "hire_staff", role: "discharge_coordinator" });
    expect(r.ok).toBe(true);
    const share = CARE_NEED["chest_pain"];
    CARE_NEED["chest_pain"] = 1;
    const p = onWard(state);
    CARE_NEED["chest_pain"] = share!;
    expect(p.discharge!.needsCare).toBe(true);
    p.discharge!.careHours = 24;
    runUntil(state, () => p.discharge!.planned !== null, 6 * HOUR);
    expect(p.discharge!.fit).toBeNull();
    // Fit a day later: care is already in place, so they go with their medicines.
    for (let i = 0; i < 24 * HOUR; i++) tick(state);
    p.stayUntil = state.tick;
    runUntil(state, () => p.stage === "leaving", 8 * HOUR);
  }, 60_000);

  it("moves patients going home to the discharge lounge, freeing their bed", () => {
    const state = quiet();
    const p = onWard(state);
    const waiting = state.rooms.find((r) => r.typeId === "waiting_area")!;
    const z = applyCommand(state, {
      type: "zone",
      floor: 0,
      rect: waiting.bounds,
      roomType: "discharge_lounge",
    });
    expect(z.ok).toBe(true);
    // (The rectangle takes in the toilets' corner too: a second, too-small lounge.)
    expect(state.rooms.some((r) => r.typeId === "discharge_lounge" && r.valid)).toBe(true);
    p.discharge!.needsCare = false;
    const bed = p.bed!;
    p.stayUntil = state.tick;
    runUntil(state, () => p.stage === "discharge_lounge", 4 * HOUR);
    expect(p.bed).toBeNull();
    expect(state.dirt[bed]).toBe(1);
    runUntil(state, () => p.stage === "leaving", 6 * HOUR);
  }, 60_000);

  it("makes social care slower in a crisis", () => {
    const state = quiet();
    expect(careDelayFactor(state)).toBe(1);
    announce(state, pressureEventById.get("social_care_crisis")!, 0);
    expect(careDelayFactor(state)).toBe(2.5);
  });
});
