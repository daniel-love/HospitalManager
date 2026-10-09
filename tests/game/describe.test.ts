import { describe, expect, it } from "vitest";
import {
  describePatient,
  describePatientTable,
  describeReport,
  describeRoster,
  describeStaffTable,
  waitReason,
} from "@game/describe";
import { tick } from "@sim/sim";
import { TICKS_PER_MINUTE } from "@sim/time";

import { SMALL_AE_TEAM, staffedSmallAE } from "../fixtures/smallAE";

describe("UI descriptions", () => {
  const state = staffedSmallAE(3);
  for (let i = 0; i < 8 * 60 * TICKS_PER_MINUTE; i++) tick(state);

  it("summarises the roster and payroll", () => {
    const r = describeRoster(state);
    expect(r.staff).toHaveLength(9);
    const roles = r.groups.flatMap((g) => g.roles);
    expect(roles.find((x) => x.id === "nurse")!.count).toBe(2);
    expect(r.payroll).toBe(roles.reduce((sum, x) => sum + x.annualCost * x.count, 0));
  });

  it("groups the roles to hire: medical, nursing, diagnostics, support services, administrative", () => {
    const r = describeRoster(state);
    expect(r.groups.map((g) => [g.name, g.roles.map((x) => x.id)])).toEqual([
      ["Medical", ["consultant", "registrar", "junior_doctor"]],
      ["Nursing", ["nurse", "nurse_practitioner"]],
      ["Diagnostics", ["radiographer", "biomedical_scientist"]],
      ["Support services", ["porter", "cleaner"]],
      ["Administrative", ["receptionist"]],
    ]);
  });

  it("describes a patient's timeline in order", () => {
    const p = Object.values(state.patients).find((x) => x.times.triaged !== null)!;
    const info = describePatient(state, p);
    if (info.kind !== "patient") throw new Error("expected a patient");
    expect(info.category).toBeDefined();
    expect(info.timeline.map((t) => t.label).slice(0, 3)).toEqual([
      "Arrived",
      "Booked in",
      "Triaged",
    ]);
  });

  it("counts who is where right now", () => {
    const r = describeReport(state);
    const total = r.now.reduce((n, x) => n + x.count, 0);
    const inDept = Object.values(state.patients).filter((p) => p.stage !== "leaving").length;
    expect(total).toBe(inDept);
  });

  it("lists every patient in A&E, most urgent first", () => {
    const t = describePatientTable(state);
    const inDept = Object.values(state.patients).filter((p) => p.stage !== "leaving");
    expect(t.rows).toHaveLength(inDept.length);
    expect(t.counts.total).toBe(inDept.length);
    for (let i = 1; i < t.rows.length; i++) {
      expect(t.rows[i]!.dueIn).toBeGreaterThanOrEqual(t.rows[i - 1]!.dueIn);
    }
    for (const r of t.rows) {
      expect(r.overdue).toBe(r.dueIn < 0);
      expect(r.where).not.toBe("");
    }
  });

  it("says what every member of staff is doing", () => {
    const t = describeStaffTable(state);
    expect(t.rows).toHaveLength(9);
    expect(t.busy + t.free).toBe(9);
    const reception = t.rows.find((r) => r.roleId === "receptionist")!;
    expect(["at_desk", "working", "on_the_way"]).toContain(reception.status);
    for (const r of t.rows) {
      if (r.progress !== null) {
        expect(r.status).toBe("working");
        expect(r.progress).toBeGreaterThanOrEqual(0);
        expect(r.progress).toBeLessThanOrEqual(1);
      }
      if (r.status === "free") expect(r.activity).toBe("Free");
    }
  });
});

describe("why patients are waiting", () => {
  const reasonsAfter = (team: Parameters<typeof staffedSmallAE>[1], hours: number) => {
    const state = staffedSmallAE(3, team);
    for (let i = 0; i < hours * 60 * TICKS_PER_MINUTE; i++) tick(state);
    return Object.values(state.patients)
      .map((p) => waitReason(state, p))
      .filter((r): r is string => r !== null);
  };

  it("names missing staff", () => {
    const reasons = reasonsAfter({ ...SMALL_AE_TEAM, junior_doctor: 0 }, 8);
    expect(reasons.some((r) => r.includes("No Junior Doctors on staff"))).toBe(true);
    const queue = reasonsAfter({ ...SMALL_AE_TEAM, receptionist: 0 }, 4);
    expect(queue.some((r) => r.startsWith("No receptionist on staff"))).toBe(true);
  });

  it("names a full room, with how many are in use", () => {
    // Two cubicles can't keep up, so at some point in the morning someone waits for one.
    const state = staffedSmallAE(3, SMALL_AE_TEAM);
    const seen: string[] = [];
    for (let hour = 1; hour <= 12; hour++) {
      for (let i = 0; i < 60 * TICKS_PER_MINUTE; i++) tick(state);
      for (const p of Object.values(state.patients)) seen.push(waitReason(state, p) ?? "");
    }
    expect(seen.some((r) => /No free Minors Cubicle \(2 of 2 in use/.test(r))).toBe(true);
  });
});
