import { describe, expect, it } from "vitest";
import { decodeSave, encodeSave, SaveError } from "@save/codec";
import { tick } from "@sim/sim";
import { nextU32 } from "@sim/rng";
import type { SimState } from "@sim/state";
import { buildSmallAE } from "../fixtures/smallAE";

/** Comparable snapshot of everything that matters, typed arrays included. */
function snapshot(state: SimState) {
  return JSON.parse(
    JSON.stringify(state, (_k, v: unknown) =>
      ArrayBuffer.isView(v) ? Array.from(v as Uint8Array) : v,
    ),
  ) as unknown;
}

/** Simulates saving to disk and loading again. */
function roundTrip(state: SimState): SimState {
  return decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "test")))).state;
}

describe("save codec", () => {
  it("round-trips a built hospital exactly, rebuilding derived data", () => {
    const state = buildSmallAE();
    for (let i = 0; i < 100; i++) tick(state);
    nextU32(state.rng);
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
    expect(loaded.rooms.every((r) => r.valid)).toBe(true);
  });

  it("continues identically after loading (determinism)", () => {
    const a = buildSmallAE(42);
    const b = roundTrip(a);
    for (let i = 0; i < 500; i++) {
      tick(a);
      tick(b);
    }
    expect(nextU32(b.rng)).toBe(nextU32(a.rng));
    expect(b.tick).toBe(a.tick);
  });

  it("records metadata", () => {
    const save = encodeSave(buildSmallAE(), "My A&E", new Date("2026-10-08T12:00:00Z"));
    expect(save.meta).toMatchObject({
      name: "My A&E",
      savedAt: "2026-10-08T12:00:00.000Z",
      gameTime: "Day 1  08:00",
    });
  });

  it("rejects things that aren't saves", () => {
    expect(() => decodeSave({ hello: "world" })).toThrow(SaveError);
    expect(() => decodeSave(null)).toThrow(SaveError);
  });

  it("rejects corrupt grids and overlapping objects", () => {
    const save = JSON.parse(JSON.stringify(encodeSave(buildSmallAE(), "x")));
    const shortGrid = structuredClone(save);
    shortGrid.state.floors[0].wall = btoa("abc");
    expect(() => decodeSave(shortGrid)).toThrow(/Wrong size for floor 0 wall/);

    const overlap = structuredClone(save);
    overlap.state.objects.push({ ...overlap.state.objects[0], id: 1 });
    expect(() => decodeSave(overlap)).toThrow(/overlap/);

    const unknown = structuredClone(save);
    unknown.state.objects[0].defId = "time_machine";
    expect(() => decodeSave(unknown)).toThrow(/Unknown item/);
  });

  it("rejects saves from a newer version", () => {
    const save = JSON.parse(JSON.stringify(encodeSave(buildSmallAE(), "x")));
    save.version = 999;
    expect(() => decodeSave(save)).toThrow(SaveError);
  });
});

describe("fixtures in saves", () => {
  it("restores a fixture over a bed into the right layers", async () => {
    const { applyAll } = await import("../fixtures/smallAE");
    const state = buildSmallAE();
    // Ceiling curtains already sit in the cubicles; add a wall oxygen point too.
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "oxygen_point", x: 15, y: 12, rotation: 0 },
    ]);
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
  });
});
