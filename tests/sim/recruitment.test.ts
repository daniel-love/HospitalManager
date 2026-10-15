/**
 * Recruitment from applicants, and ratings' effect on grants (ROADMAP M6
 * step 5, part 2).
 */
import { describe, expect, it } from "vitest";
import { RECRUITMENT } from "@data/recruitment";
import { createSimState, type SimState } from "@sim/state";
import { updateGrants } from "@sim/systems/grants";
import {
  appealFactor,
  bestApplicant,
  openingCampaign,
  updateRecruitment,
} from "@sim/systems/recruitment";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";

const HOUR = 60 * TICKS_PER_MINUTE;

function recruiting(): SimState {
  return createSimState({ seed: 1, width: 20, height: 20, recruitment: true });
}

/** Recruitment alone, an hour at a time. */
function hours(state: SimState, n: number): void {
  for (let i = 0; i < n; i++) {
    state.tick += HOUR - (state.tick % HOUR);
    updateRecruitment(state);
  }
}

describe("recruitment", () => {
  it("hires the most skilled applicant, and can't hire without one", () => {
    const state = recruiting();
    const none = applyStaffCommand(state, { type: "hire_staff", role: "porter" });
    expect(none.ok).toBe(false);
    openingCampaign(state);
    const best = bestApplicant(state, "porter")!;
    const before = state.applicants.length;
    const r = applyStaffCommand(state, { type: "hire_staff", role: "porter" });
    if (!r.ok) throw new Error(r.error);
    expect(r.staff.skill).toBe(best.skill);
    expect(state.applicants).toHaveLength(before - 1);
    // Nurses by band, consultants by specialty.
    expect(bestApplicant(state, "nurse:band7")).toBeDefined();
    expect(bestApplicant(state, "consultant:cardiology")).toBeDefined();
    const c = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: "cardiology",
    });
    expect(c.ok).toBe(true);
  });

  it("brings more applicants with a better reputation and rating", () => {
    const count = (reputation: number, rating: SimState["csi"]["overall"]) => {
      const state = recruiting();
      state.reputation = reputation;
      state.csi.overall = rating;
      hours(state, 24 * 28);
      return state.applicants.length;
    };
    expect(count(85, "outstanding")).toBeGreaterThan(count(30, "inadequate") * 2);
    const state = recruiting();
    state.reputation = 90;
    expect(appealFactor(state)).toBeLessThanOrEqual(RECRUITMENT.factorRange[1]);
  });

  it("loses applicants who wait too long", () => {
    const state = recruiting();
    openingCampaign(state);
    const first = state.applicants[0]!;
    hours(state, RECRUITMENT.staysDays * 24 + 1);
    expect(state.applicants).not.toContain(first);
  });

  it("hires instantly with recruitment off", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20 });
    expect(applyStaffCommand(state, { type: "hire_staff", role: "porter" }).ok).toBe(true);
  });
});

describe("grants and ratings", () => {
  it("offers no grants to a hospital rated Inadequate", () => {
    const state = createSimState({ seed: 1, width: 20, height: 20 });
    state.csi.overall = "inadequate";
    for (let d = 0; d < 200; d++) {
      state.tick += TICKS_PER_DAY;
      updateGrants(state);
    }
    expect(state.grants.offer).toBeNull();
  });
});
