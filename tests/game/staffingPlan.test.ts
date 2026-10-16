import { describe, expect, it } from "vitest";
import { describeRoster } from "@game/describe";
import { coverCost, gapCost, peopleFor, staffingPlan } from "@game/staffingPlan";
import { setCover } from "@sim/systems/rota";
import { staffedHospital } from "../fixtures/hospital";
import { staffedSmallAE } from "../fixtures/smallAE";

const suggested = (plan: ReturnType<typeof staffingPlan>, key: string) =>
  plan.groups.find((g) => g.key === key)?.suggested;

describe("staffing plan", () => {
  it("turns cover into people on three shifts a week", () => {
    expect(peopleFor({ day: 1, night: 1 })).toBe(5);
    expect(peopleFor({ day: 2, night: 1 })).toBe(7);
    expect(peopleFor({ day: 0, night: 0 })).toBe(0);
  });

  it("costs nights more than days in unsocial hours", () => {
    const day = coverCost("porter", { day: 1, night: 0 });
    const night = coverCost("porter", { day: 0, night: 1 });
    expect(night.salaries).toBe(day.salaries);
    expect(night.unsocial).toBeGreaterThan(day.unsocial);
    expect(day.unsocial).toBeGreaterThan(0); // weekends
    const gaps = gapCost("porter", { day: 1, night: 1 }, 2);
    expect(gaps.agency).toBeCloseTo(gaps.bank * 2);
  });

  it("suggests a nurse in charge and a doctor on every shift of an A&E", () => {
    const plan = staffingPlan(staffedSmallAE(1));
    expect(plan.demand.hereWalkIns).toBeGreaterThan(0);
    expect(suggested(plan, "nurse:band7")).toEqual({ day: 1, night: 1 });
    const doctors = suggested(plan, "junior_doctor")!;
    expect(doctors.night).toBeGreaterThanOrEqual(1);
    expect(doctors.day).toBeGreaterThanOrEqual(doctors.night);
  });

  it("suggests more staff for more patients", () => {
    const small = staffedSmallAE(1);
    const big = staffedSmallAE(1);
    big.settings.catchment = small.settings.catchment * 3;
    const total = (s: typeof small) =>
      staffingPlan(s).groups.reduce((n, g) => n + g.suggested.day + g.suggested.night, 0);
    expect(total(big)).toBeGreaterThan(total(small));
  });

  it("nurses the wards and staffs the theatres of a whole hospital", () => {
    const plan = staffingPlan(staffedHospital(1));
    expect(plan.demand.wardBeds).toBeGreaterThan(0);
    const nurses = plan.groups
      .filter((g) => g.role === "nurse")
      .reduce((n, g) => n + g.suggested.day, 0);
    expect(nurses).toBeGreaterThanOrEqual(Math.ceil(plan.demand.wardBeds / 8));
    if (plan.demand.theatres > 0) {
      expect(suggested(plan, "theatre_practitioner")!.day).toBe(2 * plan.demand.theatres);
    }
  });

  it("shows each rota group's headcount, cost and suggestion on the Staff screen", () => {
    const state = staffedSmallAE(1);
    state.settings.rotas = true;
    setCover(state, "porter", { day: 2, night: 1 });
    const roster = describeRoster(state);
    const porters = roster.rota.find((r) => r.key === "porter")!;
    expect(porters.needed).toBe(7);
    expect(porters.cost.salaries).toBe(7 * porters.pay);
    expect(porters.suggested).not.toBeNull();
    const row = roster.plan.rows.find((r) => r.key === "porter")!;
    expect(row.cover).toEqual({ day: 2, night: 1 });
    expect(roster.plan.people).toBeGreaterThan(0);
    expect(roster.plan.cost).toBeGreaterThan(0);
  });
});
