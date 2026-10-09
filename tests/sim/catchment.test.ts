/**
 * Demand from the catchment, shared with neighbouring hospitals by what each
 * can treat, and ambulance control deflecting when crews queue here.
 */
import { describe, expect, it } from "vitest";
import { DEFLECT_AT_QUEUE, UNTREATABLE_WALK_IN_SHARE } from "@data/patients";
import { tick } from "@sim/sim";
import { ambulanceArrives, ambulancesWaiting } from "@sim/systems/ambulances";
import { dailyDemand, treatableShare, updateArrivals } from "@sim/systems/arrivals";
import { buildMajorsAE, MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { buildSmallAE } from "../fixtures/smallAE";

describe("demand", () => {
  it("follows the catchment at UK rates per person", () => {
    const state = buildSmallAE();
    expect(dailyDemand(state)).toEqual({ walkIns: 48, ambulances: 17.6 });
    state.settings.catchment = 300_000;
    expect(dailyDemand(state)).toEqual({ walkIns: 180, ambulances: 66 });
  });

  it("is shared with neighbouring hospitals by what each can treat", () => {
    // Minors only: most walk-ins (and a quarter of majors walk-ins, who'll be
    // transferred out), but only minor head injuries by ambulance.
    const minors = buildSmallAE();
    expect(treatableShare(minors, "walk_in")).toBeCloseTo(
      (100 + 16 * UNTREATABLE_WALK_IN_SHARE) / 116,
    );
    expect(treatableShare(minors, "ambulance")).toBeCloseTo(2 / 35);
    // Majors without Resus: everything but anaphylaxis and septic shock.
    expect(treatableShare(buildMajorsAE(1), "ambulance")).toBeCloseTo(31 / 35);
    expect(treatableShare(buildMajorsAE(1, { ambulance: true }), "ambulance")).toBe(1);
  });
});

describe("ambulance control", () => {
  it(`sends ambulances elsewhere once ${DEFLECT_AT_QUEUE} crews queue outside`, () => {
    const state = staffedMajorsAE(1, MAJORS_TEAM, { ambulance: true });
    state.settings.patientVolume = 0;
    // One parks in the only space; the rest queue.
    for (let i = 0; i <= DEFLECT_AT_QUEUE; i++) ambulanceArrives(state);
    tick(state);
    expect(ambulancesWaiting(state)).toBe(DEFLECT_AT_QUEUE);
    const before = Object.keys(state.ambulances).length;
    state.settings.patientVolume = 1e6; // An ambulance every tick.
    updateArrivals(state);
    expect(Object.keys(state.ambulances)).toHaveLength(before);
    expect(state.today.stats.deflected).toBe(1);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/Ambulance control is sending/);
  });
});
