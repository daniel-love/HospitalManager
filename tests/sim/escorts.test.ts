/**
 * Escorts to scans (M4 step 5): a porter wheels a Majors patient to CT or
 * X-ray on their trolley and back; one who shouldn't leave their monitoring
 * has a nurse with them the whole way.
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import type { Job, Patient } from "@sim/agents";
import { holder, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { spawnPatient } from "@sim/systems/arrivals";
import { TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import type { StaffCounts } from "../fixtures/smallAE";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;

function quiet(team: StaffCounts = MAJORS_TEAM): SimState {
  const state = staffedMajorsAE(1, team);
  state.settings.patientVolume = 0;
  for (let i = 0; i < 20 * MIN; i++) tick(state); // Staff walk in.
  return state;
}

function arrive(state: SimState, conditionId: string): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, conditionId);
  p.deterioration = null;
  return p;
}

/** Runs with every scan step made certain, recording each tick's escort jobs. */
function runScanned(
  state: SimState,
  conditionId: string,
  mins: number,
  each: (p: Patient, escorts: Job[]) => void,
): Patient {
  const steps = conditionById.get(conditionId)!.pathway.filter((s) => s.imaging);
  const chances = steps.map((s) => s.chance);
  for (const s of steps) s.chance = 1;
  try {
    const p = arrive(state, conditionId);
    for (let i = 0; i < mins * MIN; i++) {
      tick(state);
      const escorts = Object.values(state.jobs).filter(
        (j) => j.kind === "escort" && j.patientId === p.id,
      );
      each(p, escorts);
      if (i % 50 === 0) expect(invariantProblems(state)).toEqual([]);
    }
    return p;
  } finally {
    steps.forEach((s, i) => (s.chance = chances[i]!));
  }
}

const porterOf = (escorts: Job[]) => escorts.find((j) => j.roles.includes("porter"));
const nurseOf = (escorts: Job[]) => escorts.find((j) => j.roles.includes("nurse"));

describe("a porter takes a Majors patient to CT", () => {
  it("wheels them there and back on their trolley, with no nurse for a stable patient", () => {
    const state = quiet();
    const seen = new Set<string>();
    let trolley: number | null = null;
    const p = runScanned(state, "elderly_fall", 300, (p, escorts) => {
      const porter = porterOf(escorts);
      if (porter) seen.add(`${porter.step}:${porter.state}`);
      if (nurseOf(escorts)) seen.add("nurse");
      if (p.homeBed !== null) {
        trolley = p.homeBed;
        // Their trolley stays theirs while they're away.
        expect(holder(state, p.homeBed, 0)).toBe(p.id);
      }
    });
    expect(state.today.stats.ctScans).toBe(1);
    expect(seen.has("0:working") && seen.has("1:working")).toBe(true);
    expect(seen.has("nurse")).toBe(false);
    expect(trolley).not.toBeNull();
    expect(roomOfObject(state, trolley!)!.typeId).toBe("majors_bay");
    expect(p.step).toBeGreaterThan(2);
  });

  it("takes a nurse along for a monitored patient, who stays through the scan", () => {
    const state = quiet();
    let nurseDuringScan = false;
    let porterWaitedForNurse = false;
    runScanned(state, "shortness_of_breath", 400, (p, escorts) => {
      const nurse = nurseOf(escorts);
      const porter = porterOf(escorts);
      const room = p.bed === null ? undefined : roomOfObject(state, p.bed);
      if (room?.typeId === "xray_room" && p.stage === "in_cubicle" && nurse) nurseDuringScan = true;
      if (porter && nurse && porter.state === "working") {
        expect(nurse.state).toBe("working");
        porterWaitedForNurse = true;
      }
    });
    expect(state.today.stats.xrays).toBe(1);
    expect(nurseDuringScan).toBe(true);
    expect(porterWaitedForNurse).toBe(true);
  });
});

describe("without porters", () => {
  it("leaves the patient in their bay, the scanner kept, and says why", () => {
    const state = quiet({ ...MAJORS_TEAM, porter: 0 });
    const p = runScanned(state, "elderly_fall", 300, () => {});
    expect(state.today.stats.ctScans).toBe(0);
    expect(p.homeBed).not.toBeNull();
    expect(roomOfObject(state, p.homeBed!)!.typeId).toBe("majors_bay");
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/no porters to wheel them/);
  });
});
