/**
 * The Medical Examiner as a consultant's duty (ROADMAP M4 step 2,
 * GAME_DESIGN §5.6): reviews in weekday office-hours sessions, never of a
 * patient the consultant treated.
 */
import { describe, expect, it } from "vitest";
import type { Patient, Staff } from "@sim/agents";
import { reserve, restPoint, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { PlacedObject, SimState } from "@sim/state";
import { spawnPatient } from "@sim/systems/arrivals";
import { deathStepStatus, die, inMeSession, nextMeSession } from "@sim/systems/deaths";
import { applyStaffCommand } from "@sim/systems/staffing";
import { clockFromTick, tickAt, TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { staffedDeathsWard } from "../fixtures/deathsWard";

const MIN = TICKS_PER_MINUTE;
const HOUR = 60 * MIN;

function runUntil(state: SimState, done: () => boolean, limit = 8 * HOUR): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

function wardBed(state: SimState): PlacedObject {
  return Object.values(state.objects).find(
    (o) => o.defId === "hospital_bed" && roomOfObject(state, o.id)?.typeId === "ward",
  )!;
}

/** An inpatient in a ward bed who dies at once (verified by the crash team). */
function deathOnWard(state: SimState): Patient {
  const bed = wardBed(state);
  const p = spawnPatient(state, siteEntrance(state)!, "sepsis");
  p.deterioration = null;
  reserve(state, bed.id, 0, p.id);
  p.bed = bed.id;
  p.stage = "on_ward";
  const at = restPoint(bed);
  p.x = p.prevX = at.x;
  p.y = p.prevY = at.y;
  p.category = 2;
  p.times.triaged = p.times.decided = p.times.admitted = state.tick;
  die(state, p, false, true);
  return p;
}

/** The deaths ward, with the clock moved to `day` at `hour` before the staff arrive. */
function wardAt(day: number, hour: number, medicalExaminer = true): SimState {
  const state = staffedDeathsWard(1, undefined, { medicalExaminer });
  state.tick = tickAt(day, hour);
  for (let i = 0; i < 20 * MIN; i++) tick(state);
  return state;
}

const examiner = (state: SimState): Staff => Object.values(state.staff).find((s) => s.meDuty)!;

describe("Medical Examiner sessions", () => {
  it("are weekday office hours", () => {
    expect(inMeSession(tickAt(1, 9))).toBe(true); // Monday
    expect(inMeSession(tickAt(1, 17))).toBe(false);
    expect(inMeSession(tickAt(1, 8, 59))).toBe(false);
    expect(inMeSession(tickAt(6, 12))).toBe(false); // Saturday
    expect(nextMeSession(tickAt(6, 12))).toBe(tickAt(8, 9)); // Monday
    expect(nextMeSession(tickAt(2, 20))).toBe(tickAt(3, 9));
  });

  it("leave a weekend death waiting until Monday morning", () => {
    const state = wardAt(6, 10); // Saturday
    const p = deathOnWard(state);
    runUntil(state, () => p.stage === "in_mortuary");
    expect(deathStepStatus(state, p, "me_review").reason).toMatch(/Next: Mon 09:00/);
    runUntil(state, () => p.death!.meReviewed !== null, 72 * HOUR);
    const c = clockFromTick(p.death!.meReviewed!);
    expect(c.weekday).toBe(0);
    expect(c.hour).toBe(9);
  });
});

describe("independence", () => {
  it("a consultant who treated the patient can't review their death; another can", () => {
    const state = wardAt(1, 9);
    const me = examiner(state);
    const p = deathOnWard(state);
    p.consultants.push(me.id);
    runUntil(state, () => p.stage === "in_mortuary");
    for (let i = 0; i < HOUR; i++) tick(state);
    expect(p.death!.meReviewed).toBeNull();
    expect(deathStepStatus(state, p, "me_review").reason).toMatch(/only Medical Examiner treated/);

    const other = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: "cardiology",
    });
    if (!other.ok) throw new Error(other.error);
    applyStaffCommand(state, { type: "set_me_duty", id: other.staff.id, on: true });
    const reviewers = new Set<number>();
    runUntil(
      state,
      () => {
        const job = Object.values(state.jobs).find(
          (j) => j.kind === "me_review" && j.patientId === p.id,
        );
        if (job?.staffId != null) reviewers.add(job.staffId);
        return p.death!.meReviewed !== null;
      },
      2 * HOUR,
    );
    expect([...reviewers]).toEqual([other.staff.id]);
  });
});

describe("the duty", () => {
  it("is only for resident consultants", () => {
    const state = wardAt(1, 9, false);
    const reg = applyStaffCommand(state, {
      type: "hire_staff",
      role: "registrar",
      specialty: "general_medicine",
    });
    const onCall = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: "general_medicine",
      onCall: true,
    });
    if (!reg.ok || !onCall.ok) throw new Error("hire failed");
    for (const s of [reg.staff, onCall.staff]) {
      expect(applyStaffCommand(state, { type: "set_me_duty", id: s.id, on: true }).ok).toBe(false);
    }
  });
});
