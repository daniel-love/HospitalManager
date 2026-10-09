import { describe, expect, it } from "vitest";
import {
  content,
  equipmentSections,
  roomSections,
  staffRoleSections,
  type Section,
} from "@data/catalogue";
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

describe("list sections (Hire panel and build palettes)", () => {
  /** Every item exactly once, under a heading, with no empty sections. */
  function expectComplete<T extends { id: string }>(sections: Section<T>[], all: T[]) {
    const listed = sections.flatMap((s) => s.items.map((i) => i.id));
    expect([...listed].sort()).toEqual(all.map((i) => i.id).sort());
    for (const s of sections) {
      expect(s.name).not.toBe("");
      expect(s.items.length).toBeGreaterThan(0);
    }
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
  }

  it("list every staff role under its group", () => {
    expectComplete(staffRoleSections(), content.staffRoles);
    expect(staffRoleSections().map((s) => s.name)).toEqual([
      "Medical",
      "Nursing",
      "Support services",
      "Administrative",
    ]);
  });

  it("list every room type under its department's section", () => {
    expectComplete(roomSections(), content.rooms);
    expect(roomSections()[0]!.name).toBe("A&E");
  });

  it("list every item of equipment under its category", () => {
    expectComplete(equipmentSections(), content.equipment);
  });

  it("reject a room in a department with no section", () => {
    const bad = { ...content.rooms[0]!, id: "bad", code: 250, department: "Elsewhere" };
    expect(() => validateContent({ ...content, rooms: [...content.rooms, bad] })).toThrow();
  });

  it("reject a staff role with no group", () => {
    const noGroup: Record<string, unknown> = { ...content.staffRoles[0]! };
    delete noGroup.group;
    expect(() =>
      validateContent({ ...content, staffRoles: [noGroup, ...content.staffRoles.slice(1)] }),
    ).toThrow();
  });
});
