/**
 * What's waiting to be cleaned, for the map's cleaning marks.
 */
import { describe, expect, it } from "vitest";
import { TOILET_USES_BEFORE_CLEAN } from "@data/patients";
import { cleaningStatuses, isCouch } from "@sim/places";
import { tick } from "@sim/sim";
import { dirtyCouch } from "@sim/systems/jobBoard";
import { buildSmallAE, hireTeam } from "../fixtures/smallAE";

describe("cleaning status", () => {
  it("marks a used couch dirty, then being cleaned, then clean", () => {
    const state = buildSmallAE();
    state.settings.patientVolume = 0;
    const couch = Object.values(state.objects).find((o) => isCouch(o.defId))!;
    expect(cleaningStatuses(state).size).toBe(0);
    dirtyCouch(state, couch.id);
    expect(cleaningStatuses(state).get(couch.id)).toBe("dirty");
    hireTeam(state, { cleaner: 1 });
    let seen = false;
    for (let i = 0; i < 2000 && state.dirt[couch.id] !== undefined; i++) {
      tick(state);
      if (cleaningStatuses(state).get(couch.id) === "cleaning") seen = true;
    }
    expect(seen).toBe(true);
    expect(cleaningStatuses(state).has(couch.id)).toBe(false);
  });

  it("marks a toilet due a clean, then out of use", () => {
    const state = buildSmallAE();
    const toilet = Object.values(state.objects).find((o) => o.defId === "toilet")!;
    state.dirt[toilet.id] = TOILET_USES_BEFORE_CLEAN - 1;
    expect(cleaningStatuses(state).has(toilet.id)).toBe(false);
    state.dirt[toilet.id] = TOILET_USES_BEFORE_CLEAN;
    expect(cleaningStatuses(state).get(toilet.id)).toBe("dirty");
    state.dirt[toilet.id] = TOILET_USES_BEFORE_CLEAN * 2;
    expect(cleaningStatuses(state).get(toilet.id)).toBe("out_of_use");
  });
});
