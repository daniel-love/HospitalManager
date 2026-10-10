/**
 * Theatres and elective surgery (M4 step 7).
 */
import { describe, expect, it } from "vitest";
import { decodeSave, encodeSave } from "@save/codec";
import { applyStaffCommand } from "@sim/systems/staffing";
import { jobPlan } from "@sim/systems/clinics";
import { roomAt, setEmergencyTheatre } from "@sim/world/rooms";
import { buildTheatres, THEATRE_A, THEATRE_B } from "../fixtures/theatres";

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
