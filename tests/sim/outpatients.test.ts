/**
 * Outpatients (M4 step 6, ROADMAP "done when"): GP referrals start when the
 * hospital runs a specialty's clinics and stop when it doesn't; booked
 * patients come in, book in, wait and are seen in clinic sessions; missed
 * appointments are rebooked; clinics that can't run are cancelled.
 */
import { describe, expect, it } from "vitest";
import { describeAdvice } from "@game/advice";
import { decodeSave, encodeSave } from "@save/codec";
import { applyCommand } from "@sim/commands";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { DNA_CHANCE, inClinic } from "@sim/systems/outpatients";
import { bookAppointments, offersClinic, refer, waitingLists } from "@sim/systems/referrals";
import { applyStaffCommand } from "@sim/systems/staffing";
import { clockFromTick, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "@sim/time";
import { roomAt } from "@sim/world/rooms";
import { buildOutpatients, CLINIC_A, CLINIC_B } from "../fixtures/outpatients";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;

function runDays(state: SimState, days: number, each?: () => void): void {
  for (let i = 0; i < days * TICKS_PER_DAY; i++) {
    tick(state);
    each?.();
    if (i % 100 === 0) expect(invariantProblems(state)).toEqual([]);
  }
}

const consultant = (state: SimState) =>
  Object.values(state.staff).find((s) => s.role === "consultant")!;

describe("GP referrals", () => {
  it("start once the hospital runs a specialty's clinics, and stop when it doesn't", () => {
    const state = buildOutpatients(1);
    expect(offersClinic(state, "cardiology")).toBe(true);
    expect(offersClinic(state, "dermatology")).toBe(false);
    runDays(state, 1);
    const first = state.history[0]!.stats.gpReferrals;
    expect(first).toBeGreaterThan(0);
    expect(Object.values(state.referrals).every((r) => r.specialty === "cardiology")).toBe(true);

    // No clinic sessions: no referrals.
    applyStaffCommand(state, {
      type: "set_clinic_sessions",
      id: consultant(state).id,
      sessions: 0,
    });
    expect(offersClinic(state, "cardiology")).toBe(false);
    runDays(state, 1);
    expect(state.history.at(-1)!.stats.gpReferrals).toBe(0);
  });

  it("need a clinic room the specialty can use", () => {
    const state = buildOutpatients(1);
    for (const at of [CLINIC_A, CLINIC_B]) {
      const room = roomAt(state, 0, at.x, at.y)!;
      const desk = room.objectIds.find((id) => state.objects[id]!.defId === "desk")!;
      expect(applyCommand(state, { type: "remove_object", floor: 0, id: desk }).ok).toBe(true);
    }
    expect(offersClinic(state, "cardiology")).toBe(false);
  });

  it("book urgent referrals first, then the longest waits", () => {
    const state = buildOutpatients(1);
    state.settings.patientVolume = 0;
    const routine = Array.from({ length: 12 }, () => refer(state, "cardiology"));
    const urgent = refer(state, "cardiology", true);
    bookAppointments(state);
    const at = (r: { booking: { at: number } | null }) => r.booking!.at;
    expect(routine.every((r) => at(urgent) < at(r))).toBe(true);
    expect(at(routine[0]!)).toBeLessThan(at(routine[11]!));
    // Nothing is booked for the day of referral.
    expect(clockFromTick(at(urgent)).day).toBeGreaterThan(1);
  });

  it("a new consultant or registrar starts with a typical number of clinic sessions", () => {
    const state = buildOutpatients(1, []);
    const hire = (role: "consultant" | "registrar") => {
      const r = applyStaffCommand(state, { type: "hire_staff", role, specialty: "dermatology" });
      if (!r.ok) throw new Error(r.error);
      return r.staff.clinicSessions;
    };
    expect(hire("consultant")).toBe(3);
    expect(hire("registrar")).toBe(2);
  });

  it("a specialty's clinics inherit a small waiting list when they first open", () => {
    const state = buildOutpatients(1);
    // Weeks into the game, so inherited referrals can have waited a while.
    state.tick = tickAt(60, 7);
    while (!state.inheritedLists.includes("cardiology")) tick(state);
    const list = Object.values(state.referrals);
    // About a week of cardiology's referrals (2.1 a day at 80,000 people).
    expect(list.length).toBeGreaterThanOrEqual(13);
    expect(list.length).toBeLessThanOrEqual(17);
    const waits = list.map((r) => (state.tick - r.clockStart!) / TICKS_PER_DAY);
    expect(Math.max(...waits)).toBeLessThanOrEqual(42);
    expect(Math.max(...waits)).toBeGreaterThan(7);
    // Not counted as today's GP referrals, and only inherited once.
    expect(state.today.stats.gpReferrals).toBeLessThanOrEqual(1);
    const n = list.length;
    runDays(state, 1);
    expect(Object.keys(state.referrals).length).toBeLessThan(n + 8);
  });
});

describe("a clinic day", () => {
  it("sees booked patients in the clinician's session, for the tariff", () => {
    const state = buildOutpatients(1);
    const s = consultant(state);
    let jobsInClinic = 0;
    const seenAt: number[] = [];
    const before = new Set<number>();
    runDays(state, 5, () => {
      if (inClinic(state, s) && s.jobId !== null) jobsInClinic++;
      for (const o of Object.values(state.outpatients)) {
        if (o.stage === "in_clinic" && !before.has(o.id)) {
          before.add(o.id);
          seenAt.push(state.tick);
        }
      }
    });
    const stats = state.history.reduce(
      (a, d) => ({
        first: a.first + d.stats.firstAppointments,
        income: a.income + d.ledger.outpatients,
      }),
      { first: 0, income: 0 },
    );
    expect(stats.first).toBeGreaterThan(0);
    expect(stats.income).toBeGreaterThanOrEqual(stats.first * 210);
    expect(jobsInClinic).toBe(0);
    // Everyone was seen on a weekday, in clinic hours (with some overrun).
    for (const t of seenAt) {
      const c = clockFromTick(t);
      expect(c.weekday).toBeLessThan(5);
      expect(c.hour).toBeGreaterThanOrEqual(8);
      expect(c.hour).toBeLessThan(19);
    }
    expect(waitingLists(state)[0]!.followUps).toBeGreaterThan(0);
  });

  it("rebooks a missed appointment, and discharges a second", () => {
    const state = buildOutpatients(1);
    state.settings.patientVolume = 0;
    const saved = DNA_CHANCE.first;
    DNA_CHANCE.first = 1;
    try {
      const r = refer(state, "cardiology");
      bookAppointments(state);
      const firstBooking = r.booking!.at;
      for (let i = 0; i < 2 * TICKS_PER_DAY && r.booking?.at === firstBooking; i++) tick(state);
      expect(r.dnas).toBe(1);
      expect(state.referrals[r.id]).toBeDefined();
      runDays(state, 10);
      expect(state.referrals[r.id]).toBeUndefined();
    } finally {
      DNA_CHANCE.first = saved;
    }
  });

  it("cancels and rebooks when the clinician leaves on the day", () => {
    const state = buildOutpatients(1);
    state.settings.patientVolume = 0;
    const refs = Array.from({ length: 4 }, () => refer(state, "cardiology"));
    bookAppointments(state);
    const day = refs[0]!.booking!.day;
    // Run to an hour before the clinic, then dismiss the consultant.
    while (state.tick < refs[0]!.booking!.at - 60 * MIN) tick(state);
    applyStaffCommand(state, { type: "dismiss_staff", id: consultant(state).id });
    while (state.tick < tickAt(day, 18)) tick(state);
    expect(state.today.stats.clinicCancellations).toBeGreaterThan(0);
    expect(refs.every((r) => state.referrals[r.id] && r.booking === null)).toBe(true);
    expect(Object.keys(state.outpatients)).toHaveLength(0);
  });
});

describe("waiting lists", () => {
  it("count RTT clocks under and over 18 weeks", () => {
    const state = buildOutpatients(1);
    state.settings.patientVolume = 0;
    refer(state, "cardiology");
    const old = refer(state, "cardiology");
    old.clockStart = state.tick - 20 * 7 * TICKS_PER_DAY;
    const [list] = waitingLists(state);
    expect(list).toMatchObject({ pathways: 2, within18w: 1, longestWeeks: 20, open: true });
  });

  it("are kept in saves, with patients in mid-clinic", () => {
    const state = buildOutpatients(1);
    state.settings.patientVolume = 3;
    for (let i = 0; i < 2 * TICKS_PER_DAY; i++) {
      tick(state);
      if (Object.values(state.outpatients).some((o) => o.stage === "waiting")) break;
    }
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "op")))).state;
    expect(Object.keys(loaded.outpatients).length).toBeGreaterThan(0);
    expect(Object.keys(loaded.referrals)).toEqual(Object.keys(state.referrals));
    runDays(loaded, 1);
  });
});

describe("advice and alerts", () => {
  it("the Help panel checks the outpatients setup and sizes clinics to demand", () => {
    const state = buildOutpatients(1);
    runDays(state, 0.01); // The receptionist takes the desk.
    const advice = describeAdvice(state);
    const group = advice.groups.find((g) => g.heading === "Outpatients")!;
    expect(group.items.every((i) => i.status === "ok")).toBe(true);
    const row = advice.capacity.find((r) => r.label === "Cardiology clinics a week")!;
    expect(row.have).toBe(4);
    expect(row.recommended).toBeGreaterThan(0);
  });

  it("warns when patients are on a list whose clinics have stopped", () => {
    const state = buildOutpatients(1);
    refer(state, "cardiology");
    applyStaffCommand(state, {
      type: "set_clinic_sessions",
      id: consultant(state).id,
      sessions: 0,
    });
    runDays(state, 0.1);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(
      /on the Cardiology waiting list, but its clinics aren't running/,
    );
  });
});
