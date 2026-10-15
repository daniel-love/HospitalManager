/**
 * PHS funding (ROADMAP M5 step 3): the block contract for emergency care,
 * the marginal rate on emergency tariff, planned care at full tariff, and
 * the monthly financial statement.
 */
import { describe, expect, it } from "vitest";
import { PHS_FUNDING } from "@data/economy";
import { net, type Ledger, type MonthReport } from "@sim/agents";
import { migrate } from "@save/migrations";
import { applyCommand } from "@sim/commands";
import { tick } from "@sim/sim";
import { createSimState } from "@sim/state";
import { earnElective, earnEmergency } from "@sim/systems/finance";
import { dailyBlock, emergencyValuePerDay } from "@sim/systems/funding";
import { applyStaffCommand } from "@sim/systems/staffing";
import { dateOf, tickAt } from "@sim/time";
import { buildMajorsAE } from "../fixtures/majorsAE";
import { buildSmallAE, hireRegistrars } from "../fixtures/smallAE";

describe("the block contract", () => {
  it("pays nothing for a hospital that can't treat anyone", () => {
    expect(dailyBlock(createSimState({ seed: 1 }))).toBe(0);
  });

  it("pays a share of the expected value of the emergency care it can provide", () => {
    const state = buildSmallAE(1);
    const value = emergencyValuePerDay(state);
    expect(value).toBeGreaterThan(0);
    expect(dailyBlock(state)).toBeCloseTo(value * PHS_FUNDING.blockShare);
  });

  it("is sized to the rooms there are to treat the catchment's patients in", () => {
    const state = buildSmallAE(1);
    // A small catchment fits in the rooms: twice the people, twice the value.
    state.settings.catchment = 4_000;
    const small = emergencyValuePerDay(state);
    state.settings.catchment = 8_000;
    expect(emergencyValuePerDay(state)).toBeCloseTo(small * 2);
    // The default catchment is more than two cubicles can treat: doubling it adds nothing.
    state.settings.catchment = 80_000;
    const full = emergencyValuePerDay(state);
    state.settings.catchment = 160_000;
    expect(emergencyValuePerDay(state)).toBeCloseTo(full);
  });

  it("grows with a ward and the specialty teams to admit, up to what the beds can take", () => {
    const state = buildMajorsAE(1, { ward: "door_double" });
    const noTeam = dailyBlock(state);
    hireRegistrars(state);
    const sixBeds = dailyBlock(state);
    expect(sixBeds).toBeGreaterThan(noTeam);
    // Remove the ward's beds: back to attendances only.
    const ward = state.rooms.find((r) => r.typeId === "ward")!;
    for (const id of ward.objectIds) {
      if (state.objects[id]?.defId !== "hospital_bed") continue;
      applyCommand(state, { type: "remove_object", floor: 0, id });
    }
    expect(dailyBlock(state)).toBeCloseTo(noTeam);
  });

  it("is paid at midnight, a day at a time", () => {
    const state = buildSmallAE(1);
    state.settings.patientVolume = 0;
    const block = dailyBlock(state);
    while (state.tick < tickAt(2, 0, 1)) tick(state);
    expect(state.history[0]!.ledger.block).toBeCloseTo(block);
  });
});

describe("tariff", () => {
  it("pays emergency care at the marginal rate and planned care in full", () => {
    const state = createSimState({ seed: 1 });
    earnEmergency(state, 1000, "ae");
    earnElective(state, 1000, "theatres");
    expect(state.today.ledger.tariff).toBeCloseTo(1000 * (1 - PHS_FUNDING.blockShare));
    expect(state.today.ledger.elective).toBe(1000);
  });
});

describe("the monthly statement", () => {
  it("is filed when a new month starts, adding up the month's days", () => {
    const state = buildSmallAE(1);
    state.settings.patientVolume = 0;
    applyStaffCommand(state, { type: "hire_staff", role: "porter" });
    const opening = state.month.openingCash;
    // 1 May is day 31.
    expect(dateOf(31)).toMatchObject({ month: 1, date: 1 });
    while (state.tick < tickAt(31, 0, 1)) tick(state);
    expect(state.months.length).toBe(1);
    const april = state.months[0]!;
    expect(april.monthIndex).toBe(0);
    expect(april.days).toBe(30);
    expect(april.openingCash).toBe(opening);
    const days = state.history.filter((d) => d.day <= 30);
    expect(net(april.ledger)).toBeCloseTo(days.reduce((n, d) => n + net(d.ledger), 0));
    expect(april.closingCash).toBeCloseTo(state.money);
    // Building came out of cash, outside the running costs.
    expect(april.openingCash + net(april.ledger) - april.closingCash).toBeGreaterThan(0);
    expect(state.month.monthIndex).toBe(1);
    expect(state.month.days).toBe(0);
  });
});

describe("old saves", () => {
  it("gain the new ledger lines and this month so far from their daily reports", () => {
    const day = (n: number) => ({
      day: n,
      ledger: {
        tariff: 100,
        outpatients: 0,
        salaries: 50,
        bank: 0,
        agency: 0,
        upkeep: 0,
        transfers: 0,
      },
      stats: { arrivals: 2 },
    });
    const old = {
      version: 28,
      state: {
        money: 1000,
        // 08:00 on day 3 (3 April).
        tick: 2 * 24 * 60 * 10,
        today: { ledger: day(3).ledger, stats: { arrivals: 1 } },
        history: [day(1), day(2)],
      },
    };
    const m = migrate(old) as {
      state: { history: { ledger: Ledger }[]; month: MonthReport; months: MonthReport[] };
    };
    expect(m.state.history[0]!.ledger).toMatchObject({ block: 0, elective: 0, supplies: 0 });
    expect(m.state.month).toMatchObject({ monthIndex: 0, days: 2, openingCash: 1000 });
    expect(m.state.month.ledger.tariff).toBe(200);
    expect(m.state.months).toEqual([]);
  });
});
