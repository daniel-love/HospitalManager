/**
 * Loans, ratings and grants (ROADMAP M5 step 5): DHSC capital and revenue
 * support loans, NHS oversight segments and special measures, bank loans
 * and credit ratings, administration, and grants with conditions.
 */
import { describe, expect, it } from "vitest";
import { CREDIT_RATINGS, GRANT_OFFERS, LOANS, OVERSIGHT } from "@data/finance";
import { emptyLedger, type MonthReport } from "@sim/agents";
import { applyCommand } from "@sim/commands";
import { tick } from "@sim/sim";
import { createSimState, emptyMonth, type Funding, type SimState } from "@sim/state";
import { acceptGrant, grantById, progress, updateGrants } from "@sim/systems/grants";
import {
  bankRate,
  borrow,
  cantBorrow,
  checkCash,
  instalment,
  repayLoans,
  reviewRating,
} from "@sim/systems/loans";
import { TICKS_PER_DAY, tickAt } from "@sim/time";
import { buildMajorsAE } from "../fixtures/majorsAE";
import { buildSmallAE } from "../fixtures/smallAE";

function hospital(funding: Funding = "nhs"): SimState {
  return createSimState({ seed: 1, width: 30, height: 30, money: 1_000_000, funding });
}

function month(income: number, costs: number, cash: number): MonthReport {
  return {
    ...emptyMonth(0, cash),
    days: 30,
    ledger: { ...emptyLedger(), block: income, salaries: costs },
  };
}

describe("instalments", () => {
  it("repay the loan with interest over its term", () => {
    expect(instalment(120_000, 0, 12)).toBeCloseTo(10_000);
    // £1m over 25 years at 4.5%: about £5,558 a month.
    expect(instalment(1_000_000, 0.045, 300)).toBeCloseTo(5558.33, 0);
  });
});

describe("an NHS trust's borrowing", () => {
  it("takes DHSC capital loans, not bank loans, within limits", () => {
    const state = hospital("nhs");
    expect(cantBorrow(state, "bank", 500_000, 5)).not.toBeNull();
    expect(cantBorrow(state, "capital", 50_000, 10)).not.toBeNull();
    expect(cantBorrow(state, "capital", 500_000, 30)).not.toBeNull();
    expect(cantBorrow(state, "capital", LOANS.capital.maxOutstanding + 1, 10)).not.toBeNull();
    expect(cantBorrow(state, "capital", 500_000, 10)).toBeNull();
    const before = state.money;
    const loan = borrow(state, "capital", 500_000, 10);
    expect(state.money).toBe(before + 500_000);
    expect(loan.rate).toBe(LOANS.dhscRate);
    expect(state.month.flows.borrowed).toBe(500_000);
  });

  it("repays monthly: interest as a running cost, principal as a cash flow", () => {
    const state = hospital("nhs");
    const loan = borrow(state, "capital", 600_000, 5);
    const cash = state.money;
    repayLoans(state);
    const interest = (600_000 * LOANS.dhscRate) / 12;
    expect(state.today.ledger.interest).toBeCloseTo(interest);
    expect(state.money).toBeCloseTo(cash - loan.payment);
    expect(loan.balance).toBeCloseTo(600_000 - (loan.payment - interest));
  });

  it("gets revenue support when cash runs out, and drops to segment 3", () => {
    const state = hospital("nhs");
    state.money = -120_000;
    checkCash(state);
    expect(state.money).toBeGreaterThanOrEqual(LOANS.revenueSupport.floor);
    expect(state.loans[0]!.kind).toBe("revenue_support");
    expect(state.rating.segment).toBe(3);
    expect(cantBorrow(state, "capital", 500_000, 10)).toMatch(/segment 3/);
  });

  it("is reviewed monthly into oversight segments, improving a step at a time", () => {
    const state = hospital("nhs");
    state.rating.segment = 3;
    reviewRating(state, month(300_000, 250_000, 1_000_000));
    expect(state.rating.segment).toBe(2);
    reviewRating(state, month(300_000, 250_000, 1_000_000));
    expect(state.rating.segment).toBe(1);
  });

  it("goes into financial special measures after a second bad month", () => {
    const state = hospital("nhs");
    borrow(state, "revenue_support", 500_000, 3);
    state.policies.gapFill = "bank_agency";
    reviewRating(state, month(300_000, 400_000, 10_000));
    expect(state.rating.segment).toBe(3);
    reviewRating(state, month(300_000, 400_000, 10_000));
    expect(state.rating.segment).toBe(4);
    expect(state.policies.gapFill).toBe("bank");
  });

  it("caps building under special measures", () => {
    const state = buildSmallAE(1);
    state.rating.segment = 4;
    state.month.flows.building = OVERSIGHT.specialMeasuresCapitalCap;
    const r = applyCommand(state, {
      type: "build_floor",
      floor: 0,
      rect: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/special measures/);
  });
});

describe("a Private Hospital's borrowing", () => {
  it("takes bank loans priced by its credit rating", () => {
    const state = hospital("private");
    expect(cantBorrow(state, "capital", 500_000, 10)).not.toBeNull();
    expect(cantBorrow(state, "bank", LOANS.bank.floor + 1, 5)).not.toBeNull();
    const good = bankRate(state);
    state.rating.credit = CREDIT_RATINGS.length - 1;
    expect(bankRate(state)).toBeGreaterThan(good);
  });

  it("misses repayments it can't afford, and goes into administration", () => {
    const state = hospital("private");
    borrow(state, "bank", 1_000_000, 5);
    state.money = 0;
    for (let i = 0; i < 3; i++) repayLoans(state);
    expect(state.rating.administration).not.toBeNull();
  });

  it("goes into administration after a month overdrawn", () => {
    const state = hospital("private");
    state.money = -1;
    checkCash(state);
    expect(state.loans).toEqual([]);
    state.tick += 30 * TICKS_PER_DAY;
    checkCash(state);
    expect(state.rating.administration).not.toBeNull();
  });
});

describe("grants", () => {
  it("are offered at random among those that fit, and paid when taken on", () => {
    const state = buildMajorsAE(1, { ward: "door_double" });
    state.settings.patientVolume = 0;
    while (!state.grants.offer && state.tick < tickAt(60, 1)) tick(state);
    expect(state.grants.offer).not.toBeNull();
    if (!state.grants.offer) return;
    // It has Majors and a ward, but no patients yet: more bays or more beds.
    expect(["uec_capacity", "winter_beds"]).toContain(state.grants.offer.defId);
    const def = grantById.get(state.grants.offer.defId)!;
    const before = state.money;
    expect(acceptGrant(state)).toBeNull();
    expect(state.money).toBe(before + def.amount);
    expect(state.grants.active.length).toBe(1);
  });

  it("are clawed back when the deadline passes unmet", () => {
    const state = buildSmallAE(1);
    state.grants.offer = { defId: "cdc", offered: 0, until: TICKS_PER_DAY, target: null };
    acceptGrant(state);
    const g = state.grants.active[0]!;
    expect(progress(state, g).share).toBe(0);
    const cash = state.money;
    const rep = state.reputation;
    state.tick = g.until;
    updateGrants(state);
    expect(state.grants.active).toEqual([]);
    expect(state.money).toBe(cash - grantById.get("cdc")!.amount);
    expect(state.grants.done[0]!.met).toBe(false);
    expect(state.reputation).toBe(rep - GRANT_OFFERS.reputationMissed);
  });

  it("are kept when the condition is met", () => {
    const state = buildSmallAE(1);
    state.grants.offer = { defId: "uec_capacity", offered: 0, until: TICKS_PER_DAY, target: 0 };
    acceptGrant(state);
    const cash = state.money;
    updateGrants(state);
    expect(state.grants.done[0]!.met).toBe(true);
    expect(state.money).toBe(cash);
  });
});
