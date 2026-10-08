import { describe, expect, it } from "vitest";
import { applyCommand } from "@sim/commands";
import { createSimState } from "@sim/state";
import { WallType } from "@sim/world/grid";
import { roomAt } from "@sim/world/rooms";
import { applyAll } from "../fixtures/smallAE";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

function newState() {
  const state = createSimState({ seed: 1, width: 20, height: 20 });
  applyAll(state, [{ type: "build_floor", floor: 0, rect: rect(0, 0, 20, 20) }]);
  return state;
}

/** A walled 3×3 triage room (interior 3..5) with a door on its left wall. */
function walledTriage() {
  const state = newState();
  applyAll(state, [
    { type: "build_walls", floor: 0, rect: rect(2, 2, 5, 5), wall: WallType.Standard },
    { type: "zone", floor: 0, rect: rect(3, 3, 3, 3), roomType: "triage_room" },
  ]);
  return state;
}

const check = (state: ReturnType<typeof newState>, label: string) =>
  roomAt(state, 0, 4, 4)!.checks.find((c) => c.label === label)?.ok;

describe("room detection", () => {
  it("finds one room per connected zone area", () => {
    const state = newState();
    applyAll(state, [{ type: "zone", floor: 0, rect: rect(0, 0, 4, 4), roomType: "corridor" }]);
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]!.tiles).toHaveLength(16);
    expect(state.rooms[0]!.bounds).toEqual(rect(0, 0, 4, 4));
  });

  it("splits a zone that a wall cuts in two", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 7, 3), roomType: "corridor" },
      { type: "build_walls", floor: 0, rect: rect(3, 0, 1, 3), wall: WallType.Standard },
    ]);
    expect(state.rooms.map((r) => r.tiles.length).sort()).toEqual([9, 9]);
  });

  it("keeps touching zones of different types as separate rooms", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 3, 3), roomType: "waiting_area" },
      { type: "zone", floor: 0, rect: rect(3, 0, 3, 3), roomType: "ae_reception" },
    ]);
    expect(state.rooms.map((r) => r.typeId).sort()).toEqual(["ae_reception", "waiting_area"]);
  });

  it("re-detects after unzoning", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 3, 3), roomType: "corridor" },
      { type: "zone", floor: 0, rect: rect(0, 0, 3, 3), roomType: null },
    ]);
    expect(state.rooms).toHaveLength(0);
    expect(state.floors[0]!.roomId.every((id) => id === 0)).toBe(true);
  });
});

describe("room validation", () => {
  it("lists what an empty room is missing", () => {
    const state = walledTriage();
    const room = roomAt(state, 0, 4, 4)!;
    expect(room.valid).toBe(false);
    expect(room.checks.filter((c) => !c.ok).map((c) => c.label)).toEqual([
      "Has a door",
      "Examination couch or trolley",
      "Observations machine",
      "Hand-wash sink",
    ]);
  });

  it("needs walls all round for enclosed rooms", () => {
    const state = walledTriage();
    expect(check(state, "Enclosed by walls")).toBe(true);
    applyAll(state, [{ type: "demolish", floor: 0, rect: rect(6, 4, 1, 1) }]);
    expect(check(state, "Enclosed by walls")).toBe(false);
  });

  it("counts a door as part of the enclosure", () => {
    const state = walledTriage();
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "door_single", x: 2, y: 4, rotation: 1 },
    ]);
    expect(check(state, "Has a door")).toBe(true);
    expect(check(state, "Enclosed by walls")).toBe(true);
  });

  it("checks minimum size in either orientation", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 3, 2), roomType: "minors_cubicle" },
      { type: "zone", floor: 0, rect: rect(10, 0, 2, 2), roomType: "minors_cubicle" },
    ]);
    const size = (x: number) => roomAt(state, 0, x, 0)!.checks[0]!;
    expect(size(0)).toMatchObject({ label: "At least 2×3", ok: true, detail: "3×2" });
    expect(size(10)).toMatchObject({ ok: false, detail: "2×2" });
  });

  it("becomes valid once equipped, and derives capabilities", () => {
    const state = walledTriage();
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "door_single", x: 2, y: 4, rotation: 1 },
      { type: "place_object", floor: 0, defId: "exam_couch", x: 5, y: 3, rotation: 0 },
      { type: "place_object", floor: 0, defId: "obs_machine", x: 3, y: 3, rotation: 0 },
      { type: "place_object", floor: 0, defId: "sink", x: 3, y: 5, rotation: 2 },
    ]);
    const room = roomAt(state, 0, 4, 4)!;
    expect(room.valid).toBe(true);
    expect(room.capabilities).toEqual(["examination", "hand_hygiene", "obs"]);
  });

  it("only counts items wholly inside the room", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 3, 3), roomType: "waiting_area" },
      // Bench straddles the zone edge: tiles (2,0) (3,0) (4,0).
      { type: "place_object", floor: 0, defId: "waiting_bench", x: 2, y: 0, rotation: 0 },
    ]);
    expect(roomAt(state, 0, 0, 0)!.objectIds).toEqual([]);
  });

  it("sums seats and grants combo capabilities", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 6, 6), roomType: "waiting_area" },
      { type: "place_object", floor: 0, defId: "waiting_bench", x: 0, y: 0, rotation: 0 },
      { type: "place_object", floor: 0, defId: "waiting_bench", x: 0, y: 2, rotation: 0 },
      { type: "place_object", floor: 0, defId: "defibrillator", x: 5, y: 5, rotation: 0 },
      { type: "place_object", floor: 0, defId: "resus_trolley", x: 4, y: 5, rotation: 0 },
    ]);
    const room = roomAt(state, 0, 0, 0)!;
    expect(room.checks).toContainEqual({ label: "Seating for 6", ok: true, detail: "6 of 6" });
    expect(room.capabilities).toContain("resuscitation");
  });

  it("is rebuilt when equipment is sold", () => {
    const state = walledTriage();
    applyAll(state, [{ type: "place_object", floor: 0, defId: "sink", x: 3, y: 5, rotation: 2 }]);
    expect(check(state, "Hand-wash sink")).toBe(true);
    expect(
      applyCommand(state, { type: "remove_objects", floor: 0, rect: rect(3, 5, 1, 1) }).ok,
    ).toBe(true);
    expect(check(state, "Hand-wash sink")).toBe(false);
  });
});

describe("bed space in Majors and Resus", () => {
  it("needs both long sides of each bed clear", () => {
    const state = newState();
    applyAll(state, [
      { type: "zone", floor: 0, rect: rect(0, 0, 4, 4), roomType: "majors_bay" },
      { type: "place_object", floor: 0, defId: "trolley", x: 0, y: 1, rotation: 0 },
    ]);
    const check = () =>
      roomAt(state, 0, 2, 2)!.checks.find((c) => c.label === "Clear space both sides of each bed");
    // Left side is the map edge.
    expect(check()).toMatchObject({ ok: false, detail: "0 of 1" });
    applyAll(state, [{ type: "move_object", floor: 0, id: 1, x: 1, y: 1, rotation: 0 }]);
    expect(check()).toMatchObject({ ok: true, detail: "1 of 1" });
  });

  it("isn't required in other rooms", () => {
    const state = walledTriage();
    expect(
      roomAt(state, 0, 4, 4)!.checks.some((c) => c.label.startsWith("Clear space both sides")),
    ).toBe(false);
  });
});

describe("reception must open onto a waiting area", () => {
  const LABEL = "Opens onto a Waiting Area";
  // Reception zoned at x 0–3, something else from x 4 (or 5 past a wall at x 4).
  const opens = (state: ReturnType<typeof newState>) =>
    roomAt(state, 0, 1, 1)!.checks.find((c) => c.label === LABEL)!.ok;
  const zone = (x: number, w: number, roomType: string) =>
    ({ type: "zone", floor: 0, rect: rect(x, 0, w, 4), roomType }) as const;

  it("fails with no waiting area", () => {
    const state = newState();
    applyAll(state, [zone(0, 4, "ae_reception")]);
    expect(opens(state)).toBe(false);
  });

  it("passes when the rooms touch with no wall between", () => {
    const state = newState();
    applyAll(state, [zone(0, 4, "ae_reception"), zone(4, 4, "waiting_area")]);
    expect(opens(state)).toBe(true);
  });

  it("fails through a solid wall, passes once there's a door", () => {
    const state = newState();
    applyAll(state, [
      zone(0, 4, "ae_reception"),
      { type: "build_walls", floor: 0, rect: rect(4, 0, 1, 8), wall: WallType.Standard },
      zone(5, 4, "waiting_area"),
    ]);
    expect(opens(state)).toBe(false);
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "door_single", x: 4, y: 2, rotation: 1 },
    ]);
    expect(opens(state)).toBe(true);
  });

  it("doesn't count a waiting area reached only via a corridor", () => {
    const state = newState();
    applyAll(state, [
      zone(0, 4, "ae_reception"),
      zone(4, 2, "corridor"),
      zone(6, 4, "waiting_area"),
    ]);
    expect(opens(state)).toBe(false);
  });
});
