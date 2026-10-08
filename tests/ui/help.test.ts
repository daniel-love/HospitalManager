import { describe, expect, it } from "vitest";
import { equipmentById, roomById } from "@data/catalogue";
import { applyCommand } from "@sim/commands";
import { equipmentHelp, roomTypeHelp, tileHelp } from "@ui/help";
import { buildSmallAE } from "../fixtures/smallAE";

// Fixture coordinates: see tests/fixtures/smallAE.ts.
describe("map hover help", () => {
  it("describes a valid room", () => {
    const help = tileHelp(buildSmallAE(), 0, 14, 4)!;
    expect(help).toMatchObject({ title: "Triage Room", badge: { text: "Valid", ok: true } });
    expect(help.sections![0]!.items).toEqual([{ text: "All met", ok: true }]);
  });

  it("lists what an invalid room is missing", () => {
    const state = buildSmallAE();
    applyCommand(state, { type: "remove_objects", floor: 0, rect: { x: 14, y: 6, w: 1, h: 1 } });
    const help = tileHelp(state, 0, 14, 4)!;
    expect(help.badge).toEqual({ text: "Needs work", ok: false });
    expect(help.sections![0]).toEqual({
      heading: "To fix",
      items: [{ text: "Hand-wash sink", ok: false }],
    });
  });

  it("describes equipment and the room it's in", () => {
    const help = tileHelp(buildSmallAE(), 0, 17, 4)!;
    expect(help.title).toBe("Examination couch");
    expect(help.footer).toBe("In Triage Room ✓");
    expect(help.sections!.map((s) => s.heading)).toEqual(["Access", "Provides", "Needed in"]);
  });

  it("describes doors, and says nothing about empty ground", () => {
    expect(tileHelp(buildSmallAE(), 0, 13, 5)!.title).toBe("Door");
    expect(tileHelp(buildSmallAE(), 0, 0, 0)).toBeNull();
  });
});

describe("palette help", () => {
  it("lists a room type's requirements", () => {
    const items = roomTypeHelp(roomById.get("majors_bay")!).sections![0]!.items.map((i) => i.text);
    expect(items).toContain("At least 3×3 tiles");
    expect(items).toContain("Clear space both sides of each bed");
  });

  it("says where an item is needed", () => {
    const help = equipmentHelp(equipmentById.get("sink")!);
    expect(help.sections!.find((s) => s.heading === "Needed in")!.items[0]!.text).toBe(
      "Triage Room, Toilets",
    );
  });
});
