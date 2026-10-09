/**
 * Curtain dividers between bays, and privacy curtains drawn round a bed
 * during and after care, which hide it from the nurse station.
 */
import { describe, expect, it } from "vitest";
import type { Patient } from "@sim/agents";
import { applyCommand, planCommand } from "@sim/commands";
import { siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import { spawnPatient } from "@sim/systems/arrivals";
import { curtainsDrawn, inCare } from "@sim/systems/curtains";
import { bedCover } from "@sim/systems/monitoring";
import { TICKS_PER_MINUTE } from "@sim/time";
import { WallType } from "@sim/world/grid";
import { hasLineOfSight } from "@sim/world/los";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { applyAll } from "../fixtures/smallAE";

const MIN = TICKS_PER_MINUTE;
const F = 0;
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

function floored(): SimState {
  const state = createSimState({ seed: 1, width: 14, height: 14, money: 2_000_000 });
  applyAll(state, [{ type: "build_floor", floor: F, rect: rect(0, 0, 14, 14) }]);
  return state;
}

function runUntil(state: SimState, done: () => boolean, limit = 240 * MIN): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
  }
  throw new Error("timed out");
}

describe("a curtain divider", () => {
  it("splits one zone into separate bays", () => {
    const state = floored();
    applyAll(state, [
      { type: "zone", floor: F, rect: rect(1, 1, 4, 7), roomType: "majors_bay" },
      { type: "build_walls", floor: F, rect: rect(1, 4, 4, 1), wall: WallType.Curtain },
    ]);
    const bays = state.rooms.filter((r) => r.typeId === "majors_bay");
    expect(bays.map((r) => r.tiles.length)).toEqual([12, 12]);
  });

  it("blocks sight and movement", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: F, rect: rect(5, 0, 1, 14), wall: WallType.Curtain },
    ]);
    const grid = state.floors[F]!;
    expect(hasLineOfSight(grid, 2, 5, 9, 5)).toBe(false);
    // Nothing crosses it: a door can't be put in it either.
    expect(
      planCommand(state, {
        type: "place_object",
        floor: F,
        defId: "door_single",
        x: 5,
        y: 5,
        rotation: 1,
      }),
    ).toMatchObject({ ok: false, error: "Doors go in walls, not curtains" });
  });

  it("is cheaper than a wall", () => {
    const state = floored();
    const curtain = planCommand(state, {
      type: "build_walls",
      floor: F,
      rect: rect(1, 1, 4, 1),
      wall: WallType.Curtain,
    });
    const wall = planCommand(state, {
      type: "build_walls",
      floor: F,
      rect: rect(1, 1, 4, 1),
      wall: WallType.Standard,
    });
    expect(curtain.ok && wall.ok && curtain.cost < wall.cost).toBe(true);
  });

  it("doesn't enclose a room that needs walls", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: F, rect: rect(0, 1, 6, 6), wall: WallType.Standard },
      { type: "build_walls", floor: F, rect: rect(5, 2, 1, 4), wall: WallType.Curtain },
      { type: "place_object", floor: F, defId: "door_single", x: 2, y: 1, rotation: 0 },
      { type: "zone", floor: F, rect: rect(1, 2, 4, 4), roomType: "triage_room" },
    ]);
    const triage = state.rooms.find((r) => r.typeId === "triage_room")!;
    expect(triage.checks.find((c) => c.label === "Enclosed by walls")?.ok).toBe(false);
  });

  it("can't replace a wall that holds a fixture", () => {
    const state = floored();
    applyAll(state, [
      { type: "build_walls", floor: F, rect: rect(1, 1, 4, 1), wall: WallType.Standard },
      { type: "place_object", floor: F, defId: "oxygen_point", x: 2, y: 2, rotation: 0 },
    ]);
    const result = applyCommand(state, {
      type: "build_walls",
      floor: F,
      rect: rect(1, 1, 4, 1),
      wall: WallType.Curtain,
    });
    expect(result.ok).toBe(false);
    expect(state.floors[F]!.wall[1 * 14 + 2]).toBe(WallType.Standard);
  });
});

describe("a bay's privacy curtain", () => {
  /** A Majors department with a nurse at the station and a doctor. */
  function majors(): { state: SimState; p: Patient } {
    const state = staffedMajorsAE(1, MAJORS_TEAM);
    state.settings.patientVolume = 0;
    const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
    p.deterioration = null;
    return { state, p };
  }

  it("is drawn while a clinician treats them, hiding the bed from the station", () => {
    const { state, p } = majors();
    runUntil(state, () => p.bed !== null && inCare(state, p.id));
    expect(curtainsDrawn(state, p.bed!)).toBe(true);
    expect(bedCover(state, p.bed!)).toBe("curtained");
  });

  it("stays drawn for a while after care, then opens", () => {
    const { state, p } = majors();
    runUntil(state, () => p.bed !== null && inCare(state, p.id));
    runUntil(state, () => !inCare(state, p.id));
    if (p.bed === null || p.stage !== "in_cubicle") throw new Error("moved on");
    const bed = p.bed;
    expect(p.curtainUntil).not.toBeNull();
    expect(curtainsDrawn(state, bed)).toBe(true);
    runUntil(state, () => !curtainsDrawn(state, bed) || inCare(state, p.id), 11 * MIN);
    if (!inCare(state, p.id)) expect(curtainsDrawn(state, bed)).toBe(false);
  });

  it("isn't drawn for routine observations", () => {
    const { state, p } = majors();
    runUntil(state, () =>
      Object.values(state.jobs).some(
        (j) => j.patientId === p.id && j.kind === "obs" && j.state === "working",
      ),
    );
    if (p.bed !== null && !inCare(state, p.id) && p.curtainUntil === null) {
      expect(curtainsDrawn(state, p.bed)).toBe(false);
    }
  });
});
