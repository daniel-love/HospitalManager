/** The planned-care fixture: its side rooms work, and private inpatients get them. */
import { describe, expect, it } from "vitest";
import { tick } from "@sim/sim";
import { bookAppointments, refer } from "@sim/systems/referrals";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_DAY } from "@sim/time";
import { buildPlannedCare, grantPrivileges, sideRooms } from "../fixtures/plannedCare";

describe("the planned-care fixture", () => {
  it("has three working side rooms", () => {
    const state = buildPlannedCare(1);
    const rooms = sideRooms(state);
    expect(rooms.map((r) => r.typeId)).toEqual(["side_room", "side_room", "side_room"]);
    for (const r of rooms) expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rooms.every((r) => r.valid)).toBe(true);
  });

  it("puts a private inpatient in a side room after their operation", () => {
    const state = buildPlannedCare(1, "private");
    state.settings.patientVolume = 0;
    for (const [role, n] of [
      ["theatre_practitioner", 2],
      ["nurse", 2],
      ["porter", 1],
      ["junior_doctor", 1],
    ] as const) {
      for (let i = 0; i < n; i++) applyStaffCommand(state, { type: "hire_staff", role });
    }
    grantPrivileges(state, [
      { specialty: "trauma_orthopaedics", clinics: 0, lists: 2 },
      { specialty: "anaesthetics", clinics: 0, lists: 2 },
    ]);
    const r = refer(state, "trauma_orthopaedics", false, "self_pay");
    r.kind = "surgery";
    r.dayCase = false;
    bookAppointments(state);
    expect(r.booking).not.toBeNull();
    const rooms = new Set(sideRooms(state).map((x) => x.id));
    let inSideRoom = false;
    for (let i = 0; i < 8 * TICKS_PER_DAY && !inSideRoom; i++) {
      tick(state);
      const p = Object.values(state.patients).find((x) => x.name === r.name);
      if (p?.stage === "on_ward" && p.bed !== null) {
        inSideRoom = rooms.has(state.objectRoom[p.bed]!);
      }
    }
    expect(inSideRoom).toBe(true);
  });
});
