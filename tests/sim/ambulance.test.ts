/**
 * Ambulance arrivals, handover delays and Resus (ROADMAP M3 step 2).
 */
import { describe, expect, it } from "vitest";
import type { Patient } from "@sim/agents";
import { reserve } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import {
  ambulanceArrives,
  ambulancesWaiting,
  parkingSpaces,
  postHandover,
  stretcherSpot,
} from "@sim/systems/ambulances";
import { observedBeds } from "@sim/systems/monitoring";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { staffedSmallAE } from "../fixtures/smallAE";
import { run } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;

function runUntil(state: SimState, done: () => boolean, limit = 240 * MIN): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

/** A quiet A&E with Resus and an ambulance bay (no random arrivals). */
function quiet(team = MAJORS_TEAM): SimState {
  const state = staffedMajorsAE(1, team, { ambulance: true });
  state.settings.patientVolume = 0;
  return state;
}

/** Calls an ambulance and waits for it to park; returns its patient as `conditionId`. */
function ambulanceWith(state: SimState, conditionId: string): Patient {
  const a = ambulanceArrives(state);
  tick(state);
  const p = state.patients[a.patientId!]!;
  // Swap in the condition under test (and no surprise deterioration).
  p.conditionId = conditionId;
  p.deterioration = null;
  for (const j of Object.values(state.jobs)) if (j.patientId === p.id) delete state.jobs[j.id];
  postHandover(state, p);
  return p;
}

describe("ambulance bays", () => {
  it("fit one ambulance per clear 3×6 space", () => {
    const state = quiet();
    expect(parkingSpaces(state)).toEqual([{ x: 15, y: 29, w: 3, h: 6 }]);
  });

  it("are needed for ambulances to come at all", () => {
    const count = (state: SimState) => {
      run(state, TICKS_PER_DAY);
      return state.history[0]!.stats.ambulances;
    };
    expect(count(staffedSmallAE(4))).toBe(0);
    expect(count(staffedMajorsAE(4, MAJORS_TEAM, { ambulance: true }))).toBeGreaterThan(8);
  });
});

describe("handover", () => {
  it("happens at a free Majors trolley, then the ambulance turns round and leaves", () => {
    const state = quiet();
    const a = ambulanceArrives(state);
    tick(state);
    const p = state.patients[a.patientId!]!;
    expect(p.stage).toBe("awaiting_handover");
    expect({ x: p.x, y: p.y }).toEqual(stretcherSpot(a.space!));
    expect(Object.values(state.jobs).find((j) => j.patientId === p.id)?.kind).toBe("handover");

    runUntil(state, () => p.times.triaged !== null);
    if (p.bed !== null) {
      // A trolley patient was handed over on a trolley in the room of their first step.
      expect(p.stage).toBe("in_cubicle");
      expect(["majors_bay", "resus_bay"]).toContain(roomOfObject(state, p.bed)!.typeId);
    } else {
      expect(p.stage).toMatch(/waiting_treatment|called_treatment/);
    }
    expect(p.category).toBeGreaterThan(0);
    expect(state.today.stats.handovers).toBe(1);
    expect(a.leaveAt).not.toBeNull();
    runUntil(state, () => !state.ambulances[a.id], 20 * MIN);
  });

  it("of a patient who can sit is done at the ambulance, then they wait inside", () => {
    const state = quiet();
    const p = ambulanceWith(state, "minor_head_injury");
    const spot = { x: p.x, y: p.y };
    runUntil(state, () => p.times.triaged !== null);
    expect(p.bed).toBeNull();
    expect({ x: p.x, y: p.y }).toEqual(spot);
    expect(p.stage).toBe("waiting_treatment");
  });

  it("waits for a free trolley when Majors is full, and later ambulances queue outside", () => {
    const state = quiet();
    // Every Majors trolley and the Resus trolley are taken.
    const cleaner = Object.values(state.staff).find((s) => s.role === "cleaner")!;
    for (const bed of observedBeds(state)) reserve(state, bed.id, 0, cleaner.id);
    const p = ambulanceWith(state, "chest_pain");
    ambulanceArrives(state);
    for (let i = 0; i < 40 * MIN; i++) tick(state);
    expect(p.stage).toBe("awaiting_handover");
    expect(ambulancesWaiting(state)).toBe(1);

    // A trolley frees up: handover happens, and the delay is on the record.
    const bay1 = observedBeds(state).find(
      (b) => roomOfObject(state, b.id)!.typeId === "majors_bay",
    )!;
    delete state.reserved[`${bay1.id}:0`];
    runUntil(state, () => p.times.triaged !== null, 60 * MIN);
    expect(p.bed).toBe(bay1.id);
    expect(state.today.stats.handoversOver30).toBe(1);
    // The waiting ambulance parks once the first has turned round.
    runUntil(state, () => ambulancesWaiting(state) === 0, 30 * MIN);
  });

  it("is noticed by the crew if their patient deteriorates while waiting", () => {
    const state = quiet({ ...MAJORS_TEAM, nurse: 0 });
    const a = ambulanceArrives(state);
    tick(state);
    const p = state.patients[a.patientId!]!;
    p.deterioration = { onset: state.tick, crash: state.tick + 30 * MIN, noticed: null };
    for (let i = 0; i < 20 * MIN; i++) tick(state);
    expect(p.deterioration?.noticed).not.toBeNull();
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/The ambulance crew noticed/);
  });
});

describe("Resus", () => {
  it("treats anaphylaxis, then moves the patient on to Majors, freeing Resus", () => {
    const state = quiet();
    const p = ambulanceWith(state, "anaphylaxis");
    runUntil(state, () => p.times.triaged !== null);
    const resus = p.bed!;
    expect(roomOfObject(state, resus)!.typeId).toBe("resus_bay");
    runUntil(state, () => p.step === 1 && p.bed !== resus);
    expect(roomOfObject(state, p.bed!)!.typeId).toBe("majors_bay");
    // Resus is cleaned for the next patient.
    expect(state.dirt[resus]).toBe(1);
  });

  it("transfers septic shock to intensive care after stabilising", () => {
    const state = quiet();
    const p = ambulanceWith(state, "septic_shock");
    runUntil(state, () => !state.patients[p.id], 300 * MIN);
    expect(state.today.stats.transferred).toBe(1);
    expect(state.incidents).toEqual([]);
  });
});

describe("an A&E with ambulances over 24 hours", () => {
  const state = staffedMajorsAE(2, MAJORS_TEAM, { ambulance: true });
  run(state, TICKS_PER_DAY);
  const stats = state.history[0]!.stats;

  it("receives and hands over ambulances, with delays when Majors is full", () => {
    expect(stats.ambulances).toBeGreaterThan(10);
    // No ward: patients who need admitting hold Majors trolleys until their
    // transfer ambulance comes, so fewer crews can hand over.
    expect(stats.handovers).toBeGreaterThan(7);
    expect(stats.handoversOver30).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = staffedMajorsAE(2, MAJORS_TEAM, { ambulance: true });
    run(again, TICKS_PER_DAY);
    expect(again.history).toEqual(state.history);
    expect(again.rng).toEqual(state.rng);
  });
});
