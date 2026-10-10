/**
 * Staff as people (ROADMAP M5 step 2): nurse bands, skill, fatigue, morale,
 * sickness, resignations, and bank and agency staff filling rota gaps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AGENCY, NURSE_IN_CHARGE, RESIGNATION, SICKNESS } from "@data/staff";
import type { StaffRoleId } from "@data/schema";
import { onDuty, onSite, type Staff } from "@sim/agents";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { annualCost } from "@sim/systems/finance";
import { rota, rotaGroup, setCover } from "@sim/systems/rota";
import { applyStaffCommand, staffTitle } from "@sim/systems/staffing";
import { endOfShift, workRate } from "@sim/systems/workforce";
import { tickAt, TICKS_PER_DAY } from "@sim/time";
import { buildSmallAE } from "../fixtures/smallAE";

function withRotas(): SimState {
  const state = buildSmallAE(1);
  state.settings.rotas = true;
  state.settings.patientVolume = 0;
  return state;
}

function hire(state: SimState, role: StaffRoleId, extra: object = {}): Staff {
  const r = applyStaffCommand(state, { type: "hire_staff", role, ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.staff;
}

function runTo(state: SimState, t: number): void {
  while (state.tick < t) tick(state);
}

const saved = { sick: SICKNESS.base, resign: RESIGNATION.dailyChance };
afterEach(() => {
  SICKNESS.base = saved.sick;
  RESIGNATION.dailyChance = saved.resign;
});

describe("nurse bands", () => {
  it("each band has its title, pay and rota group", () => {
    const state = withRotas();
    const five = hire(state, "nurse");
    const seven = hire(state, "nurse", { band: 7 });
    expect(staffTitle(five)).toBe("Staff Nurse (Band 5)");
    expect(staffTitle(seven)).toBe("Charge Nurse (Band 7)");
    expect(annualCost(seven)).toBeGreaterThan(annualCost(five));
    expect(rotaGroup(five)).toBe("nurse:band5");
    expect(rotaGroup(seven)).toBe("nurse:band7");
    expect(applyStaffCommand(state, { type: "hire_staff", role: "porter", band: 6 }).ok).toBe(
      false,
    );
  });

  it("a Band 7 on duty speeds up the nursing team", () => {
    const state = buildSmallAE(1);
    const nurse = hire(state, "nurse");
    const porter = hire(state, "porter");
    const before = workRate(state, nurse);
    const porterBefore = workRate(state, porter);
    hire(state, "nurse", { band: 7 });
    state.tick++; // The nurse in charge is worked out once a tick.
    expect(workRate(state, nurse)).toBeCloseTo(before * (1 + NURSE_IN_CHARGE.speedUp));
    expect(workRate(state, porter)).toBeCloseTo(porterBefore);
  });
});

describe("work rate", () => {
  it("rises with skill and falls with fatigue, low morale and agency unfamiliarity", () => {
    const state = buildSmallAE(1);
    const s = hire(state, "porter");
    s.skill = 50;
    const base = workRate(state, s);
    expect(base).toBeCloseTo(1);
    s.skill = 100;
    expect(workRate(state, s)).toBeGreaterThan(base);
    s.skill = 50;
    s.fatigue = 100;
    expect(workRate(state, s)).toBeLessThan(base);
    s.fatigue = 0;
    s.morale = 10;
    expect(workRate(state, s)).toBeLessThan(base);
    s.morale = 75;
    s.contract = "agency";
    expect(workRate(state, s)).toBeCloseTo(base * AGENCY.unfamiliar);
  });
});

describe("fatigue and morale", () => {
  it("fatigue builds on shift and falls at home", () => {
    const state = withRotas();
    setCover(state, "porter", { day: 1, night: 0 });
    const p = hire(state, "porter");
    expect(onDuty(p)).toBe(true);
    runTo(state, tickAt(1, 19, 0));
    const tired = p.fatigue;
    expect(tired).toBeGreaterThan(25);
    runTo(state, tickAt(2, 6, 0));
    expect(p.fatigue).toBeLessThan(tired);
  });

  it("a busy shift wears morale down; a quiet one lifts it", () => {
    const state = buildSmallAE(1);
    const s = hire(state, "porter");
    s.shiftLoad = { mins: 100, busy: 90, short: true };
    endOfShift(s);
    expect(s.morale).toBeLessThan(75);
    const after = s.morale;
    s.shiftLoad = { mins: 100, busy: 10, short: false };
    endOfShift(s);
    expect(s.morale).toBeGreaterThan(after);
  });

  it("unhappy staff hand in their notice, and leave once it's worked", () => {
    const state = withRotas();
    RESIGNATION.dailyChance = 100;
    const p = hire(state, "porter");
    p.morale = 0;
    runTo(state, tickAt(2, 0, 1));
    expect(p.leavesAt).not.toBeNull();
    p.morale = 0;
    runTo(state, p.leavesAt! + TICKS_PER_DAY);
    expect(state.staff[p.id]).toBeUndefined();
  });
});

describe("rota gaps", () => {
  it("bank and agency staff fill gaps for one shift, paid by the hour", () => {
    const state = withRotas();
    state.policies.gapFill = "bank_agency";
    setCover(state, "porter", { day: 2, night: 2 });
    runTo(state, tickAt(1, 19, 31));
    const temps = Object.values(state.staff).filter(
      (s) => s.contract === "bank" || s.contract === "agency",
    );
    expect(temps.length).toBe(2);
    expect(temps.every(onSite)).toBe(true);
    expect(rota(state).size).toBe(0); // Never on the rota.
    runTo(state, tickAt(2, 9, 0));
    for (const t of temps) expect(state.staff[t.id]).toBeUndefined();
    expect(state.today.ledger.bank + state.today.ledger.agency).toBeGreaterThan(0);
  });

  it("with the policy off, gaps stay unfilled", () => {
    const state = withRotas();
    state.policies.gapFill = "none";
    setCover(state, "porter", { day: 1, night: 1 });
    runTo(state, tickAt(1, 20, 0));
    expect(Object.values(state.staff).length).toBe(0);
  });

  it("someone who calls in sick stays home, and the bank covers if it can", () => {
    const state = withRotas();
    state.policies.gapFill = "bank_agency";
    SICKNESS.base = 1;
    setCover(state, "porter", { day: 0, night: 1 });
    const nights = Array.from({ length: 3 }, () => hire(state, "porter"));
    runTo(state, tickAt(1, 19, 31));
    const rostered = nights.find((p) => rota(state).get(p.id)! & (1 << 1))!;
    expect(onSite(rostered)).toBe(false);
    expect(rostered.sickUntil).not.toBeNull();
    const temps = Object.values(state.staff).filter((s) => s.contract !== "resident");
    expect(temps.length).toBe(1);
  });
});
