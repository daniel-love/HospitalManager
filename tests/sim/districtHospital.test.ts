/**
 * The pre-built district hospital and the major incident scenario that
 * starts from it (ROADMAP M6 step 6, part 2).
 */
import { describe, expect, it } from "vitest";
import { scenarioById } from "@data/scenarios";
import { buildDistrictHospital, DISTRICT_MAP } from "@game/maps/districtHospital";
import { roomsPatientsCantReach, siteEntrance } from "@sim/places";
import { createSimState } from "@sim/state";
import { parkingSpaces } from "@sim/systems/ambulances";
import { startScenario, updateScenarios } from "@sim/systems/scenarios";
import { tickAt } from "@sim/time";

const def = scenarioById.get("major_incident")!;

function scenario() {
  const state = createSimState({
    seed: 1,
    ...DISTRICT_MAP,
    rotas: true,
    funding: def.funding,
    money: def.money,
    catchment: def.catchment,
    eventFrequency: def.eventFrequency,
    recruitment: true,
  });
  buildDistrictHospital(state);
  startScenario(state, def);
  return state;
}

describe("the district hospital", () => {
  it("is built, linked to the road and staffed, without spending the scenario's cash", () => {
    const state = scenario();
    expect(state.money).toBe(def.money);
    expect(state.settings.recruitment).toBe(true);
    expect(siteEntrance(state)).not.toBeNull();
    expect(roomsPatientsCantReach(state)).toEqual([]);
    expect(parkingSpaces(state).length).toBeGreaterThan(0);
    expect(state.rooms.every((r) => r.valid)).toBe(true);
    expect(Object.keys(state.staff).length).toBeGreaterThan(80);
    expect(Object.keys(state.cover).length).toBeGreaterThan(5);
  });

  it("scripts the strike from the start, and then the major incident during it", () => {
    const state = scenario();
    const strike = def.script.find((s) => s.event === "strike_resident_doctors")!;
    const incident = def.script.find((s) => s.event === "major_incident")!;
    // Announced on day 1, as the scenario starts.
    const s = state.pressure.active.find((e) => e.defId === "strike_resident_doctors")!;
    expect(s.start).toBe(tickAt(strike.startDay, strike.startHour));
    state.tick = tickAt(incident.announceDay, 0);
    updateScenarios(state);
    const mi = state.pressure.active.find((e) => e.defId === "major_incident")!;
    expect(mi.start).toBe(tickAt(incident.startDay, incident.startHour));
    expect(mi.start).toBeGreaterThan(s.start);
    expect(mi.start).toBeLessThan(s.end);
  });
});
