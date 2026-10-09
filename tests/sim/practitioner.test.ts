import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Patient } from "@sim/agents";
import { tick } from "@sim/sim";
import { TICKS_PER_DAY } from "@sim/time";
import { SMALL_AE_TEAM, staffedSmallAE } from "../fixtures/smallAE";

/** Runs a day, returning everyone who was discharged. */
function dischargedOver(team: Parameters<typeof staffedSmallAE>[1], seed = 11) {
  const state = staffedSmallAE(seed, team);
  const out = new Map<number, Patient>();
  const assessors = new Map<number, string>();
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    tick(state);
    for (const j of Object.values(state.jobs)) {
      if (j.kind === "treat" && j.step === 0 && j.state === "working" && j.staffId !== null) {
        assessors.set(j.patientId!, state.staff[j.staffId]!.role);
      }
    }
    for (const p of Object.values(state.patients)) {
      if (p.outcome === "discharged") out.set(p.id, p);
    }
  }
  return { state, discharged: [...out.values()], assessors };
}

const isInjury = (p: Patient) =>
  conditionById.get(p.conditionId)!.pathway[0]!.roles.includes("nurse_practitioner");

describe("Emergency Nurse Practitioners", () => {
  it("see and treat minor injuries without a doctor, but not illnesses", () => {
    const { state, discharged } = dischargedOver({
      ...SMALL_AE_TEAM,
      junior_doctor: 0,
      nurse_practitioner: 2,
    });
    expect(discharged.length).toBeGreaterThan(10);
    expect(discharged.every(isInjury)).toBe(true);
    const text = state.events.map((e) => e.text).join("\n");
    expect(text).toMatch(/doctor assessment, but you have no Junior Doctors/);
  });

  it("share injury assessments with doctors", () => {
    const { assessors } = dischargedOver({ ...SMALL_AE_TEAM, nurse_practitioner: 1 });
    const roles = new Set(assessors.values());
    expect(roles.has("nurse_practitioner")).toBe(true);
    expect(roles.has("junior_doctor")).toBe(true);
  });

  it("never triage", () => {
    const state = staffedSmallAE(11, { ...SMALL_AE_TEAM, nurse: 0, nurse_practitioner: 2 });
    for (let i = 0; i < TICKS_PER_DAY / 2; i++) {
      tick(state);
      for (const j of Object.values(state.jobs)) {
        if (j.kind === "triage") expect(j.staffId).toBeNull();
      }
    }
  });
});
