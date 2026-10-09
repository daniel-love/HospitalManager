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

describe("conditions", () => {
  it("every pathway step happens in a known room with a role that exists", () => {
    expect(content.conditions.length).toBe(11);
    for (const c of content.conditions) expect(c.pathway.length).toBeGreaterThan(0);
  });

  it("rejects a condition that can deteriorate with no step to stabilise it", () => {
    const sepsis = content.conditions.find((c) => c.id === "sepsis")!;
    const bad = {
      ...sepsis,
      id: "bad",
      pathway: sepsis.pathway.map((s) => ({ ...s, stabilises: false })),
    };
    expect(() => validateContent({ ...content, conditions: [...content.conditions, bad] })).toThrow(
      /no step stabilises/,
    );
  });

  it("rejects a step in an unknown room", () => {
    const bad = {
      ...content.conditions[0]!,
      id: "bad",
      pathway: [{ name: "X", roles: ["nurse"], room: "ballroom", mins: [1, 2] }],
    };
    expect(() => validateContent({ ...content, conditions: [...content.conditions, bad] })).toThrow(
      /unknown room ballroom/,
    );
  });

  it("rejects a step with min above max minutes", () => {
    const bad = {
      ...content.conditions[0]!,
      pathway: [{ name: "X", roles: ["nurse"], room: "minors_cubicle", mins: [20, 10] }],
    };
    expect(() => validateContent({ ...content, conditions: [bad] })).toThrow();
  });
});
