/**
 * The tutorial (ROADMAP M6 step 7): its steps tick off one at a time as
 * the A&E is built and staffed, and it's complete once five patients have
 * gone home.
 */
import { describe, expect, it } from "vitest";
import { scenarioById } from "@data/scenarios";
import { tick } from "@sim/sim";
import { createSimState } from "@sim/state";
import { applyCommand } from "@sim/commands";
import {
  advanceTutorial,
  describeGoals,
  startScenario,
  tutorialDone,
} from "@sim/systems/scenarios";
import { buildSmallAE, hireTeam } from "../fixtures/smallAE";

const tutorial = scenarioById.get("tutorial")!;

describe("the tutorial", () => {
  it("starts at the first step, with nothing built", () => {
    const state = createSimState({ seed: 1, site: true });
    startScenario(state, tutorial);
    const g = describeGoals(state)!;
    expect(g.tutorial?.step).toBe(1);
    expect(g.tutorial?.highlight).toBe("construction");
    expect(tutorialDone(state, "foundations")).toBe(false);
  });

  it("ticks a step off as soon as it's built, even while paused", () => {
    const state = createSimState({ seed: 1, site: true });
    startScenario(state, tutorial);
    const road = state.site!.road;
    const r = applyCommand(state, {
      type: "build_floor",
      floor: 0,
      rect: { x: 90, y: road.y - 14, w: 16, h: 10 },
    });
    expect(r.ok).toBe(true);
    advanceTutorial(state);
    expect(state.goals.objectives.foundations!.status).toBe("met");
    expect(describeGoals(state)!.tutorial?.step).toBe(2);
  });

  it("ticks the steps off in order, and is complete after five patients go home", () => {
    // What the tutorial builds: no X-ray or lab, at its 40k catchment.
    const state = buildSmallAE(1, { site: true, diagnostics: false });
    state.settings.catchment = tutorial.catchment;
    startScenario(state, tutorial);
    // Everything is built: the building steps tick off, but not the team yet.
    for (let i = 0; i < 2 * 600; i++) tick(state);
    const statuses = () => tutorial.objectives.map((o) => state.goals.objectives[o.id]!.status);
    expect(statuses().slice(0, 6)).toEqual(Array(6).fill("met"));
    expect(state.goals.objectives.staff!.status).toBe("pending");
    expect(describeGoals(state)!.tutorial?.highlight).toBe("staff");
    hireTeam(state, { receptionist: 1, nurse: 2, junior_doctor: 2, cleaner: 1 });
    for (let i = 0; i < 2 * 14400 && !state.goals.outcome; i++) tick(state);
    expect(state.goals.outcome?.won).toBe(true);
    expect(describeGoals(state)!.tutorial).toBeNull();
  }, 120_000);
});
