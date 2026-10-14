/**
 * Service-line reporting (ROADMAP M5 step 7): income and running costs by
 * department, adding up to the ledger.
 */
import { describe, expect, it } from "vitest";
import { content } from "@data/catalogue";
import { SERVICE_SPLIT } from "@data/economy";
import { SERVICE_LINES, emptyLedger, type Ledger, type ServiceLedgers } from "@sim/agents";
import { tick } from "@sim/sim";
import { createSimState } from "@sim/state";
import { earnPlanned } from "@sim/systems/finance";
import { lineOfRoom } from "@sim/systems/serviceLines";
import { TICKS_PER_DAY } from "@sim/time";
import { staffedHospital } from "../fixtures/hospital";

function total(services: ServiceLedgers): Ledger {
  const sum = emptyLedger();
  for (const line of SERVICE_LINES) {
    for (const k of Object.keys(sum) as (keyof Ledger)[]) sum[k] += services[line][k];
  }
  return sum;
}

describe("service lines", () => {
  it("puts patient-facing rooms in their departments and shared space in support", () => {
    expect(lineOfRoom("majors_bay")).toBe("ae");
    expect(lineOfRoom("ward")).toBe("wards");
    expect(lineOfRoom("recovery")).toBe("theatres");
    expect(lineOfRoom("outpatient_clinic")).toBe("outpatients");
    expect(lineOfRoom("ct_room")).toBe("diagnostics");
    expect(lineOfRoom("corridor")).toBe("support");
    expect(lineOfRoom("mortuary")).toBe("support");
    for (const r of content.rooms) expect(SERVICE_LINES).toContain(lineOfRoom(r.id));
  });

  it("splits a planned inpatient's tariff between Theatres and Wards", () => {
    const state = createSimState({ seed: 1 });
    earnPlanned(state, 1000, "nhs", false);
    earnPlanned(state, 500, "nhs", true);
    const s = state.today.services;
    expect(s.wards.elective).toBeCloseTo(1000 * SERVICE_SPLIT.plannedStayShare);
    expect(s.theatres.elective).toBeCloseTo(500 + 1000 * (1 - SERVICE_SPLIT.plannedStayShare));
  });

  it("books a whole hospital's month by department, adding up to the statement", () => {
    const state = staffedHospital(2);
    for (let i = 0; i < 3 * TICKS_PER_DAY; i++) tick(state);
    const month = state.month;
    const byLine = total(month.services);
    for (const k of Object.keys(byLine) as (keyof Ledger)[]) {
      expect(byLine[k]).toBeCloseTo(month.ledger[k], 2);
    }
    const s = month.services;
    // A&E earns from attendances and the block; Diagnostics and support only cost.
    expect(s.ae.tariff + s.ae.block).toBeGreaterThan(0);
    expect(s.ae.salaries).toBeGreaterThan(0);
    expect(s.wards.block).toBeGreaterThan(0);
    expect(s.diagnostics.salaries).toBeGreaterThan(0);
    expect(s.diagnostics.tariff + s.diagnostics.block + s.diagnostics.elective).toBe(0);
    expect(s.support.salaries).toBeGreaterThan(0);
    expect(s.support.estates).toBeGreaterThan(0);
    // The KPI counters.
    expect(month.stats.bedHours).toBeGreaterThan(0);
    expect(month.end.headcount).toBeGreaterThan(0);
  });
});
