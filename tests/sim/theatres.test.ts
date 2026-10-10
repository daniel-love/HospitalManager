/**
 * Theatres and elective surgery (M4 step 7).
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Referral } from "@sim/agents";
import { reserve } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { newPatient } from "@sim/systems/arrivals";
import { bookAppointments, refer } from "@sim/systems/referrals";
import { inTheatre } from "@sim/systems/theatres";
import { TICKS_PER_DAY } from "@sim/time";
import { invariantProblems } from "./simHelpers";
import { decodeSave, encodeSave } from "@save/codec";
import { applyStaffCommand } from "@sim/systems/staffing";
import { jobPlan } from "@sim/systems/clinics";
import { roomAt, setEmergencyTheatre } from "@sim/world/rooms";
import { buildTheatres, THEATRE_A, THEATRE_B, THEATRE_TEAM } from "../fixtures/theatres";

describe("the surgical block", () => {
  it("has working theatres, Recovery and a Day Surgery Unit", () => {
    const state = buildTheatres();
    const bad = state.rooms
      .filter((r) => !r.valid)
      .map((r) => `${r.typeId}: ${r.checks.filter((c) => !c.ok).map((c) => c.label)}`);
    expect(bad).toEqual([]);
    const types = state.rooms.map((r) => r.typeId).sort();
    expect(types).toEqual(
      ["corridor", "day_surgery_unit", "recovery", "theatre", "theatre", "ward"].sort(),
    );
    expect(roomAt(state, 0, THEATRE_A.x, THEATRE_A.y)!.capabilities).toContain("surgery");
  });
});

describe("theatre lists in a job plan", () => {
  it("for resident surgeons and anaesthetists only, after their clinics", () => {
    const state = buildTheatres(1, []);
    const hire = (specialty: "dermatology" | "general_medicine" | "anaesthetics") => {
      const r = applyStaffCommand(state, { type: "hire_staff", role: "consultant", specialty });
      if (!r.ok) throw new Error(r.error);
      return r.staff;
    };
    const derm = hire("dermatology");
    const set = (id: number, type: "set_theatre_sessions" | "set_clinic_sessions", n: number) =>
      applyStaffCommand(state, { type, id, sessions: n });
    expect(set(derm.id, "set_clinic_sessions", 6).ok).toBe(true);
    expect(set(derm.id, "set_theatre_sessions", 4).ok).toBe(true);
    // Eight fixed sessions at most: six clinics leave room for two lists.
    expect(derm.theatreSessions).toBe(2);
    const plan = jobPlan(state, derm);
    expect(plan.filter((p) => p.kind === "clinic")).toHaveLength(6);
    expect(plan.filter((p) => p.kind === "theatre")).toHaveLength(2);
    expect(new Set(plan.map((p) => `${p.weekday}${p.half}`)).size).toBe(8);
    expect(set(hire("general_medicine").id, "set_theatre_sessions", 1).ok).toBe(false);
    const anaesthetist = hire("anaesthetics");
    expect(set(anaesthetist.id, "set_theatre_sessions", 3).ok).toBe(true);
    expect(jobPlan(state, anaesthetist)).toEqual([]); // Paired with surgeons' lists instead.
  });

  it("are kept in saves, with emergency theatres", () => {
    const state = buildTheatres();
    setEmergencyTheatre(state, roomAt(state, 0, THEATRE_B.x, THEATRE_B.y)!, true);
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "t")))).state;
    expect(roomAt(loaded, 0, THEATRE_B.x, THEATRE_B.y)!.emergency).toBe(true);
    expect(roomAt(loaded, 0, THEATRE_A.x, THEATRE_A.y)!.emergency).toBe(false);
    const surgeon = Object.values(loaded.staff).find((s) => s.specialty === "trauma_orthopaedics")!;
    expect(surgeon.theatreSessions).toBe(2);
  });
});

/** Patients on the T&O surgical list: day cases, then inpatients. */
function listed(state: SimState, dayCases: number, inpatients: number): Referral[] {
  const out: Referral[] = [];
  for (let i = 0; i < dayCases + inpatients; i++) {
    const r = refer(state, "trauma_orthopaedics");
    r.kind = "surgery";
    r.dayCase = i < dayCases;
    out.push(r);
  }
  bookAppointments(state);
  return out;
}

function quiet(...args: Parameters<typeof buildTheatres>): SimState {
  const state = buildTheatres(...args);
  state.settings.patientVolume = 0;
  return state;
}

function runUntil(state: SimState, done: () => boolean, days = 7, each?: () => void): void {
  for (let i = 0; i < days * TICKS_PER_DAY; i++) {
    if (done()) return;
    tick(state);
    each?.();
    if (i % 100 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  throw new Error("timed out");
}

describe("a planned theatre list", () => {
  it("operates on day cases (home the same day) and inpatients (to a ward)", () => {
    const state = quiet();
    const [day, inpatient] = listed(state, 1, 1);
    expect(day!.booking && inpatient!.booking).toBeTruthy();
    const surgeon = Object.values(state.staff).find((s) => s.specialty === "trauma_orthopaedics")!;
    let jobsOnList = 0;
    let income = 0;
    runUntil(
      state,
      () => {
        const ward = Object.values(state.patients).find((p) => p.stage === "on_ward");
        return !!ward && !state.referrals[day!.id];
      },
      7,
      () => {
        if (inTheatre(state, surgeon) && surgeon.jobId !== null) jobsOnList++;
        income = state.today.ledger.tariff;
      },
    );
    expect(jobsOnList).toBe(0);
    // Both operations done: off the waiting list, RTT clocks stopped.
    expect(state.referrals[day!.id]).toBeUndefined();
    expect(state.referrals[inpatient!.id]).toBeUndefined();
    const stats = state.today.stats;
    expect(stats.electiveOps).toBe(2);
    expect(stats.dayCases).toBe(1);
    // The day case has gone home with the day-case tariff; the inpatient is on the ward.
    runUntil(state, () => !Object.values(state.patients).some((p) => p.stage === "post_op"), 1);
    expect(state.today.ledger.tariff + income).toBeGreaterThanOrEqual(1500);
    const inpatientNow = Object.values(state.patients).find((p) => p.stage === "on_ward")!;
    expect(inpatientNow.elective?.dayCase).toBe(false);
    expect(state.today.stats.departures).toBe(0); // Never counted as A&E.
  });

  it("cancels an inpatient on the day with no ward bed, to be rebooked within 28 days", () => {
    const state = quiet();
    // Every ward bed is taken.
    const ward = state.rooms.find((r) => r.typeId === "ward")!;
    for (const id of ward.objectIds) {
      if (state.objects[id]!.defId === "hospital_bed") reserve(state, id, 0, 999_999);
    }
    state.patients[999_999] = {
      ...newPatient(state, { x: 2, y: 2 }, conditionById.get("chest_pain")!, "on_ward"),
      id: 999_999,
    };
    const [r] = listed(state, 0, 1);
    runUntil(state, () => state.today.stats.cancelledOnDay > 0);
    expect(r!.rebookBy).not.toBeNull();
    expect(r!.rebookBy! - state.tick).toBeLessThanOrEqual(28 * TICKS_PER_DAY);
    expect(state.referrals[r!.id]).toBeDefined();
  });

  it("doesn't book lists that have no anaesthetist", () => {
    const state = quiet(1, [{ specialty: "trauma_orthopaedics", lists: 2 }]);
    const anaesthetist = Object.values(state.staff).find((s) => s.specialty === "anaesthetics")!;
    applyStaffCommand(state, { type: "dismiss_staff", id: anaesthetist.id });
    const [r] = listed(state, 1, 0);
    expect(r!.booking).toBeNull();
  });

  it("can't start without two theatre practitioners, and cancels when the list runs out of time", () => {
    const state = quiet(1, undefined, { ...THEATRE_TEAM, theatre_practitioner: 1 });
    listed(state, 2, 0);
    runUntil(state, () => state.today.stats.cancelledOnDay > 0);
    expect(state.today.stats.electiveOps).toBe(0);
  });

  it("survives a save mid-operation", () => {
    const state = quiet();
    listed(state, 1, 0);
    runUntil(state, () => Object.values(state.operations).some((o) => o.phase === "operating"));
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "op")))).state;
    expect(Object.values(loaded.operations)).toHaveLength(1);
    runUntil(loaded, () => loaded.today.stats.electiveOps > 0, 1);
  });
});
