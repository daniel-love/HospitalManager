/**
 * Private care and reputation (ROADMAP M5 step 4): funding models,
 * practising privileges, private referrals and facility fees, private
 * inpatients in a room of their own, a Hybrid trust's Private Patient Unit
 * and its income cap, and reputation.
 */
import { describe, expect, it } from "vitest";
import { PRIVATE, REPUTATION } from "@data/economy";
import { emptyLedger, emptyStats, type Referral } from "@sim/agents";
import { tick } from "@sim/sim";
import { createSimState, type Funding, type SimState } from "@sim/state";
import { dailyBlock } from "@sim/systems/funding";
import { jobPlan } from "@sim/systems/clinics";
import { annualCost } from "@sim/systems/finance";
import {
  bookAppointments,
  offersClinic,
  offersPrivateClinic,
  overPrivateCap,
  refer,
} from "@sim/systems/referrals";
import { dayScore, updateReputation } from "@sim/systems/reputation";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_DAY } from "@sim/time";
import { roomAt, setPrivateRoom, setRoomSpecialty } from "@sim/world/rooms";
import { CLINIC_A, CLINIC_B, OUTPATIENTS_COMMANDS } from "../fixtures/outpatients";
import { applyAll, buildSmallAE, FIXTURE_MONEY } from "../fixtures/smallAE";
import { buildTheatres } from "../fixtures/theatres";

/** The outpatients department under a funding model, with an outpatients receptionist. */
function outpatients(funding: Funding): SimState {
  const state = createSimState({ seed: 1, width: 20, height: 16, money: FIXTURE_MONEY, funding });
  applyAll(state, OUTPATIENTS_COMMANDS);
  setRoomSpecialty(state, roomAt(state, 0, CLINIC_A.x, CLINIC_A.y)!, "cardiology");
  applyStaffCommand(state, { type: "hire_staff", role: "outpatient_receptionist" });
  // Plenty of patients, so a fortnight shows the pattern.
  state.settings.catchment = 2_000_000;
  return state;
}

function consultant(state: SimState, extra: object = {}) {
  const r = applyStaffCommand(state, {
    type: "hire_staff",
    role: "consultant",
    specialty: "cardiology",
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  return r.staff;
}

function runDays(state: SimState, days: number): void {
  for (let i = 0; i < days * TICKS_PER_DAY; i++) tick(state);
}

describe("a Private Hospital", () => {
  it("works with consultants' practising privileges, and no registrars", () => {
    const state = outpatients("private");
    expect(
      applyStaffCommand(state, { type: "hire_staff", role: "consultant", specialty: "cardiology" })
        .ok,
    ).toBe(false);
    expect(
      applyStaffCommand(state, { type: "hire_staff", role: "registrar", specialty: "cardiology" })
        .ok,
    ).toBe(false);
    const c = consultant(state, { privileges: true });
    expect(c.contract).toBe("privileges");
    expect(annualCost(c)).toBe(0);
    // A PHS trust employs its consultants.
    const phs = outpatients("phs");
    expect(
      applyStaffCommand(phs, {
        type: "hire_staff",
        role: "consultant",
        specialty: "cardiology",
        privileges: true,
      }).ok,
    ).toBe(false);
  });

  it("gets private patients, paying facility fees, and PHS patients only if it takes them", () => {
    const state = outpatients("private");
    const c = consultant(state, { privileges: true });
    applyStaffCommand(state, { type: "set_clinic_sessions", id: c.id, sessions: 6 });
    expect(jobPlan(state, c).every((p) => p.private)).toBe(true);
    expect(offersPrivateClinic(state, "cardiology")).toBe(true);
    expect(offersClinic(state, "cardiology")).toBe(false);
    runDays(state, 14);
    const refs = Object.values(state.referrals);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.payer !== "phs")).toBe(true);
    const seen = state.history.reduce((n, d) => n + d.stats.privateSeen, 0);
    expect(seen).toBeGreaterThan(0);
    expect(state.history.reduce((n, d) => n + d.ledger.private, 0)).toBeGreaterThan(0);
    expect(state.history.reduce((n, d) => n + d.ledger.outpatients, 0)).toBe(0);

    state.policies.phsReferrals.cardiology = true;
    expect(offersClinic(state, "cardiology")).toBe(true);
    runDays(state, 7);
    expect(Object.values(state.referrals).some((r) => r.payer === "phs")).toBe(true);
  });

  it("has no emergency department and no block contract", () => {
    const state = buildSmallAE(1);
    state.funding = "private";
    expect(dailyBlock(state)).toBe(0);
    runDays(state, 1);
    expect(Object.keys(state.patients).length).toBe(0);
  });

  it("only comes in on days with a session", () => {
    const state = outpatients("private");
    const c = consultant(state, { privileges: true });
    applyStaffCommand(state, { type: "set_clinic_sessions", id: c.id, sessions: 1 });
    // One session: Monday morning.
    runDays(state, 1);
    expect(c.duty).not.toBe("on");
  });

  it("charges self-pay patients more at a higher price level, and gets fewer of them", () => {
    const state = outpatients("private");
    const c = consultant(state, { privileges: true });
    applyStaffCommand(state, { type: "set_clinic_sessions", id: c.id, sessions: 6 });
    state.policies.priceLevel = PRIVATE.priceLevels[1];
    runDays(state, 14);
    const refs = Object.values(state.referrals);
    const selfPay = refs.filter((r) => r.payer === "self_pay").length;
    // At 1.5× prices self-pay demand is under half its usual share of private patients.
    const usual = PRIVATE.selfPayShare / (PRIVATE.selfPayShare + PRIVATE.insuredShare);
    expect(selfPay / refs.length).toBeLessThan(usual);
  });
});

describe("private surgery", () => {
  function privateTheatres(): SimState {
    const state = buildTheatres(1);
    state.funding = "private";
    for (const s of Object.values(state.staff))
      if (s.role === "consultant") s.contract = "privileges";
    state.settings.patientVolume = 0;
    return state;
  }
  function listedPrivate(state: SimState, dayCase: boolean): Referral {
    const r = refer(state, "trauma_orthopaedics", false, "insured");
    r.kind = "surgery";
    r.dayCase = dayCase;
    bookAppointments(state);
    return r;
  }

  it("is paid a facility fee for a day case", () => {
    const state = privateTheatres();
    const r = listedPrivate(state, true);
    expect(r.booking).not.toBeNull();
    for (let i = 0; i < 7 * TICKS_PER_DAY && state.referrals[r.id]; i++) tick(state);
    runDays(state, 1);
    const fee =
      state.history.reduce((n, d) => n + d.ledger.private, 0) + state.today.ledger.private;
    expect(fee).toBeGreaterThan(0);
    expect(state.history.reduce((n, d) => n + d.stats.privateOps, 0)).toBe(1);
  });

  it("cancels an inpatient with no private room for afterwards (the fixture's ward is all bays)", () => {
    const state = privateTheatres();
    const r = listedPrivate(state, false);
    for (let i = 0; i < 7 * TICKS_PER_DAY && r.rebookBy === null; i++) tick(state);
    expect(r.rebookBy).not.toBeNull();
  });
});

describe("a Hybrid trust's Private Patient Unit", () => {
  it("holds private sessions in its rooms and PHS ones outside it", () => {
    const state = outpatients("hybrid");
    const c = consultant(state);
    applyStaffCommand(state, { type: "set_clinic_sessions", id: c.id, sessions: 2 });
    applyStaffCommand(state, {
      type: "set_private_sessions",
      id: c.id,
      kind: "clinic",
      sessions: 2,
    });
    expect(c.privateClinicSessions).toBe(2);
    // No Private Patient Unit yet: PHS clinics, but nowhere for private ones.
    expect(offersClinic(state, "cardiology")).toBe(true);
    expect(offersPrivateClinic(state, "cardiology")).toBe(false);
    setPrivateRoom(state, roomAt(state, 0, CLINIC_B.x, CLINIC_B.y)!, true);
    expect(offersPrivateClinic(state, "cardiology")).toBe(true);
    // Clinic A is cardiology's and outside the unit: PHS still fine.
    expect(offersClinic(state, "cardiology")).toBe(true);
    runDays(state, 14);
    const refs = Object.values(state.referrals);
    expect(refs.some((r) => r.payer === "phs")).toBe(true);
    expect(refs.some((r) => r.payer !== "phs")).toBe(true);
  });

  it("caps private income at 49% of all income", () => {
    const state = outpatients("hybrid");
    const c = consultant(state);
    applyStaffCommand(state, {
      type: "set_private_sessions",
      id: c.id,
      kind: "clinic",
      sessions: 2,
    });
    setPrivateRoom(state, roomAt(state, 0, CLINIC_B.x, CLINIC_B.y)!, true);
    expect(offersPrivateClinic(state, "cardiology")).toBe(true);
    const ledger = { ...emptyLedger(), private: 600, outpatients: 400 };
    state.history.push({ day: 1, ledger, stats: emptyStats(), reputation: 60 });
    expect(overPrivateCap(state)).toBe(true);
    expect(offersPrivateClinic(state, "cardiology")).toBe(false);
  });

  it("is only for Hybrid trusts' employed consultants", () => {
    const state = outpatients("phs");
    const c = consultant(state);
    expect(
      applyStaffCommand(state, {
        type: "set_private_sessions",
        id: c.id,
        kind: "clinic",
        sessions: 1,
      }).ok,
    ).toBe(false);
  });
});

describe("reputation", () => {
  it("moves towards each day's patient experience, over about a month", () => {
    const state = createSimState({ seed: 1 });
    const good = { ...emptyStats(), departures: 100, within4h: 100 };
    expect(dayScore(state, good)).toBe(100);
    updateReputation(state, good);
    expect(state.reputation).toBeCloseTo(
      REPUTATION.start + (100 - REPUTATION.start) / REPUTATION.smoothingDays,
    );
    const bad = { ...emptyStats(), departures: 100, within4h: 20, lwbs: 30, unexpectedDeaths: 2 };
    expect(dayScore(state, bad)!).toBeLessThan(30);
  });

  it("stays put on a day with nothing to judge", () => {
    const state = createSimState({ seed: 1 });
    updateReputation(state, emptyStats());
    expect(state.reputation).toBe(REPUTATION.start);
  });
});
