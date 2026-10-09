import { describe, expect, it } from "vitest";
import { isStandable, objectRect, unmetAccess } from "@sim/world/objects";
import { roomAt } from "@sim/world/rooms";
import { buildSmallAE, FIXTURE_MONEY } from "../fixtures/smallAE";

describe("small A&E fixture (M1 done-when layout)", () => {
  const state = buildSmallAE();

  it("detects every room and they are all valid", () => {
    const summary = state.rooms.map((r) => ({
      type: r.typeId,
      valid: r.valid,
      failing: r.checks.filter((c) => !c.ok).map((c) => c.label),
    }));
    expect(summary.map((s) => s.type).sort()).toEqual([
      "ae_reception",
      "corridor",
      "corridor",
      "ct_room",
      "lab",
      "minors_cubicle",
      "minors_cubicle",
      "toilets",
      "triage_room",
      "waiting_area",
      "xray_room",
    ]);
    for (const s of summary) expect(s, s.type).toMatchObject({ valid: true, failing: [] });
  });

  it("derives capabilities from equipment", () => {
    expect(roomAt(state, 0, 15, 4)?.capabilities).toEqual(["examination", "hand_hygiene", "obs"]);
    expect(roomAt(state, 0, 6, 12)?.capabilities).toContain("booking");
  });

  it("charged for the build", () => {
    expect(state.money).toBeLessThan(FIXTURE_MONEY);
    expect(state.money).toBeGreaterThan(0);
  });
});

describe("small A&E item orientation", () => {
  it("meets every item's access rules", () => {
    const state = buildSmallAE();
    const grid = state.floors[0]!;
    const blocked = Object.values(state.objects)
      .filter((o) =>
        unmetAccess(o.defId, objectRect(o), o.rotation, (t) => isStandable(grid, t.x, t.y)),
      )
      .map((o) => `${o.defId}@${o.x},${o.y}`);
    expect(blocked).toEqual([]);
  });
});
