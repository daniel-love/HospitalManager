/**
 * Equipment breakdowns, repairs and maintenance, and power cuts (ROADMAP M6
 * step 4).
 */
import { afterEach, describe, expect, it } from "vitest";
import { equipmentById } from "@data/catalogue";
import { MAINTENANCE, POWER } from "@data/maintenance";
import { pressureEventById } from "@data/pressure";
import { applyCommand } from "@sim/commands";
import { tick } from "@sim/sim";
import type { PlacedObject, SimState } from "@sim/state";
import { breakDown, setEssentialRoom, updateMaintenance } from "@sim/systems/maintenance";
import { announce } from "@sim/systems/pressure";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { inService, isPowered } from "@sim/world/service";
import { staffedDeathsWard } from "../fixtures/deathsWard";
import { buildSmallAE } from "../fixtures/smallAE";

const HOUR = 60 * TICKS_PER_MINUTE;

function find(state: SimState, defId: string): PlacedObject {
  return Object.values(state.objects).find((o) => o.defId === defId)!;
}

const saved = POWER.itemsPerGenerator;
afterEach(() => {
  POWER.itemsPerGenerator = saved;
});

describe("breakdowns", () => {
  it("takes a broken CT scanner out of service until a clinical engineer repairs it", () => {
    const state = buildSmallAE(1);
    const ct = find(state, "ct_scanner");
    const room = () => roomOfObject(state, ct.id)!;
    expect(room().valid).toBe(true);
    breakDown(state, ct);
    expect(inService(state, ct.id)).toBe(false);
    expect(room().valid).toBe(false);
    expect(room().checks.find((c) => !c.ok)?.detail).toContain("out of service");
    // Without an engineer, it stays broken.
    for (let i = 0; i < 2 * HOUR; i++) tick(state);
    expect(inService(state, ct.id)).toBe(false);

    applyStaffCommand(state, { type: "hire_staff", role: "clinical_engineer" });
    const money = state.money;
    for (let i = 0; i < 9 * HOUR && !inService(state, ct.id); i++) tick(state);
    expect(inService(state, ct.id)).toBe(true);
    expect(room().valid).toBe(true);
    expect(state.maintenance[ct.id]!.wear).toBe(MAINTENANCE.wearAfterRepair);
    // Spare parts (and a few hours' running costs).
    expect(state.money).toBeLessThan(money - equipmentById.get("ct_scanner")!.cost * 0.04);
  }, 60_000);

  it("wears with use and age, and engineers maintain worn kit", () => {
    const state = buildSmallAE(1);
    const ct = find(state, "ct_scanner");
    for (let h = 0; h < 24; h++) {
      state.tick += HOUR - (state.tick % HOUR);
      updateMaintenance(state);
    }
    const wear = state.maintenance[ct.id]!.wear;
    expect(wear).toBeCloseTo(MAINTENANCE.wearPerDay, 1);
    // Worn: an engineer services it, as good as new.
    state.maintenance[ct.id]!.wear = MAINTENANCE.ppmFrom + 5;
    applyStaffCommand(state, { type: "hire_staff", role: "clinical_engineer" });
    for (let i = 0; i < 30 * HOUR && state.maintenance[ct.id]!.wear > 1; i++) tick(state);
    expect(state.maintenance[ct.id]!.wear).toBeLessThan(1);
    expect(inService(state, ct.id)).toBe(true);
  }, 60_000);

  it("never breaks anything with events off, nor touches the random stream", () => {
    const state = buildSmallAE(1);
    for (const o of Object.values(state.objects))
      state.maintenance[o.id] = { wear: 100, broken: null };
    const rng = structuredClone(state.rng);
    for (let h = 0; h < 48; h++) {
      state.tick += HOUR - (state.tick % HOUR);
      updateMaintenance(state);
    }
    expect(Object.values(state.maintenance).some((m) => m.broken !== null)).toBe(false);
    expect(state.rng).toEqual(rng);
  });

  it("breaks worn kit down more often with events on", () => {
    const state = buildSmallAE(1);
    state.settings.eventFrequency = "realistic";
    for (const o of Object.values(state.objects))
      state.maintenance[o.id] = { wear: 100, broken: null };
    for (let h = 0; h < 24 * 60; h++) {
      state.tick += HOUR - (state.tick % HOUR);
      updateMaintenance(state);
    }
    expect(Object.values(state.maintenance).some((m) => m.broken !== null)).toBe(true);
  });
});

describe("power cuts", () => {
  /** The deaths ward with its spare room made a Plant Room. */
  function withPlantRoom(generator: boolean): SimState {
    const state = staffedDeathsWard(1);
    const r = applyCommand(state, {
      type: "zone",
      floor: 0,
      rect: { x: 22, y: 2, w: 6, h: 6 },
      roomType: "plant_room",
    });
    expect(r.ok).toBe(true);
    if (generator) {
      const g = applyCommand(state, {
        type: "place_object",
        floor: 0,
        defId: "standby_generator",
        x: 22,
        y: 5,
        rotation: 0,
      });
      expect(g.ok).toBe(true);
    }
    return state;
  }

  const powered = (state: SimState) =>
    Object.values(state.objects).filter((o) => equipmentById.get(o.defId)?.power);

  it("stops powered kit without generators, until the power's back", () => {
    const state = withPlantRoom(false);
    expect(powered(state).length).toBeGreaterThan(0);
    const e = announce(state, pressureEventById.get("power_cut")!, 0);
    tick(state);
    expect(powered(state).every((o) => !isPowered(state, o.id))).toBe(true);
    state.tick = e.end;
    tick(state);
    expect(powered(state).every((o) => isPowered(state, o.id))).toBe(true);
  });

  it("covers the essential supply first, in clinical order", () => {
    const state = withPlantRoom(true);
    // Powered kit on the ward too, besides the mortuary's fridges.
    const obs = applyCommand(state, {
      type: "place_object",
      floor: 0,
      defId: "obs_machine",
      x: 4,
      y: 6,
      rotation: 0,
    });
    expect(obs.ok).toBe(true);
    POWER.itemsPerGenerator = 1;
    announce(state, pressureEventById.get("power_cut")!, 0);
    tick(state);
    const on = powered(state).filter((o) => isPowered(state, o.id));
    expect(on).toHaveLength(1);
    const first = roomOfObject(state, on[0]!.id)!;
    const types = powered(state).map((o) => roomOfObject(state, o.id)?.typeId);
    const best = POWER.essential.find((t) => types.includes(t));
    expect(first.typeId).toBe(best);
    // Taken off the essential supply, it goes behind every essential room.
    setEssentialRoom(state, first, false);
    const now = powered(state).find((o) => isPowered(state, o.id))!;
    expect(roomOfObject(state, now.id)!.id).not.toBe(first.id);
  });
});
