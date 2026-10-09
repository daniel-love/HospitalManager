/**
 * A room missing a step's equipment: patients who'd need it don't come,
 * and messages say what's missing rather than "No working Majors Bay".
 */
import { describe, expect, it } from "vitest";
import { applyCommand } from "@sim/commands";
import { missingRoom } from "@sim/places";
import { treatableConditions } from "@sim/systems/arrivals";
import { buildMajorsAE } from "../fixtures/majorsAE";

describe("Majors Bays without a 12-lead ECG", () => {
  const state = buildMajorsAE(1);
  for (const o of Object.values(state.objects).filter((o) => o.defId === "ecg_12lead")) {
    expect(applyCommand(state, { type: "remove_object", floor: 0, id: o.id }).ok).toBe(true);
  }

  it("don't take chest pain, which starts with one", () => {
    const ids = treatableConditions(state).map((c) => c.id);
    expect(ids).not.toContain("chest_pain");
    expect(ids).toContain("shortness_of_breath");
  });

  it("are named as missing it", () => {
    expect(missingRoom(state, "majors_bay", ["ecg_12lead"])).toBe(
      "No Majors Bay with ECG (12-lead)",
    );
    expect(missingRoom(state, "majors_bay", ["oxygen"])).toBeNull();
    expect(missingRoom(state, "resus_bay", ["resuscitation"])).toBe("No working Resus Bay");
  });
});
