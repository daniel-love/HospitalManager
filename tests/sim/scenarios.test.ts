/**
 * Scenarios and fail states (ROADMAP M6 step 6): starting later in the
 * year, scripted events, objectives met and failed, locks, and losing.
 */
import { describe, expect, it } from "vitest";
import { scenarioById } from "@data/scenarios";
import { emptyLedger, emptyStats } from "@sim/agents";
import { applyCommand } from "@sim/commands";
import { createSimState, emptyMonth, type SimState } from "@sim/state";
import { lockReason, startScenario, updateScenarios } from "@sim/systems/scenarios";
import { clockFromTick, dateOf, tickAt } from "@sim/time";
import { buildMajorsAE } from "../fixtures/majorsAE";

const winter = scenarioById.get("ae_before_winter")!;
const priv = scenarioById.get("private_that_pays")!;

/** Runs the scenario's checks at midnight of a day, with a day's report for the day before. */
function midnight(
  state: SimState,
  day: number,
  stats: Partial<ReturnType<typeof emptyStats>> = {},
): void {
  state.tick = tickAt(day, 0);
  state.history.push({
    day: day - 1,
    ledger: emptyLedger(),
    stats: { ...emptyStats(), ...stats },
    reputation: state.reputation,
  });
  if (state.history.length > 60) state.history.shift();
  updateScenarios(state);
}

describe("scenarios", () => {
  it("can start later in the year", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20, startDay: winter.startDay });
    expect(clockFromTick(state.tick).day).toBe(winter.startDay);
    expect(state.month.monthIndex).toBe(dateOf(winter.startDay).monthIndex);
    expect(state.csi.next).toBeGreaterThan(state.tick);
  });

  it("sets off scripted events on their day, for the hour they're due", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20, startDay: winter.startDay });
    startScenario(state, winter);
    const heat = winter.script.find((s) => s.event === "heatwave")!;
    midnight(state, heat.announceDay);
    const e = state.pressure.active.find((a) => a.defId === "heatwave")!;
    expect(e.start).toBe(tickAt(heat.startDay, heat.startHour));
  });

  it("fails an objective missed by its deadline, and the scenario with it", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20, startDay: winter.startDay });
    startScenario(state, winter);
    const open = winter.objectives.find((o) => o.id === "open")!;
    midnight(state, (open as { by: number }).by + 1);
    expect(state.goals.objectives.open!.status).toBe("failed");
    expect(state.goals.outcome?.won).toBe(false);
  });

  it("meets the A&E objective with the rooms working and patients through, and unlocks CT", () => {
    const state = buildMajorsAE(1, { ambulance: true });
    state.tick = tickAt(winter.startDay, 8);
    startScenario(state, winter);
    expect(lockReason(state, "ct_room")).not.toBeNull();
    const ct = applyCommand(state, {
      type: "zone",
      floor: 0,
      rect: { x: 1, y: 1, w: 3, h: 3 },
      roomType: "ct_room",
    });
    expect(ct.ok).toBe(false);
    for (let d = 1; d <= 7; d++) midnight(state, winter.startDay + d, { departures: 20 });
    expect(state.goals.objectives.open!.status).toBe("met");
    expect(state.goals.unlocked).toContain("ct");
    expect(lockReason(state, "ct_room")).toBeNull();
  });

  it("judges the winter 4-hour standard over the whole window", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20, startDay: winter.startDay });
    startScenario(state, winter);
    state.goals.objectives.open!.status = "met";
    const w = winter.objectives.find((o) => o.id === "winter")! as { from: number; to: number };
    for (let d = w.from + 1; d <= w.to + 1; d++) {
      midnight(state, d, { departures: 100, within4h: 80 });
    }
    midnight(state, w.to + 2);
    expect(state.goals.objectives.winter!.status).toBe("met");
    expect(state.goals.outcome?.won).toBe(true);
  });

  it("wins the private scenario with a good month and a good name", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20, funding: "private" });
    startScenario(state, priv);
    state.months.push({
      ...emptyMonth(0, 0),
      ledger: { ...emptyLedger(), private: 200_000, salaries: 100_000 },
    });
    state.reputation = 80;
    midnight(state, 40);
    expect(state.goals.outcome?.won).toBe(true);
  });
});

describe("fail states", () => {
  it("loses a sandbox game after three months in segment 4, with fail states on", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20, failStates: true });
    state.rating.segment = 4;
    midnight(state, 2);
    midnight(state, 2 + 91);
    expect(state.goals.outcome?.won).toBe(false);
  });

  it("never ends a sandbox game with fail states off", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20 });
    state.rating.segment = 4;
    midnight(state, 2);
    midnight(state, 2 + 91);
    expect(state.goals.outcome).toBeNull();
  });
});
