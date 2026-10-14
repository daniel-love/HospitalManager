/**
 * Major incidents (ROADMAP M6 step 2): standby, a wave of casualties,
 * declaring (calling staff in, standing planned care down) and standing down.
 */
import { describe, expect, it } from "vitest";
import { MAJOR_INCIDENT, pressureEventById } from "@data/pressure";
import { onSite, type Patient, type Staff } from "@sim/agents";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { casualtyAmbulance } from "@sim/systems/arrivals";
import { hourlySalaries } from "@sim/systems/finance";
import { declare, isCalledIn, standDown } from "@sim/systems/majorIncident";
import { announce, knownEvents, updatePressure } from "@sim/systems/pressure";
import { statusPenalty } from "@sim/systems/reputation";
import { setCover } from "@sim/systems/rota";
import { applyStaffCommand } from "@sim/systems/staffing";
import { tickAt, TICKS_PER_MINUTE } from "@sim/time";
import { staffedHospital } from "../fixtures/hospital";
import { buildSmallAE } from "../fixtures/smallAE";

const def = pressureEventById.get("major_incident")!;
const HOUR = 60 * TICKS_PER_MINUTE;

function runFor(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) tick(state);
}

describe("major incidents", () => {
  it("come with 45 minutes' standby, at any time of day, with a mix of casualties", () => {
    const state = buildSmallAE(1);
    state.tick = tickAt(2, 0);
    const e = announce(state, def);
    expect(e.announced).toBeGreaterThanOrEqual(state.tick);
    expect(e.start - e.announced).toBe(def.leadMins! * TICKS_PER_MINUTE);
    // Not known until the ambulance service rings.
    if (e.announced > state.tick) expect(knownEvents(state)).toEqual([]);
    const mi = state.pressure.majorIncident!;
    expect(mi.expected).toBeGreaterThanOrEqual(MAJOR_INCIDENT.casualties[0]);
    expect(mi.expected).toBeLessThanOrEqual(MAJOR_INCIDENT.casualties[1]);
    expect(mi.casualties.every((c) => c.at >= e.start)).toBe(true);
    const ambulances = mi.casualties.filter((c) => c.channel === "ambulance");
    expect(ambulances.every((c) => ["major_trauma", "serious_injury"].includes(c.conditionId))).toBe(
      true,
    );
    state.tick = e.announced;
    updatePressure(state);
    expect(knownEvents(state)).toEqual([e]);
    expect(state.events.some((m) => m.text.startsWith("Major incident – standby"))).toBe(true);
  });

  it("brings casualties to A&E", () => {
    const state = staffedHospital(2);
    state.settings.patientVolume = 0;
    announce(state, def, 0);
    const mi = state.pressure.majorIncident!;
    runFor(state, 6 * HOUR);
    expect(mi.arrived).toBeGreaterThan(mi.expected / 2);
    expect(state.today.stats.arrivals).toBe(mi.arrived);
  }, 60_000);

  it("stabilises and scans the critically injured, then sends them to the major trauma centre", () => {
    const state = staffedHospital(2);
    state.settings.patientVolume = 0;
    expect(casualtyAmbulance(state, "major_trauma")).toBe(true);
    let p: Patient | undefined;
    for (let i = 0; i < 5 * HOUR && !p?.transfer; i++) {
      tick(state);
      p ??= Object.values(state.patients).find((q) => q.conditionId === "major_trauma");
    }
    expect(p?.transfer?.reason).toBe("Needs the major trauma centre");
    expect(state.today.stats.ctScans).toBe(1);
  }, 60_000);

  it("declaring calls off-duty staff in on overtime and stands planned care down, until stood down", () => {
    const state = buildSmallAE(1);
    state.settings.rotas = true;
    state.settings.patientVolume = 0;
    setCover(state, "nurse:band5", { day: 1, night: 1 });
    const nurses: Staff[] = [];
    for (let i = 0; i < 5; i++) {
      const r = applyStaffCommand(state, { type: "hire_staff", role: "nurse" });
      if (r.ok) nurses.push(r.staff);
    }
    runFor(state, HOUR);
    announce(state, def, 0);
    const before = hourlySalaries(state);
    expect(declare(state)).toBe(true);
    expect(state.departments.outpatients).toBe("closed");
    expect(state.departments.theatres).toBe("emergency");
    expect(state.policies.escalation).toBe(true);
    expect(statusPenalty(state)).toBe(0); // Understood, in a major incident.
    const mi = state.pressure.majorIncident!;
    expect(mi.coming.length).toBeGreaterThan(0);
    runFor(state, 2 * HOUR);
    const calledIn = nurses.filter((n) => isCalledIn(state, n));
    expect(calledIn.length).toBeGreaterThan(0);
    for (const n of calledIn) expect(onSite(n)).toBe(true);
    expect(hourlySalaries(state)).toBeGreaterThan(before);
    // Still there hours later, though the rota doesn't have them on.
    runFor(state, 8 * HOUR);
    for (const n of calledIn) expect(onSite(n)).toBe(true);

    expect(standDown(state)).toBe(true);
    expect(state.departments.outpatients).toBe("open");
    expect(state.departments.theatres).toBe("open");
    expect(state.policies.escalation).toBe(false);
    expect(state.pressure.majorIncident).toBeNull();
    runFor(state, 2 * HOUR);
    const rostered = nurses.filter((n) => n.duty === "on").length;
    expect(rostered).toBeLessThanOrEqual(2); // Back to the rota's cover (plus a handover).
  }, 60_000);
});
