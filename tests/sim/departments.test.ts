/**
 * Department statuses (ROADMAP M5 step 6), and M5's "done when": a full
 * in-game month runs with a monthly statement, and closing or diverting a
 * department has visible financial and reputation effects.
 */
import { describe, expect, it } from "vitest";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { sessionsOn } from "@sim/systems/clinics";
import { setDepartment } from "@sim/systems/departments";
import { dailyBlock } from "@sim/systems/funding";
import { refer } from "@sim/systems/referrals";
import { statusPenalty } from "@sim/systems/reputation";
import { cantOperate, listsOn } from "@sim/systems/theatres";
import { tickAt, TICKS_PER_DAY } from "@sim/time";
import { buildMajorsAE, MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { buildOutpatients } from "../fixtures/outpatients";
import { buildTheatres } from "../fixtures/theatres";

function runDays(state: SimState, days: number): void {
  for (let i = 0; i < days * TICKS_PER_DAY; i++) tick(state);
}

describe("A&E", () => {
  it("on divert takes walk-ins but no ambulances, and loses the block's ambulance share", () => {
    const state = staffedMajorsAE(1, MAJORS_TEAM, { ambulance: true });
    const open = dailyBlock(state);
    setDepartment(state, "ae", "divert");
    expect(dailyBlock(state)).toBeLessThan(open);
    expect(dailyBlock(state)).toBeGreaterThan(0);
    runDays(state, 2);
    expect(Object.keys(state.ambulances).length).toBe(0);
    expect(state.history.reduce((n, d) => n + d.stats.diverted, 0)).toBeGreaterThan(0);
    expect(state.history.reduce((n, d) => n + d.stats.arrivals, 0)).toBeGreaterThan(0);
  });

  it("closed takes nobody, and the block stops", () => {
    const state = buildMajorsAE(1, { ambulance: true });
    setDepartment(state, "ae", "closed");
    expect(dailyBlock(state)).toBe(0);
    runDays(state, 1);
    expect(Object.keys(state.patients).length).toBe(0);
  });
});

describe("outpatients", () => {
  it("closed holds no clinics and cancels bookings", () => {
    const state = buildOutpatients(1);
    const r = refer(state, "cardiology");
    runDays(state, 1);
    expect(r.booking).not.toBeNull();
    setDepartment(state, "outpatients", "closed");
    expect(sessionsOn(state, r.booking?.day ?? 3, "am")).toEqual([]);
    expect(state.referrals[r.id]!.booking).toBeNull();
  });

  it("taking urgent referrals only, gets no routine ones", () => {
    const state = buildOutpatients(1);
    state.settings.catchment = 2_000_000;
    setDepartment(state, "outpatients", "urgent");
    runDays(state, 7);
    const refs = Object.values(state.referrals);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.urgent)).toBe(true);
  });
});

describe("theatres", () => {
  it("for emergencies only stand planned lists down; closed, can't operate", () => {
    const state = buildTheatres(1);
    const monday = 1;
    expect(
      listsOn(state, monday, "am").length + listsOn(state, monday, "pm").length,
    ).toBeGreaterThan(0);
    setDepartment(state, "theatres", "emergency");
    expect(listsOn(state, monday, "am")).toEqual([]);
    expect(cantOperate(state, "trauma_orthopaedics")).toBeNull();
    setDepartment(state, "theatres", "closed");
    expect(cantOperate(state, "trauma_orthopaedics")).toMatch(/closed/);
  });
});

describe("M5 done when: a month with A&E diverted or closed", () => {
  it("files a monthly statement with less income and a lower reputation", () => {
    const run = (status: "open" | "divert" | "closed") => {
      const state = staffedMajorsAE(2, MAJORS_TEAM, { ambulance: true });
      // A catchment this A&E can cope with.
      state.settings.catchment = 30_000;
      if (status !== "open") setDepartment(state, "ae", status);
      // 1 May is day 31: April's statement is filed then.
      while (state.tick < tickAt(31, 0, 1)) tick(state);
      const april = state.months[0]!;
      return { block: april.ledger.block, reputation: state.reputation };
    };
    const open = run("open");
    const divert = run("divert");
    const closed = run("closed");
    expect(divert.block).toBeLessThan(open.block);
    expect(closed.block).toBe(0);
    expect(divert.reputation).toBeLessThan(open.reputation);
    expect(closed.reputation).toBeLessThan(divert.reputation);
  }, 120_000);

  it("counts each department that isn't fully open against reputation", () => {
    const state = buildOutpatients(1);
    expect(statusPenalty(state)).toBe(0);
    setDepartment(state, "outpatients", "urgent");
    setDepartment(state, "theatres", "emergency");
    expect(statusPenalty(state)).toBe(10);
  });
});
