/**
 * Shared mobile equipment (M4 step 5): one wheeled 12-lead ECG kept in the
 * Majors corridor serves every bay within 25 m. A nurse fetches it, uses it
 * at the bedside and wheels it back; one patient has it at a time.
 */
import { describe, expect, it } from "vitest";
import { decodeSave, encodeSave } from "@save/codec";
import type { Patient } from "@sim/agents";
import { applyCommand } from "@sim/commands";
import { holder, missingRoom, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import { roomOfObject } from "@sim/world/rooms";
import type { SimState } from "@sim/state";
import { spawnPatient } from "@sim/systems/arrivals";
import { TICKS_PER_MINUTE } from "@sim/time";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;

/** The majors fixture with its three bay ECGs swapped for one in the corridor. */
function sharedEcg(): { state: SimState; ecg: number } {
  const state = staffedMajorsAE(1, { ...MAJORS_TEAM, junior_doctor: 0 });
  state.settings.patientVolume = 0;
  for (const o of Object.values(state.objects).filter((o) => o.defId === "ecg_12lead")) {
    expect(applyCommand(state, { type: "remove_object", floor: 0, id: o.id }).ok).toBe(true);
  }
  // In the corridor west of bay 2, wheeled out to the east.
  const cmd = { type: "place_object", floor: 0, defId: "ecg_12lead", x: 9, y: 23, rotation: 3 };
  const result = applyCommand(state, cmd as Parameters<typeof applyCommand>[1]);
  expect(result.ok, result.ok ? "" : result.error).toBe(true);
  const ecg = Object.values(state.objects).find((o) => o.defId === "ecg_12lead")!.id;
  return { state, ecg };
}

/** Patients whose couch was ever in an X-ray Room, and those X-rayed. */
function trackXrays(state: SimState, patients: Patient[], mins: number) {
  const inRoom = new Set<number>();
  for (let i = 0; i < mins * MIN; i++) {
    tick(state);
    for (const p of patients) {
      const room = p.bed === null ? undefined : roomOfObject(state, p.bed);
      if (room?.typeId === "xray_room") inRoom.add(p.id);
    }
    if (i % 50 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  const xrayed = patients.filter((p) => p.investigations.some((t) => t.test === "xray"));
  return { inRoom, xrayed };
}

function breathless(state: SimState, n: number): Patient[] {
  return Array.from({ length: n }, () => {
    const p = spawnPatient(state, siteEntrance(state)!, "shortness_of_breath");
    p.deterioration = null;
    return p;
  });
}

function chestPain(state: SimState): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "chest_pain");
  p.deterioration = null;
  return p;
}

describe("a shared 12-lead ECG", () => {
  it("serves every Majors Bay within 25 m, but not rooms further away", () => {
    const { state } = sharedEcg();
    const bays = state.rooms.filter((r) => r.typeId === "majors_bay");
    expect(bays).toHaveLength(3);
    expect(bays.every((r) => r.capabilities.includes("ecg_12lead"))).toBe(true);
    expect(bays.every((r) => r.forConditions.every((c) => c.ok))).toBe(true);
    expect(missingRoom(state, "majors_bay", ["ecg_12lead"])).toBeNull();
    const lab = state.rooms.find((r) => r.typeId === "lab")!;
    expect(lab.capabilities).not.toContain("ecg_12lead");
  });

  it("is fetched, used at the bedside by one patient at a time, and wheeled back", () => {
    const { state, ecg } = sharedEcg();
    const patients = [chestPain(state), chestPain(state), chestPain(state)];
    const phases = new Set<string>();
    let returned = false;
    for (let i = 0; i < 300 * MIN; i++) {
      tick(state);
      const users = Object.values(state.jobs).filter((j) => j.kit?.objectId === ecg);
      expect(users.length).toBeLessThanOrEqual(1);
      for (const j of users) {
        phases.add(`${j.kind}:${j.kit!.at}`);
        expect(holder(state, ecg, 0)).toBe(j.staffId);
        if (j.kind === "return_kit") returned = true;
      }
      if (i % 50 === 0) expect(invariantProblems(state)).toEqual([]);
      if (patients.every((p) => p.step >= 1) && users.length === 0) break;
    }
    expect(patients.map((p) => p.step >= 1)).toEqual([true, true, true]);
    expect([...phases].sort()).toEqual(
      ["return_kit:staff", "treat:patient", "treat:staff", "treat:store"].sort(),
    );
    expect(returned).toBe(true);
    expect(holder(state, ecg, 0)).toBeUndefined();
  });

  it("waits for another if it's taken away while being fetched", () => {
    const { state, ecg } = sharedEcg();
    const p = chestPain(state);
    for (let i = 0; i < 120 * MIN; i++) {
      tick(state);
      if (Object.values(state.jobs).some((j) => j.kit?.at === "store" && j.staffId !== null)) break;
    }
    expect(applyCommand(state, { type: "remove_object", floor: 0, id: ecg }).ok).toBe(true);
    for (let i = 0; i < 30 * MIN; i++) tick(state);
    expect(invariantProblems(state)).toEqual([]);
    expect(p.step).toBe(0);
    const job = Object.values(state.jobs).find((j) => j.patientId === p.id && j.kind === "treat")!;
    expect(job.state).toBe("open");
    expect(job.kit).toBeNull();
  });

  it("survives a save mid-fetch", () => {
    const { state, ecg } = sharedEcg();
    chestPain(state);
    for (let i = 0; i < 120 * MIN; i++) {
      tick(state);
      if (Object.values(state.jobs).some((j) => j.kit?.at === "staff")) break;
    }
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "kit")))).state;
    const job = Object.values(loaded.jobs).find((j) => j.kit !== null)!;
    expect(job.kit).toEqual({ objectId: ecg, at: "staff" });
    expect(loaded.rooms.filter((r) => r.capabilities.includes("ecg_12lead"))).not.toHaveLength(0);
  });
});

describe("a portable X-ray", () => {
  function withPortable(portable: boolean): SimState {
    const state = staffedMajorsAE(2);
    state.settings.patientVolume = 0;
    if (portable) {
      const cmd = {
        type: "place_object",
        floor: 0,
        defId: "portable_xray",
        x: 9,
        y: 23,
        rotation: 3,
      };
      const result = applyCommand(state, cmd as Parameters<typeof applyCommand>[1]);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
    return state;
  }

  it("X-rays monitored Majors patients on their trolley", () => {
    const state = withPortable(true);
    const patients = breathless(state, 4);
    const { inRoom, xrayed } = trackXrays(state, patients, 360);
    expect(xrayed.length).toBeGreaterThan(0);
    expect(inRoom.size).toBe(0);
  });

  it("without one, they go to the X-ray Room", () => {
    const state = withPortable(false);
    const patients = breathless(state, 4);
    const { inRoom, xrayed } = trackXrays(state, patients, 360);
    expect(xrayed.length).toBeGreaterThan(0);
    expect(xrayed.every((p) => inRoom.has(p.id))).toBe(true);
  });
});
