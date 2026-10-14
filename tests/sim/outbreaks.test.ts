/**
 * Norovirus outbreaks (ROADMAP M6 step 3, part 2): spread in a shared ward
 * room, isolation in a side room, closures by the infection control team
 * (or the player), and no discharge until 48 hours symptom-free.
 */
import { describe, expect, it } from "vitest";
import type { Patient } from "@sim/agents";
import { reserve, restPoint, siteEntrance } from "@sim/places";
import type { PlacedObject, SimState } from "@sim/state";
import { tick } from "@sim/sim";
import { spawnPatient } from "@sim/systems/arrivals";
import { infect, infectionHold, symptomatic, updateOutbreaks } from "@sim/systems/outbreaks";
import { TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { staffedDeathsWard } from "../fixtures/deathsWard";

const HOUR = 60 * TICKS_PER_MINUTE;

function beds(state: SimState, roomType: string): PlacedObject[] {
  return Object.values(state.objects).filter(
    (o) => o.defId === "hospital_bed" && roomOfObject(state, o.id)?.typeId === roomType,
  );
}

/** An inpatient lying in `bed`, admitted a while ago, not due home for days. */
function inpatient(state: SimState, bed: PlacedObject): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
  p.deterioration = null;
  reserve(state, bed.id, 0, p.id);
  p.bed = bed.id;
  p.stage = "on_ward";
  const at = restPoint(bed);
  p.x = p.prevX = at.x;
  p.y = p.prevY = at.y;
  p.category = 3;
  p.times.triaged = p.times.decided = p.times.admitted = state.tick;
  p.stayUntil = state.tick + 10 * 24 * HOUR;
  return p;
}

/** Symptoms from now. */
function caseNow(state: SimState, p: Patient): void {
  infect(state, p, true);
  const length = p.infection!.clears - p.infection!.symptoms;
  p.infection!.symptoms = state.tick;
  p.infection!.clears = state.tick + length;
}

/** Just the outbreak, an hour at a time (nothing else moves). */
function hours(state: SimState, n: number): void {
  for (let i = 0; i < n; i++) {
    state.tick += HOUR;
    updateOutbreaks(state);
  }
}

describe("norovirus", () => {
  it("spreads to others in a shared ward room, and holds them until 48 hours clear", () => {
    const state = staffedDeathsWard(1);
    const ward = beds(state, "ward").map((b) => inpatient(state, b));
    caseNow(state, ward[0]!);
    expect(symptomatic(state, ward[0]!)).toBe(true);
    hours(state, 72);
    expect(ward.slice(1).filter((p) => p.infection).length).toBeGreaterThan(0);
    const p = ward[0]!;
    // Not home while symptomatic, nor until 48 hours after.
    state.tick = p.infection!.clears + 47 * HOUR;
    expect(infectionHold(state, p)).toBe(true);
    state.tick = p.infection!.clears + 49 * HOUR;
    expect(infectionHold(state, p)).toBe(false);
  });

  it("spreads less with enhanced infection control", () => {
    const run = (control: boolean) => {
      let total = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const state = staffedDeathsWard(seed);
        state.policies.infectionControl = control;
        const ward = beds(state, "ward").map((b) => inpatient(state, b));
        caseNow(state, ward[0]!);
        hours(state, 24);
        total += ward.slice(1).filter((p) => p.infection).length;
      }
      return total;
    };
    expect(run(true)).toBeLessThan(run(false));
  });

  it("the infection control team closes a room with two cases, and reopens it once clear", () => {
    const state = staffedDeathsWard(1);
    const ward = beds(state, "ward").map((b) => inpatient(state, b));
    caseNow(state, ward[0]!);
    caseNow(state, ward[1]!);
    hours(state, 1);
    const room = roomOfObject(state, ward[0]!.bed!)!;
    expect(room.closed).toBe(true);
    // Nobody admitted into it while closed.
    expect(Object.keys(state.closedRooms)).toHaveLength(1);
    // Clear everyone, then 48 hours on, it reopens and the beds are deep cleaned.
    for (const p of ward) p.infection = null;
    hours(state, 1);
    expect(roomOfObject(state, ward[0]!.bed!)!.closed).toBe(false);
  });

  it("only advises closing when the player decides", () => {
    const state = staffedDeathsWard(1);
    state.policies.outbreakClosures = "manual";
    const ward = beds(state, "ward").map((b) => inpatient(state, b));
    caseNow(state, ward[0]!);
    caseNow(state, ward[1]!);
    state.tick = Math.ceil(state.tick / (6 * HOUR)) * 6 * HOUR - HOUR;
    hours(state, 1);
    expect(roomOfObject(state, ward[0]!.bed!)!.closed).toBe(false);
    expect(state.events.some((e) => e.text.includes("advises closing"))).toBe(true);
  });

  it("moves a new case into a free side room", () => {
    const state = staffedDeathsWard(1);
    for (let i = 0; i < 20 * TICKS_PER_MINUTE; i++) tick(state);
    const p = inpatient(state, beds(state, "ward")[0]!);
    infect(state, p, true);
    // Symptoms on the hour, so the onset is seen.
    p.infection!.symptoms = Math.ceil((state.tick + 1) / HOUR) * HOUR;
    p.infection!.clears = p.infection!.symptoms + 48 * HOUR;
    const moved = () =>
      p.stage === "on_ward" && roomOfObject(state, p.bed!)?.typeId === "side_room";
    for (let i = 0; i < 3 * HOUR && !moved(); i++) tick(state);
    expect(roomOfObject(state, p.bed!)?.typeId).toBe("side_room");
    expect(p.stage).toBe("on_ward");
    expect(state.today.stats.hospitalInfections).toBe(1);
  }, 60_000);
});
