import { describe, expect, it } from "vitest";
import { describeAdvice } from "@game/advice";
import { conditionGuide, roomGuide, staffGuide } from "@ui/handbook";
import { content } from "@data/catalogue";
import { createSimState } from "@sim/state";
import { buildMajorsAE } from "../fixtures/majorsAE";
import { hireTeam, staffedSmallAE } from "../fixtures/smallAE";

const status = (state: Parameters<typeof describeAdvice>[0], text: string) =>
  describeAdvice(state)
    .groups.flatMap((g) => g.items)
    .find((i) => i.text.startsWith(text))?.status;

describe("Help panel recommendations", () => {
  it("starts an empty site with reception as the next step", () => {
    const advice = describeAdvice(createSimState({ seed: 1, width: 20, height: 20 }));
    expect(advice.next?.text).toMatch(/^A&E Reception/);
    const done = advice.groups.flatMap((g) => g.items).filter((i) => i.status === "ok");
    expect(done.map((i) => i.text)).toEqual(["Every room reachable from a corridor"]);
  });

  it("ticks off the small A&E's rooms and team", () => {
    const state = staffedSmallAE(1);
    const walkIn = describeAdvice(state).groups[0]!;
    const todo = walkIn.items.filter((i) => i.status === "todo").map((i) => i.text);
    expect(todo).toEqual([]);
    expect(status(state, "An Emergency Nurse Practitioner")).toBe("optional");
    expect(describeAdvice(state).next?.text).toMatch(/Ambulance Bay/);
  });

  it("flags Majors trolleys no nurse station can see", () => {
    const detail = (state: Parameters<typeof describeAdvice>[0]) =>
      describeAdvice(state)
        .groups.flatMap((g) => g.items)
        .find((i) => i.text.startsWith("Every Majors and Resus trolley"))!.detail;
    // The fixture's blind-spot bay.
    expect(detail(buildMajorsAE(1))).toMatch(/^1 trolley isn't seen/);
    expect(detail(buildMajorsAE(1, { station: false }))).toMatch(/^\d+ trolleys aren't seen/);
  });

  it("asks for each admitting specialty's team", () => {
    const state = buildMajorsAE(1);
    expect(status(state, "A Cardiology team")).toBe("todo");
    hireTeam(state, { porter: 1 });
    expect(status(state, "Porters")).toBe("ok");
  });

  it("suggests more capacity for a bigger catchment", () => {
    const small = staffedSmallAE(1);
    const big = staffedSmallAE(1);
    big.settings.catchment = small.settings.catchment * 3;
    const row = (s: typeof small, label: string) =>
      describeAdvice(s).capacity.find((r) => r.label === label)!.recommended!;
    for (const label of ["Minors Cubicles", "Junior doctors", "Staff nurses"]) {
      expect(row(big, label)).toBeGreaterThan(row(small, label));
    }
    expect(row(small, "Minors Cubicles")).toBeGreaterThanOrEqual(2);
  });
});

describe("Help panel reference", () => {
  it("covers every room, role, specialty and condition", () => {
    const ids = (sections: { entries: { id: string }[] }[]) =>
      sections.flatMap((s) => s.entries.map((e) => e.id)).sort();
    expect(ids(roomGuide())).toEqual(content.rooms.map((r) => r.id).sort());
    expect(ids(conditionGuide())).toEqual(content.conditions.map((c) => c.id).sort());
    expect(ids(staffGuide())).toEqual(
      [...content.staffRoles.map((r) => r.id), ...content.specialties.map((s) => s.id)].sort(),
    );
  });

  it("says who treats a condition, where and with what", () => {
    const chest = conditionGuide()
      .flatMap((s) => s.entries)
      .find((e) => e.id === "chest_pain")!;
    expect(chest.sections[0]!.items[0]).toBe(
      "12-lead ECG: Staff Nurse, in a Majors Bay with ECG (12-lead)",
    );
  });
});
