/**
 * Theatres and elective surgery (M4 step 7).
 */
import { PHS_FUNDING } from "@data/economy";
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Patient, Referral } from "@sim/agents";
import { holder, reserve, restPoint } from "@sim/places";
import { decideToAdmit } from "@sim/systems/admissions";
import { inAE } from "@sim/systems/patients";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { newPatient } from "@sim/systems/arrivals";
import { bookAppointments, refer } from "@sim/systems/referrals";
import { inTheatre } from "@sim/systems/theatres";
import { clockFromTick, TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";
import { invariantProblems } from "./simHelpers";
import { describeAdvice } from "@game/advice";
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
        income = state.today.ledger.elective;
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
    expect(state.today.ledger.elective + income).toBeGreaterThanOrEqual(1500);
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

/** An admitted patient on a ward bed (or, `ae`, on a Recovery trolley standing in for A&E's) who needs an operation. */
function needsOperation(state: SimState, dueHours: number, ae = false): Patient {
  const room = state.rooms.find((r) => r.typeId === (ae ? "recovery" : "ward"))!;
  const bed = room.objectIds
    .map((id) => state.objects[id]!)
    .find((o) => o.defId === (ae ? "trolley" : "hospital_bed") && !holder(state, o.id, 0))!;
  const p = newPatient(
    state,
    restPoint(bed),
    conditionById.get("elderly_fall")!,
    ae ? "awaiting_bed" : "on_ward",
  );
  p.bed = bed.id;
  reserve(state, bed.id, 0, p.id);
  p.specialty = "general_medicine";
  p.category = 3;
  p.times.decided = state.tick;
  if (!ae) {
    p.times.admitted = state.tick;
    p.stayUntil = state.tick + 5 * TICKS_PER_DAY;
  }
  p.emergencyOp = {
    specialty: "trauma_orthopaedics",
    due: state.tick + dueHours * 60 * TICKS_PER_MINUTE,
    from: null,
    done: false,
  };
  state.patients[p.id] = p;
  return p;
}

describe("emergency surgery", () => {
  it("uses a theatre kept for emergencies straight away, then back to a ward", () => {
    const state = quiet();
    setEmergencyTheatre(state, roomAt(state, 0, THEATRE_B.x, THEATRE_B.y)!, true);
    const p = needsOperation(state, 36);
    runUntil(state, () => p.emergencyOp!.done, 1);
    expect(state.today.stats.emergencyOps).toBe(1);
    expect(state.today.stats.emergencyOnTime).toBe(1);
    // An emergency operation is paid at the marginal rate, on top of the block contract.
    expect(state.today.ledger.tariff).toBeCloseTo(6000 * (1 - PHS_FUNDING.blockShare));
    runUntil(state, () => p.stage === "on_ward", 1);
    // Back from theatre: not a new admission.
    expect(state.today.stats.admissions).toBe(0);
  });

  it("takes the next slot on a running list of its specialty, cancelling a planned patient", () => {
    const state = quiet();
    listed(state, 2, 0);
    const first = Object.values(state.referrals)
      .map((r) => r.booking!)
      .sort((a, b) => a.at - b.at)[0]!;
    // The morning of the list, before it starts.
    while (state.tick < first.at - 70 * TICKS_PER_MINUTE) tick(state);
    const p = needsOperation(state, 36);
    runUntil(state, () => p.emergencyOp!.done, 1);
    expect(state.today.stats.bumped).toBe(1);
    expect(state.today.stats.cancelledOnDay).toBeGreaterThanOrEqual(1);
  });

  it("is done in any free theatre out of hours once it's nearly due", () => {
    const state = quiet();
    // Overnight, with no list running.
    while (clockFromTick(state.tick).hour !== 22) tick(state);
    const later = needsOperation(state, 30);
    const soon = needsOperation(state, 4);
    runUntil(state, () => soon.emergencyOp!.done, 1);
    expect(later.emergencyOp!.done).toBe(false);
  });

  it("counts an A&E patient as leaving A&E when they go to theatre", () => {
    const state = quiet();
    setEmergencyTheatre(state, roomAt(state, 0, THEATRE_B.x, THEATRE_B.y)!, true);
    const p = needsOperation(state, 24, true);
    runUntil(state, () => p.stage === "to_theatre", 1);
    expect(state.today.stats.departures).toBe(1);
    expect(inAE(p)).toBe(false);
    runUntil(state, () => p.stage === "on_ward", 1);
    expect(state.today.stats.departures).toBe(1);
    expect(state.today.stats.admissions).toBe(1);
  });

  it("means a transfer out when the hospital can't operate", () => {
    const state = quiet();
    const anaesthetist = Object.values(state.staff).find((s) => s.specialty === "anaesthetics")!;
    applyStaffCommand(state, { type: "dismiss_staff", id: anaesthetist.id });
    const op = conditionById.get("broken_ankle")!.admission!.operation!;
    const chanceWas = op.chance;
    op.chance = 1;
    try {
      const p = newPatient(
        state,
        { x: 13, y: 20 },
        conditionById.get("broken_ankle")!,
        "in_cubicle",
      );
      p.specialty = "trauma_orthopaedics";
      state.patients[p.id] = p;
      decideToAdmit(state, p);
      expect(p.transfer?.reason).toMatch(/no anaesthetist/);
      expect(p.emergencyOp).toBeNull();
    } finally {
      op.chance = chanceWas;
    }
  });
});

describe("advice and alerts for theatres", () => {
  it("the Help panel checks the theatre setup and sizes lists to demand", () => {
    const state = quiet();
    const group = describeAdvice(state).groups.find((g) => g.heading === "Theatres")!;
    const todo = group.items.filter((i) => i.status === "todo").map((i) => i.text);
    expect(todo).toEqual([]);
    const rows = describeAdvice(state).capacity.map((r) => r.label);
    expect(rows).toContain("Anaesthetist lists a week");
  });

  it("warns when emergency surgery is overdue", () => {
    const state = quiet();
    // No theatre practitioners: nothing can start.
    for (const s of Object.values(state.staff)) {
      if (s.role === "theatre_practitioner")
        applyStaffCommand(state, { type: "dismiss_staff", id: s.id });
    }
    needsOperation(state, 0.5);
    for (let i = 0; i < 2 * 60 * TICKS_PER_MINUTE; i++) tick(state);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/overdue for emergency surgery/);
  });
});
