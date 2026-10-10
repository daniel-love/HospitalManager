/**
 * Outpatient clinics (M4 step 6): clinic rooms take a specialty like wards,
 * and resident consultants and registrars have clinic sessions in their
 * job plan, spread across the week.
 */
import { describe, expect, it } from "vitest";
import { decodeSave, encodeSave } from "@save/codec";
import { applyStaffCommand } from "@sim/systems/staffing";
import { jobPlan, describeJobPlan } from "@sim/systems/clinics";
import { createSimState } from "@sim/state";
import type { Staff } from "@sim/agents";
import type { SpecialtyId, StaffRoleId } from "@data/schema";

function hire(
  state: ReturnType<typeof createSimState>,
  role: StaffRoleId,
  specialty?: SpecialtyId,
  onCall = false,
): Staff {
  const r = applyStaffCommand(state, {
    type: "hire_staff",
    role,
    onCall,
    ...(specialty ? { specialty } : {}),
  });
  if (!r.ok) throw new Error(r.error);
  return r.staff;
}

function setSessions(state: ReturnType<typeof createSimState>, s: Staff, sessions: number) {
  return applyStaffCommand(state, { type: "set_clinic_sessions", id: s.id, sessions });
}

describe("clinic sessions in a job plan", () => {
  it("only for resident consultants and registrars of a specialty with clinics", () => {
    const state = createSimState({ seed: 1 });
    expect(setSessions(state, hire(state, "consultant", "cardiology"), 2).ok).toBe(true);
    expect(setSessions(state, hire(state, "registrar", "dermatology"), 2).ok).toBe(true);
    expect(setSessions(state, hire(state, "consultant", "cardiology", true), 2).ok).toBe(false);
    expect(setSessions(state, hire(state, "consultant", "anaesthetics"), 2).ok).toBe(false);
    expect(setSessions(state, hire(state, "junior_doctor"), 2).ok).toBe(false);
  });

  it("keeps the number of sessions between none and six", () => {
    const state = createSimState({ seed: 1 });
    const s = hire(state, "consultant", "ent");
    setSessions(state, s, 9);
    expect(s.clinicSessions).toBe(6);
    setSessions(state, s, -1);
    expect(s.clinicSessions).toBe(0);
    expect(jobPlan(state, s)).toEqual([]);
  });

  it("spreads a team's clinics across the week without clashing", () => {
    const state = createSimState({ seed: 1 });
    const a = hire(state, "consultant", "ophthalmology");
    const b = hire(state, "consultant", "ophthalmology");
    setSessions(state, a, 3);
    setSessions(state, b, 3);
    const key = (x: { weekday: number; half: string }) => `${x.weekday}${x.half}`;
    const planA = jobPlan(state, a).map(key);
    const planB = jobPlan(state, b).map(key);
    expect(new Set([...planA, ...planB]).size).toBe(6);
    expect(describeJobPlan(jobPlan(state, a))).toBe("Mon morning, Tue afternoon, Wed morning");
  });

  it("is kept in saves", () => {
    const state = createSimState({ seed: 1 });
    const s = hire(state, "consultant", "dermatology");
    setSessions(state, s, 4);
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "plan")))).state;
    expect(loaded.staff[s.id]!.clinicSessions).toBe(4);
  });
});
