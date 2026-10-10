/**
 * Shifts and rotas (ROADMAP M5 step 1): cover levels, the weekly rota,
 * staff coming and going at shift changes, consultants' weekdays and
 * out-of-hours on-call turns, and unsocial hours pay.
 */
import { describe, expect, it } from "vitest";
import { SHIFTS } from "@data/staff";
import type { StaffRoleId } from "@data/schema";
import { onDuty, onSite, type Staff } from "@sim/agents";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { hourlySalaries, unsocialRate } from "@sim/systems/finance";
import {
  consultantOnCall,
  describeRota,
  rota,
  rotaSummary,
  setCover,
  shiftsAt,
  SLOTS,
} from "@sim/systems/rota";
import { applyStaffCommand } from "@sim/systems/staffing";
import { tickAt, TICKS_PER_MINUTE } from "@sim/time";
import { migrate } from "@save/migrations";
import { buildSmallAE } from "../fixtures/smallAE";

const MIN = TICKS_PER_MINUTE;

function withRotas(): SimState {
  const state = buildSmallAE(1);
  state.settings.rotas = true;
  state.settings.patientVolume = 0;
  return state;
}

function hire(state: SimState, role: StaffRoleId, extra: object = {}): Staff {
  const r = applyStaffCommand(state, { type: "hire_staff", role, ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.staff;
}

function runTo(state: SimState, t: number): void {
  while (state.tick < t) tick(state);
}

const shiftsOf = (mask: number) => [...Array(SLOTS).keys()].filter((s) => mask & (1 << s));

describe("the weekly rota", () => {
  it("meets cover with five people per post, three shifts each, never back to back", () => {
    const state = withRotas();
    setCover(state, "nurse:band5", { day: 1, night: 1 });
    const nurses = Array.from({ length: 5 }, () => hire(state, "nurse"));
    const plan = rota(state);
    const [g] = rotaSummary(state);
    expect(g!.gaps).toBe(0);
    for (const n of nurses) {
      const slots = shiftsOf(plan.get(n.id)!);
      expect(slots.length).toBe(SHIFTS.perWeek);
      for (const a of slots) {
        // No day and night on the same date, nor a day straight after a night.
        expect(slots).not.toContain(a % 2 === 0 ? a + 1 : (a + 1) % SLOTS);
      }
    }
  });

  it("shows gaps when there aren't enough people", () => {
    const state = withRotas();
    setCover(state, "nurse:band5", { day: 2, night: 2 });
    hire(state, "nurse");
    hire(state, "nurse");
    const [g] = rotaSummary(state);
    // 28 shifts wanted, 6 worked.
    expect(g!.gaps).toBe(22);
  });

  it("shares shifts 60:40 between days and nights with no cover set", () => {
    const state = withRotas();
    for (let i = 0; i < 10; i++) hire(state, "porter");
    const [g] = rotaSummary(state);
    const days = g!.filled.filter((_, s) => s % 2 === 0).reduce((a, b) => a + b, 0);
    const nights = g!.filled.filter((_, s) => s % 2 === 1).reduce((a, b) => a + b, 0);
    expect(days + nights).toBe(30);
    expect(days).toBeGreaterThanOrEqual(17);
    expect(days).toBeLessThanOrEqual(19);
  });
});

describe("shift changes", () => {
  it("staff come in at the start of their shift and go home at the end", () => {
    const state = withRotas();
    setCover(state, "nurse:band5", { day: 1, night: 1 });
    const nurses = Array.from({ length: 5 }, () => hire(state, "nurse"));
    // The game starts at 08:00 on Monday: the Monday day shift is under way.
    expect(nurses.filter(onDuty).length).toBe(1);
    const dayNurse = nurses.find(onDuty)!;
    expect(describeRota(state, dayNurse)).toContain("Mon day");

    // Monday 19:30: the night nurse arrives; the day nurse is still there for handover.
    runTo(state, tickAt(1, 19, 31));
    expect(nurses.filter(onDuty).length).toBe(2);
    // 20:00: the day nurse leaves and walks out.
    runTo(state, tickAt(1, 21, 0));
    expect(onSite(dayNurse)).toBe(false);
    expect(nurses.filter(onDuty).length).toBe(1);
  });

  it("someone hired mid-shift starts at once if the rota puts them on it and it's short", () => {
    const state = withRotas();
    setCover(state, "nurse:band5", { day: 2, night: 2 });
    const a = hire(state, "nurse");
    expect(describeRota(state, a)).toContain("Mon day");
    expect(onDuty(a)).toBe(true);
    const b = hire(state, "nurse");
    expect(onDuty(b)).toBe(describeRota(state, b).includes("Mon day"));
  });

  it("off-duty staff take no jobs", () => {
    const state = withRotas();
    setCover(state, "nurse:band5", { day: 1, night: 0 });
    hire(state, "nurse");
    const off = Array.from({ length: 4 }, () => hire(state, "nurse")).filter((n) => !onSite(n));
    expect(off.length).toBeGreaterThan(0);
    for (let i = 0; i < 60 * MIN; i++) tick(state);
    for (const n of off) expect(n.jobId).toBeNull();
  });

  it("with rotas off everyone works around the clock", () => {
    const state = buildSmallAE(1);
    const n = hire(state, "nurse");
    runTo(state, tickAt(2, 3, 0));
    expect(onDuty(n)).toBe(true);
  });
});

describe("consultants", () => {
  it("work weekdays and take turns on call from home out of hours", () => {
    const state = withRotas();
    const a = hire(state, "consultant", { specialty: "cardiology" });
    const b = hire(state, "consultant", { specialty: "cardiology" });
    expect(onDuty(a) || onSite(a)).toBe(true);
    runTo(state, tickAt(1, 10, 0));
    expect(onDuty(a) && onDuty(b)).toBe(true);
    expect(consultantOnCall(state, "cardiology")).toBeNull();

    // Monday night: one is on call at home, the other off duty.
    runTo(state, tickAt(1, 23, 0));
    const onCall = consultantOnCall(state, "cardiology")!;
    const other = onCall.id === a.id ? b : a;
    expect(onCall.onCall?.state).toBe("home");
    expect(other.onCall).toBeNull();
    expect(other.duty).toBe("off");

    // Tuesday night it's the other's turn.
    runTo(state, tickAt(2, 23, 0));
    expect(consultantOnCall(state, "cardiology")!.id).toBe(other.id);
    // Back at 08:00 on Wednesday, both of them.
    runTo(state, tickAt(3, 9, 0));
    expect(onDuty(a) && onDuty(b)).toBe(true);
  });

  it("a whole weekend is one consultant's", () => {
    const state = withRotas();
    hire(state, "consultant", { specialty: "cardiology" });
    hire(state, "consultant", { specialty: "cardiology" });
    const fri = consultantOnCall(state, "cardiology", tickAt(5, 22))!.id;
    expect(consultantOnCall(state, "cardiology", tickAt(6, 12))!.id).toBe(fri);
    expect(consultantOnCall(state, "cardiology", tickAt(8, 7))!.id).toBe(fri);
  });
});

describe("pay", () => {
  it("adds unsocial hours pay for nights and weekends", () => {
    expect(unsocialRate(0, 12)).toBe(0);
    expect(unsocialRate(0, 23)).toBeGreaterThan(0);
    expect(unsocialRate(6, 12)).toBeGreaterThan(unsocialRate(5, 12));

    const state = withRotas();
    setCover(state, "nurse:band5", { day: 1, night: 1 });
    for (let i = 0; i < 5; i++) hire(state, "nurse");
    runTo(state, tickAt(1, 14, 0));
    const day = hourlySalaries(state);
    runTo(state, tickAt(1, 23, 0));
    expect(hourlySalaries(state)).toBeGreaterThan(day);
  });
});

describe("shift times", () => {
  it("overlap for half an hour at each handover", () => {
    expect(shiftsAt(tickAt(1, 12)).map((s) => s.slot)).toEqual([0]);
    expect(shiftsAt(tickAt(1, 19, 45)).map((s) => s.slot)).toEqual([0, 1]);
    expect(shiftsAt(tickAt(2, 3)).map((s) => s.slot)).toEqual([1]);
    expect(shiftsAt(tickAt(2, 7, 45)).map((s) => s.slot)).toEqual([1, 2]);
  });
});

describe("old saves", () => {
  it("keep everyone working around the clock, with on-call consultants on call", () => {
    const old = {
      version: 26,
      state: {
        staff: [
          { id: 1, onCall: null },
          { id: 2, onCall: { state: "home", at: 0 } },
        ],
        settings: { catchment: 80_000, patientVolume: 1 },
        today: { ledger: {} },
        history: [],
      },
    };
    const m = migrate(old) as {
      state: { staff: Staff[]; settings: SimState["settings"]; cover: object };
    };
    expect(m.state.settings.rotas).toBe(false);
    expect(m.state.cover).toEqual({});
    expect(m.state.staff.map((s) => s.contract)).toEqual(["resident", "on_call"]);
    expect(m.state.staff.every((s) => s.duty === "on" && s.shiftEnd === null)).toBe(true);
  });
});
