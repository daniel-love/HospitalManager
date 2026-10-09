/**
 * Consultants, registrars, specialty referrals, on-call callouts and ward
 * specialties (ROADMAP M4 step 1).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import { ON_CALL } from "@data/staff";
import type { SpecialtyId } from "@data/schema";
import type { Patient, Staff } from "@sim/agents";
import { siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { finishPathway } from "@sim/systems/admissions";
import { spawnPatient } from "@sim/systems/arrivals";
import { hourlySalaries } from "@sim/systems/finance";
import { removeJob } from "@sim/systems/jobBoard";
import { postTreatment } from "@sim/systems/patients";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_MINUTE } from "@sim/time";
import { detectRooms, setWardSpecialty } from "@sim/world/rooms";
import { waitReason } from "@game/describe";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";

const MIN = TICKS_PER_MINUTE;

function runUntil(state: SimState, done: () => boolean, limit = 240 * MIN): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

function quiet(): SimState {
  const state = staffedMajorsAE(1, { ...MAJORS_TEAM, porter: 1 }, { ward: "door_double" });
  state.settings.patientVolume = 0;
  return state;
}

function hire(
  state: SimState,
  role: "consultant" | "registrar",
  specialty: SpecialtyId,
  onCall = false,
): Staff {
  const r = applyStaffCommand(state, { type: "hire_staff", role, specialty, onCall });
  if (!r.ok) throw new Error(r.error);
  return r.staff;
}

/** A chest pain patient on a Majors trolley who has finished their A&E steps and needs admitting. */
function needsAdmitting(state: SimState): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
  p.deterioration = null;
  runUntil(state, () => p.stage === "in_cubicle" && p.path.length === 0);
  for (const j of Object.values(state.jobs)) if (j.patientId === p.id) removeJob(state, j);
  p.step = conditionById.get("chest_pain")!.pathway.length;
  finishPathway(state, p, state.objects[p.bed!]!);
  return p;
}

const referral = (state: SimState, p: Patient) =>
  Object.values(state.jobs).find((j) => j.patientId === p.id && j.kind === "referral");

// Every chest pain patient who finishes A&E here needs admitting.
const admission = conditionById.get("chest_pain")!.admission!;
let chance = 0;
beforeEach(() => {
  chance = admission.chance;
  admission.chance = 1;
});
afterEach(() => {
  admission.chance = chance;
});

describe("hiring specialists", () => {
  it("needs a specialty, and only consultants can be on call", () => {
    const state = quiet();
    expect(applyStaffCommand(state, { type: "hire_staff", role: "registrar" }).ok).toBe(false);
    expect(
      applyStaffCommand(state, {
        type: "hire_staff",
        role: "registrar",
        specialty: "cardiology",
        onCall: true,
      }).ok,
    ).toBe(false);
    const c = hire(state, "consultant", "cardiology", true);
    expect(c.specialty).toBe("cardiology");
    expect(c.onCall?.state).toBe("home");
  });
});

describe("specialty referrals", () => {
  it("refers an admission to the specialty's registrar, who reviews them on their trolley", () => {
    const state = quiet();
    const reg = hire(state, "registrar", "cardiology");
    const p = needsAdmitting(state);
    expect(p.specialty).toBe("cardiology");
    expect(p.times.referred).toBe(state.tick);
    expect(p.stage).toBe("in_cubicle");
    const job = referral(state, p)!;
    expect(job.specialty).toBe("cardiology");
    tick(state);
    expect(job.staffId).toBe(reg.id);
    expect(waitReason(state, p)).toContain("on the way");

    runUntil(state, () => p.stage !== "in_cubicle");
    expect(p.stage).toBe("awaiting_bed");
    expect(p.times.decided).not.toBeNull();
    expect(state.today.stats.referrals).toBe(1);
    expect(state.today.stats.referralMins).toBeGreaterThanOrEqual(20);
  });

  it("isn't reviewed by another specialty's team, or by A&E's junior doctors", () => {
    const state = quiet();
    hire(state, "registrar", "general_surgery");
    hire(state, "registrar", "cardiology");
    const busy = Object.values(state.staff).find((s) => s.specialty === "cardiology")!;
    // Keep the cardiology registrar out of the way.
    dismiss(state, busy);
    hire(state, "consultant", "cardiology", true);
    const p = needsAdmitting(state);
    for (let i = 0; i < 10 * MIN; i++) tick(state);
    expect(referral(state, p)!.staffId).toBeNull();
    expect(waitReason(state, p)).toMatch(/on-call Cardiology consultant, is \d+ min/);
  });

  it("without a team, can't be admitted here: they're transferred out", () => {
    const state = quiet();
    hire(state, "registrar", "general_medicine"); // Another specialty's team doesn't help.
    const p = needsAdmitting(state);
    expect(referral(state, p)).toBeUndefined();
    expect(p.specialty).toBe("cardiology");
    expect(p.transfer?.reason).toMatch(/no Cardiology consultant or registrar/);
  });

  it("sends a referral step to the specialty's team when there is one", () => {
    const state = quiet();
    const p = spawnPatient(state, siteEntrance(state)!, "septic_shock");
    const step = conditionById.get("septic_shock")!.pathway.findIndex((s) => s.specialty);
    p.category = 1;
    p.step = step;
    postTreatment(state, p, null);
    expect(Object.values(state.jobs).at(-1)!.roles).toEqual(["junior_doctor"]);
    hire(state, "registrar", "anaesthetics");
    postTreatment(state, p, null);
    const job = Object.values(state.jobs).at(-1)!;
    expect(job.roles).toEqual(["registrar", "consultant"]);
    expect(job.specialty).toBe("anaesthetics");
  });
});

function dismiss(state: SimState, s: Staff): void {
  applyStaffCommand(state, { type: "dismiss_staff", id: s.id });
}

describe("on-call consultants", () => {
  it("are called in when nobody from the specialty is in, review, then go home", () => {
    const state = quiet();
    const c = hire(state, "consultant", "cardiology", true);
    const idle = hourlySalaries(state);
    const p = needsAdmitting(state);
    runUntil(state, () => c.onCall!.state === "called", 2 * MIN);
    const arrives = c.onCall!.at;
    expect(arrives - state.tick).toBeGreaterThanOrEqual(ON_CALL.calloutMins[0] * MIN - MIN);
    expect(arrives - state.tick).toBeLessThanOrEqual(ON_CALL.calloutMins[1] * MIN);

    runUntil(state, () => c.onCall!.state === "in");
    expect(state.tick).toBe(arrives);
    expect(hourlySalaries(state)).toBeCloseTo(idle + ON_CALL.hourly);
    runUntil(state, () => p.stage === "awaiting_bed");
    // Having treated them, they couldn't be this patient's Medical Examiner.
    expect(p.consultants).toEqual([c.id]);

    // Nothing more to do: home after an hour, off the map.
    runUntil(state, () => c.onCall!.state === "home", (ON_CALL.homeAfterIdleMins + 60) * MIN);
    expect(hourlySalaries(state)).toBeCloseTo(idle);
  });

  it("stay at home while a resident colleague can take the referral", () => {
    const state = quiet();
    hire(state, "registrar", "cardiology");
    const c = hire(state, "consultant", "cardiology", true);
    const p = needsAdmitting(state);
    runUntil(state, () => p.stage === "awaiting_bed");
    expect(c.onCall!.state).toBe("home");
  });
});

describe("ward specialties", () => {
  it("survive the ward being re-detected, and count outliers on another specialty's ward", () => {
    const state = quiet();
    hire(state, "registrar", "cardiology");
    const ward = state.rooms.find((r) => r.typeId === "ward")!;
    setWardSpecialty(state, ward, "general_surgery");
    // Every layout change re-detects rooms (new ids); the setting is found again.
    detectRooms(state);
    const again = state.rooms.find((r) => r.typeId === "ward")!;
    expect(again.specialty).toBe("general_surgery");

    const p = needsAdmitting(state);
    runUntil(state, () => p.stage === "on_ward", 480 * MIN);
    expect(state.today.stats.outliers).toBe(1);
  });

  it("aren't outliers on their own specialty's ward or one open to any", () => {
    for (const sp of ["cardiology", null] as const) {
      const state = quiet();
      hire(state, "registrar", "cardiology");
      setWardSpecialty(
        state,
        state.rooms.find((r) => r.typeId === "ward")!,
        sp,
      );
      const p = needsAdmitting(state);
      runUntil(state, () => p.stage === "on_ward", 480 * MIN);
      expect(state.today.stats.outliers).toBe(0);
    }
  });
});
