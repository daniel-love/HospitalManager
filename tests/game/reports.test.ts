/**
 * Finance and KPI screens (ROADMAP M5 step 7): the statement over several
 * months and the year to date, departments adding up to the surplus, and
 * KPIs rated against their standards.
 */
import { describe, expect, it } from "vitest";
import { describeFinance } from "@game/describeFinance";
import { describeHospital } from "@game/describeHospital";
import { KPIS } from "@game/kpis";
import { emptyStats, net } from "@sim/agents";
import { tick } from "@sim/sim";
import { emptyMonth } from "@sim/state";
import { TICKS_PER_DAY } from "@sim/time";
import { staffedHospital } from "../fixtures/hospital";

describe("finance and KPI screens", () => {
  it("shows months, the year to date and departments that add up", () => {
    const state = staffedHospital(4);
    // Two days of April, filed as if they were the whole month, and the same again for May.
    for (let i = 0; i < 2 * TICKS_PER_DAY; i++) tick(state);
    state.months.push(state.month);
    state.month = { ...structuredClone(state.month), monthIndex: 1 };
    const data = describeFinance(state);
    expect(data.statement.map((c) => c.name)).toEqual(["May so far", "April", "Year 1 to date"]);
    const [may, april, ytd] = data.statement;
    expect(ytd!.days).toBe(may!.days + april!.days);
    expect(net(ytd!.ledger)).toBeCloseTo(net(may!.ledger) + net(april!.ledger), 2);

    const last = data.departments.find((p) => p.id === "last")!;
    expect(last.unattributed).toBe(0);
    const sum = [...last.patientFacing, ...last.shared].reduce((n, r) => n + r.net, 0);
    expect(sum).toBeCloseTo(last.surplus, 2);
    expect(last.patientFacing.map((r) => r.line)).toEqual([
      "ae",
      "wards",
      "theatres",
      "outpatients",
    ]);
    expect(last.patientFacing.find((r) => r.line === "ae")!.activity!.count).toBeGreaterThan(0);
    for (const r of last.shared) expect(r.income).toBe(0);
  });

  it("rates KPIs against their standards", () => {
    const kpi = (id: string) => KPIS.find((k) => k.id === id)!;
    const m = { ...emptyMonth(0, 0), days: 30, stats: { ...emptyStats(), departures: 100 } };
    m.stats.within4h = 96;
    expect(kpi("four_hour").rate(kpi("four_hour").value(m)!)).toBe("ok");
    m.stats.within4h = 80;
    expect(kpi("four_hour").rate(kpi("four_hour").value(m)!)).toBe("warn");
    m.stats.within4h = 50;
    expect(kpi("four_hour").rate(kpi("four_hour").value(m)!)).toBe("bad");
    // Nothing to measure: no figure.
    expect(kpi("cancer_2ww").value(m)).toBeNull();

    const state = staffedHospital(4);
    const perf = describeHospital(state).performance;
    // Nothing filed yet this month.
    expect(perf.rows.every((r) => r.cells[0]!.text === "—")).toBe(true);
  });
});
