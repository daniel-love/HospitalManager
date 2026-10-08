import { describe, expect, it } from "vitest";
import { content } from "@data/catalogue";
import { validateContent } from "@data/schema";

describe("game content", () => {
  it("passes validation at import", () => {
    expect(content.equipment.length).toBeGreaterThanOrEqual(25);
    expect(content.rooms.length).toBeGreaterThan(0);
  });

  it("rejects duplicate ids and dangling references", () => {
    const dupe = { ...content.equipment[0]! };
    const badRoom = {
      ...content.rooms[1]!,
      id: "bad_room",
      code: 200,
      required: [{ label: "Unicorn", anyOf: ["unicorn"] }],
    };
    expect(() =>
      validateContent({
        ...content,
        equipment: [...content.equipment, dupe],
        rooms: [...content.rooms, badRoom],
      }),
    ).toThrow(/duplicate object id[\s\S]*unknown item unicorn/);
  });

  it("rejects malformed definitions", () => {
    const bad = { ...content.equipment[0]!, cost: -5 };
    expect(() => validateContent({ ...content, equipment: [bad] })).toThrow();
  });
});

describe("room connections", () => {
  it("rejects a connection to an unknown room type", () => {
    const bad = {
      ...content.rooms[1]!,
      connectedTo: [{ roomType: "ballroom", label: "Opens onto a ballroom" }],
    };
    expect(() => validateContent({ ...content, rooms: [bad, ...content.rooms.slice(2)] })).toThrow(
      /connects to unknown ballroom/,
    );
  });
});
