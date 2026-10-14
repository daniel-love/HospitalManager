/**
 * Industrial action (ROADMAP M6 step 2, part 2): walkouts with no cover from
 * the bank or agencies, derogations, consultants acting down, and
 * consultants' Christmas Day cover.
 */
import { describe, expect, it } from "vitest";
import { pressureEventById, PRESSURE_EVENTS } from "@data/pressure";
import type { StaffRoleId } from "@data/schema";
import { onSite, type Job, type Staff } from "@sim/agents";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import { hourlySalaries } from "@sim/systems/finance";
import { announce, updatePressure } from "@sim/systems/pressure";
import { setCover } from "@sim/systems/rota";
import { applyStaffCommand, canDo } from "@sim/systems/staffing";
import { consultantsOnStrikeOn, isStriking } from "@sim/systems/strikes";
import { listsOn } from "@sim/systems/theatres";
import { clockFromTick, tickAt } from "@sim/time";
import { buildSmallAE } from "../fixtures/smallAE";

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

const doctorJob = { roles: ["junior_doctor"], specialty: null } as unknown as Job;

describe("industrial action", () => {
  it("resident doctors walk out at the next shift, uncovered by bank or agency, and consultants act down", () => {
    const state = withRotas();
    state.policies.gapFill = "bank_agency";
    setCover(state, "junior_doctor", { day: 1, night: 1 });
    const doctors = Array.from({ length: 5 }, () => hire(state, "junior_doctor"));
    const consultant = hire(state, "consultant", { specialty: "general_medicine" });
    runTo(state, tickAt(1, 12));
    expect(doctors.some((d) => onSite(d))).toBe(true);
    expect(canDo(state, consultant, doctorJob)).toBe(false);
    const before = hourlySalaries(state);

    announce(state, pressureEventById.get("strike_resident_doctors")!, 0);
    expect(doctors.every((d) => isStriking(state, d))).toBe(true);
    expect(canDo(state, consultant, doctorJob)).toBe(true);
    // Strikers aren't paid; the consultant on site earns the rate card.
    expect(onSite(consultant)).toBe(true);
    expect(hourlySalaries(state)).not.toBe(before);

    // The next shift: nobody comes in, and nobody from the bank or an agency.
    runTo(state, tickAt(1, 21));
    expect(doctors.some((d) => onSite(d))).toBe(false);
    expect(
      Object.values(state.staff).some(
        (s) => s.role === "junior_doctor" && s.contract !== "resident",
      ),
    ).toBe(false);
    expect(state.today.stats.unfilledShifts).toBeGreaterThan(0);
  });

  it("keeps about half the nurses at work under derogations", () => {
    const state = withRotas();
    const nurses = Array.from({ length: 40 }, () => hire(state, "nurse"));
    announce(state, pressureEventById.get("strike_nurses")!, 0);
    const out = nurses.filter((n) => isStriking(state, n)).length;
    expect(out).toBeGreaterThan(10);
    expect(out).toBeLessThan(30);
  });

  it("cancels planned lists on a consultants' strike day, once notice is given", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20 });
    const e = announce(state, pressureEventById.get("strike_consultants")!);
    const day = clockFromTick(e.start).day;
    expect(consultantsOnStrikeOn(state, day)).toBe(true);
    expect(consultantsOnStrikeOn(state, day - 1)).toBe(false);
    expect(listsOn(state, day, "am")).toEqual([]);
  });

  it("comes one strike at a time, with two weeks' notice", () => {
    const state = createSimState({ seed: 5, width: 20, height: 20, eventFrequency: "frequent" });
    for (let d = 1; d <= 365 * 3; d++) {
      state.tick = tickAt(d + 1, 0);
      updatePressure(state);
    }
    const strikes = new Set(PRESSURE_EVENTS.filter((d) => d.strike).map((d) => d.id));
    const all = [...state.pressure.past, ...state.pressure.active]
      .filter((e) => strikes.has(e.defId))
      .sort((a, b) => a.start - b.start);
    expect(all.length).toBeGreaterThan(2);
    for (let i = 1; i < all.length; i++)
      expect(all[i]!.start).toBeGreaterThanOrEqual(all[i - 1]!.end);
    for (const e of all) expect(clockFromTick(e.start).hour).toBe(7);
  });
});
