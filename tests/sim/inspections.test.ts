/**
 * CQC inspections and ratings, special measures and VIP visits (ROADMAP M6
 * step 5, part 1).
 */
import { describe, expect, it } from "vitest";
import { CQC } from "@data/cqc";
import { pressureEventById } from "@data/pressure";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { aggregate, assess, updateInspections } from "@sim/systems/inspections";
import { announce } from "@sim/systems/pressure";
import { TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "@sim/time";
import { staffedSmallAE } from "../fixtures/smallAE";

const HOUR = 60 * TICKS_PER_MINUTE;

function run(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) tick(state);
}

describe("CQC's aggregation rules", () => {
  it("rates overall as CQC does", () => {
    expect(aggregate(["good", "good", "good", "good", "good"])).toBe("good");
    expect(aggregate(["outstanding", "outstanding", "good", "good", "good"])).toBe("outstanding");
    expect(aggregate(["outstanding", "outstanding", "requires_improvement", "good", "good"])).toBe(
      "good",
    );
    expect(aggregate(["requires_improvement", "good", "good", "good", "good"])).toBe("good");
    expect(
      aggregate(["requires_improvement", "requires_improvement", "good", "good", "good"]),
    ).toBe("requires_improvement");
    expect(aggregate(["inadequate", "good", "good", "good", "outstanding"])).toBe(
      "requires_improvement",
    );
    expect(aggregate(["inadequate", "inadequate", "good", "good", "good"])).toBe("inadequate");
  });

  it("marks down what inspectors see", () => {
    const state = staffedSmallAE(1);
    const clean = assess(state, [], state.tick);
    const dirty = assess(
      state,
      [
        { question: "safe", good: false, text: "a" },
        { question: "safe", good: false, text: "b" },
        { question: "safe", good: false, text: "c" },
      ],
      state.tick,
    );
    expect(dirty.questions.safe.score).toBeLessThan(clean.questions.safe.score);
    expect(dirty.questions.caring.score).toBe(clean.questions.caring.score);
  });
});

describe("an inspection", () => {
  it("comes unannounced on a weekday morning, tours patient areas, and publishes a week later", () => {
    const state = staffedSmallAE(2);
    state.settings.eventFrequency = "realistic";
    // Due now: they come at 09:00 on the next weekday (day 1 is a Monday).
    state.cqc.next = state.tick;
    while (!state.cqc.visit) tick(state);
    expect(state.tick).toBe(tickAt(1, 9));
    const tours = Object.values(state.tours);
    expect(tours.length).toBe(CQC.team);
    expect(tours.every((t) => t.kind === "inspector")).toBe(true);
    run(state, 9 * HOUR);
    expect(state.cqc.visit).toBeNull();
    const pending = state.cqc.pending!;
    expect(pending.published).toBe(pending.visited + CQC.reportDays * TICKS_PER_DAY);
    // What they saw in the rooms they walked round, not just on arrival.
    expect(pending.findings.some((f) => /^(A|An|In a|Patients in a|Broken) /.test(f.text))).toBe(
      true,
    );
    const reputation = state.reputation;
    // Published a week later.
    state.tick = pending.published - 1;
    tick(state);
    expect(state.cqc.overall).toBe(pending.overall);
    expect(state.cqc.reports).toHaveLength(1);
    expect(state.reputation).toBeCloseTo(reputation + CQC.reputation[pending.overall], 0);
    expect(state.cqc.next).toBe(
      pending.published + CQC.nextAfterDays[pending.overall] * TICKS_PER_DAY,
    );
  }, 60_000);

  it("puts an NHS trust rated Inadequate in special measures", () => {
    const state = staffedSmallAE(1);
    const report = assess(state, [], state.tick);
    report.overall = "inadequate";
    report.published = state.tick + 1;
    state.cqc.pending = report;
    state.tick++;
    updateInspections(state);
    expect(state.cqc.specialMeasures).toBe(true);
    expect(state.rating.segment).toBe(4);
  });

  it("never happens with events off", () => {
    const state = staffedSmallAE(1);
    state.cqc.next = state.tick;
    run(state, TICKS_PER_DAY + 2 * HOUR);
    expect(state.cqc.visit).toBeNull();
    expect(state.cqc.pending).toBeNull();
  }, 60_000);
});

describe("a VIP visit", () => {
  it("tours a department and moves reputation by what they see", () => {
    const state = staffedSmallAE(1);
    const before = state.reputation;
    const e = announce(state, { ...pressureEventById.get("vip_visit")!, hours: [1, 1] }, 0);
    tick(state);
    expect(state.cqc.vip).not.toBeNull();
    expect(Object.values(state.tours).some((t) => t.kind === "vip")).toBe(true);
    run(state, e.end - state.tick + 1);
    expect(state.cqc.vip).toBeNull();
    expect(state.reputation).not.toBe(before);
  }, 60_000);
});
