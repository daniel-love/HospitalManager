/**
 * Toilet blocks: cubicles and urinals alongside the accessible toilet.
 */
import { describe, expect, it } from "vitest";
import { applyCommand, type Command } from "@sim/commands";
import { TOILET_URGE } from "@data/patients";
import {
  freeToilet,
  MAX_TOILET_DIRT,
  release,
  restPoint,
  slotKey,
  toiletBlocker,
  usesUrinal,
} from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { toiletHoldUp } from "@sim/systems/patients";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";
import { WallType } from "@sim/world/grid";
import { roomOfObject } from "@sim/world/rooms";
import type { Patient } from "@sim/agents";
import { staffedMajorsAE } from "../fixtures/majorsAE";
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

describe("toilet trips from a cubicle or trolley", () => {
  /**
   * Runs the small A&E with everyone in a cubicle bursting for the toilet,
   * until one of them leaves it for the toilet; returns them, or undefined.
   */
  function firstToGo(state: SimState) {
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      for (const p of Object.values(state.patients)) {
        if (p.stage === "in_cubicle" && !p.toilet) p.bladder = Math.max(p.bladder, 95);
      }
      tick(state);
      const p = Object.values(state.patients).find((q) => q.stage === "in_cubicle" && q.toilet);
      if (p) return p;
    }
    return undefined;
  }

  it("walk to the toilet and back to the bed kept for them, and aren't seen while away", () => {
    const state = staffedSmallAE(3);
    const p = firstToGo(state)!;
    expect(p).toBeDefined();
    const bed = p.bed!;
    const home = restPoint(state.objects[bed]!);
    const homeTile = { x: Math.round(home.x), y: Math.round(home.y) };
    let used = false;
    let leftBed = false;
    let seenWhileAway = false;
    for (let i = 0; i < 60 * TICKS_PER_MINUTE && p.toilet; i++) {
      tick(state);
      if (!p.toilet) break;
      if (p.toilet.left > 0) used = true;
      if (Math.round(p.x) !== homeTile.x || Math.round(p.y) !== homeTile.y) leftBed = true;
      // Their cubicle stays theirs while they're away.
      expect(p.stage).toBe("in_cubicle");
      expect(p.bed).toBe(bed);
      expect(state.reserved[slotKey(bed, 0)]).toBe(p.id);
      const working = Object.values(state.jobs).some(
        (j) => j.patientId === p.id && j.state === "working",
      );
      if (working) seenWhileAway = true;
    }
    expect(p.toilet).toBeNull();
    expect(leftBed).toBe(true);
    expect(used).toBe(true);
    expect(seenWhileAway).toBe(false);
    expect(p.bladder).toBeLessThan(TOILET_URGE);
    // Back on their bed.
    expect(p.stage).toBe("in_cubicle");
    expect(p.bed).toBe(bed);
    expect({ x: p.x, y: p.y, floor: p.floor }).toEqual(home);
  });

  it("explain what's in the way for a patient in a cubicle", () => {
    const state = staffedSmallAE(3);
    const p = firstToGo(state)!;
    // Pretend they haven't gone yet.
    release(state, p.toilet!.objectId, 0, p.id);
    p.toilet = null;
    const open = Object.values(state.jobs).filter((j) => j.patientId === p.id);
    expect(open.every((j) => j.state === "open")).toBe(true);
    expect(toiletHoldUp(state, p, true)).toBe("they'll go once the clinician is done");
    expect(toiletHoldUp(state, p, false)).toBeNull();
    for (const o of Object.values(state.objects)) {
      if (o.defId === "toilet" || o.defId === "toilet_cubicle") {
        state.reserved[slotKey(o.id, 0)] = 99;
      }
    }
    expect(toiletHoldUp(state, p, false)).toMatch(/in use/);
  });
});

describe("a commode for a patient too unwell to walk to the toilet", () => {
  it("is brought by a nurse to their Majors trolley, which they never leave", () => {
    const state = staffedMajorsAE(3);
    const onMajorsTrolley = (p: Patient) =>
      p.stage === "in_cubicle" &&
      p.bed !== null &&
      roomOfObject(state, p.bed)?.typeId === "majors_bay";
    let p: Patient | undefined;
    for (let i = 0; !p && i < TICKS_PER_DAY; i++) {
      tick(state);
      p = Object.values(state.patients).find(onMajorsTrolley);
    }
    expect(p).toBeDefined();
    const patient = p!;
    const bed = patient.bed!;
    let commodeJob = false;
    for (let i = 0; i < 3 * 60 * TICKS_PER_MINUTE; i++) {
      // Very sick (category 1): not to be walking to the toilet.
      if (onMajorsTrolley(patient)) {
        patient.category = 1;
        if (!commodeJob) patient.bladder = Math.max(patient.bladder, 95);
      }
      tick(state);
      expect(patient.toilet).toBeNull();
      if (
        Object.values(state.jobs).some((j) => j.patientId === patient.id && j.kind === "commode")
      ) {
        commodeJob = true;
        expect(patient.bed).toBe(bed);
        expect(state.reserved[slotKey(bed, 0)]).toBe(patient.id);
      } else if (commodeJob) break;
    }
    expect(commodeJob).toBe(true);
    expect(patient.bladder).toBeLessThan(TOILET_URGE);
  });
});
