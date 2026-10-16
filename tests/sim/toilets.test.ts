/**
 * Toilet blocks: cubicles and urinals alongside the accessible toilet.
 */
import { describe, expect, it } from "vitest";
import { applyCommand, type Command } from "@sim/commands";
import { freeToilet, MAX_TOILET_DIRT, slotKey, toiletBlocker, usesUrinal } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { TICKS_PER_DAY } from "@sim/time";
import { WallType } from "@sim/world/grid";
import { staffedSmallAE } from "../fixtures/smallAE";

const place = (defId: string, x: number, y: number, rotation: 0 | 1 | 2 | 3 = 0): Command => ({
  type: "place_object",
  floor: 0,
  defId,
  x,
  y,
  rotation,
});

function apply(state: SimState, commands: Command[]) {
  for (const c of commands) {
    const result = applyCommand(state, c);
    if (!result.ok) throw new Error(`${c.type}: ${result.error}`);
  }
}

const toiletsRoom = (state: SimState) => state.rooms.find((r) => r.typeId === "toilets")!;
const at = (state: SimState, x: number, y: number) =>
  Object.values(state.objects).find((o) => o.x === x && o.y === y)!;

/**
 * The small A&E's toilets widened to 5×2 (x 3–7, y 3–4), door at (5,5):
 * two cubicles, two urinals and a sink in a row, their fronts along y 4.
 */
function block(seed = 3): SimState {
  const state = staffedSmallAE(seed);
  apply(state, [
    { type: "remove_objects", floor: 0, rect: { x: 3, y: 3, w: 2, h: 1 } },
    { type: "demolish", floor: 0, rect: { x: 5, y: 3, w: 1, h: 2 } },
    { type: "demolish", floor: 0, rect: { x: 3, y: 5, w: 3, h: 1 } },
    { type: "build_walls", floor: 0, rect: { x: 8, y: 2, w: 1, h: 4 }, wall: WallType.Standard },
    { type: "build_walls", floor: 0, rect: { x: 2, y: 5, w: 7, h: 1 }, wall: WallType.Standard },
    place("door_single", 5, 5),
    { type: "zone", floor: 0, rect: { x: 3, y: 3, w: 5, h: 2 }, roomType: "toilets" },
    place("toilet_cubicle", 3, 3),
    place("toilet_cubicle", 4, 3),
    place("urinal", 5, 3),
    place("urinal", 6, 3),
    place("sink", 7, 3),
  ]);
  return state;
}

describe("toilet blocks", () => {
  it("need a toilet or cubicle: urinals alone don't make a valid room", () => {
    const state = staffedSmallAE(3);
    apply(state, [
      { type: "remove_objects", floor: 0, rect: { x: 3, y: 3, w: 1, h: 1 } },
      place("urinal", 3, 3),
    ]);
    expect(toiletsRoom(state).valid).toBe(false);
    expect(toiletsRoom(block()).valid).toBe(true);
  });

  it("sends men to a free urinal and everyone else to the cubicle", () => {
    const state = block();
    const urinals = [at(state, 5, 3), at(state, 6, 3)];
    const cubicles = [at(state, 3, 3), at(state, 4, 3)];
    const man = 2;
    const woman = 3;
    expect(usesUrinal(man) && !usesUrinal(woman)).toBe(true);
    const from = { x: 3, y: 8 };
    expect(urinals).toContain(freeToilet(state, from, man));
    expect(cubicles).toContain(freeToilet(state, from, woman));
    // With the urinals taken, a man uses a cubicle; with the cubicles taken, a woman waits.
    const take = (ids: { id: number }[], on: boolean) => {
      for (const { id } of ids) {
        if (on) state.reserved[slotKey(id, 0)] = 99;
        else delete state.reserved[slotKey(id, 0)];
      }
    };
    take(urinals, true);
    expect(cubicles).toContain(freeToilet(state, from, man));
    take(urinals, false);
    take(cubicles, true);
    expect(freeToilet(state, from, woman)).toBeUndefined();
  });

  it("gets used and cleaned over a day, urinals by men only", () => {
    const state = block();
    const kind = (id: number) => state.objects[id]?.defId;
    const users = { urinal: new Set<number>(), toilet_cubicle: new Set<number>() };
    let cleaned = 0;
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      const before = Object.values(state.jobs).filter((j) => j.kind === "clean_toilet").length;
      tick(state);
      const after = Object.values(state.jobs).filter((j) => j.kind === "clean_toilet").length;
      if (after < before) cleaned++;
      for (const p of Object.values(state.patients)) {
        if (p.toilet) users[kind(p.toilet.objectId) as keyof typeof users]?.add(p.id);
      }
    }
    expect(users.urinal.size).toBeGreaterThan(0);
    expect(users.toilet_cubicle.size).toBeGreaterThan(0);
    for (const id of users.urinal) expect(usesUrinal(id)).toBe(true);
    expect(cleaned).toBeGreaterThan(0);
  });

  it("say why a patient can't go: in use, too dirty, or none built", () => {
    const state = block();
    const woman = 3;
    expect(toiletBlocker(state, woman)).toBeNull();
    const cubicles = [at(state, 3, 3), at(state, 4, 3)];
    state.reserved[slotKey(cubicles[0]!.id, 0)] = 99;
    state.reserved[slotKey(cubicles[1]!.id, 0)] = 99;
    expect(toiletBlocker(state, woman)).toBe("the toilets are all in use");
    // A man can still use a urinal.
    expect(toiletBlocker(state, 2)).toBeNull();
    delete state.reserved[slotKey(cubicles[0]!.id, 0)];
    state.dirt[cubicles[0]!.id] = MAX_TOILET_DIRT;
    expect(toiletBlocker(state, woman)).toMatch(/in use or too dirty/);
    apply(state, [{ type: "remove_objects", floor: 0, rect: { x: 3, y: 3, w: 2, h: 1 } }]);
    expect(toiletBlocker(state, woman)).toMatch(/isn't finished/);
  });
});
