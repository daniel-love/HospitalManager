/**
 * The process after a death (ROADMAP M3 step 4, GAME_DESIGN §5.6).
 */
import { describe, expect, it } from "vitest";
import { MORALE_START } from "@data/deaths";
import type { Patient } from "@sim/agents";
import { holder, reserve, restPoint, siteEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { PlacedObject, SimState } from "@sim/state";
import { spawnPatient } from "@sim/systems/arrivals";
import { deathStatus, debrief, die, mortuarySpaces } from "@sim/systems/deaths";
import { TICKS_PER_MINUTE } from "@sim/time";
import { roomOfObject } from "@sim/world/rooms";
import { describePatient } from "@game/describe";
import { staffedDeathsWard } from "../fixtures/deathsWard";
import { invariantProblems } from "./simHelpers";

const MIN = TICKS_PER_MINUTE;
const HOUR = 60 * MIN;

function runUntil(state: SimState, done: () => boolean, limit = 8 * HOUR): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick(state);
    if (i % 100 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  throw new Error("timed out");
}

function bedIn(state: SimState, roomType: string): PlacedObject {
  return Object.values(state.objects).find(
    (o) => o.defId === "hospital_bed" && roomOfObject(state, o.id)?.typeId === roomType,
  )!;
}

/** An inpatient lying in `bed`, as if admitted an hour ago. */
function inpatient(state: SimState, bed: PlacedObject): Patient {
  const p = spawnPatient(state, siteEntrance(state)!, "sepsis");
  p.deterioration = null;
  reserve(state, bed.id, 0, p.id);
  p.bed = bed.id;
  p.stage = "on_ward";
  const at = restPoint(bed);
  p.x = p.prevX = at.x;
  p.y = p.prevY = at.y;
  p.category = 2;
  p.times.triaged = p.times.decided = p.times.admitted = state.tick;
  p.stayUntil = state.tick + 24 * HOUR;
  return p;
}

/** Let the staff walk in from outside first. */
function settled(state: SimState): SimState {
  for (let i = 0; i < 20 * MIN; i++) tick(state);
  return state;
}

describe("an expected death in a side room", () => {
  const state = settled(staffedDeathsWard());
  const bed = bedIn(state, "side_room");
  const p = inpatient(state, bed);
  p.endOfLife = true;
  p.stayUntil = state.tick + MIN;
  runUntil(state, () => p.stage === "deceased");
  const d = p.death!;

  it("needs no crash call, and the family were there", () => {
    expect(d.expected).toBe(true);
    expect(d.familyTold).toBe(d.tick);
    expect(Object.values(state.jobs).some((j) => j.kind === "resus")).toBe(false);
    expect(state.today.stats).toMatchObject({ deaths: 1, unexpectedDeaths: 0, complaints: 0 });
  });

  it("is verified, then last offices are done by two nurses with the room closed", () => {
    runUntil(state, () => d.verified !== null);
    const lastOffices = Object.values(state.jobs).filter((j) => j.kind === "last_offices");
    expect(lastOffices).toHaveLength(2);
    expect(holder(state, bed.id, 0)).toBe(p.id);
    runUntil(state, () => d.lastOffices !== null);
  });

  it("goes to the mortuary with a porter, and the bed is deep cleaned", () => {
    runUntil(state, () => p.stage === "in_mortuary");
    expect(mortuarySpaces(state).taken).toBe(1);
    expect(holder(state, bed.id, 0)).toBeUndefined();
    expect(state.dirt[bed.id]).toBe(1);
    const clean = Object.values(state.jobs).find(
      (j) => j.kind === "clean_cubicle" && j.objectId === bed.id,
    );
    expect(clean?.durationTicks ?? Infinity).toBeGreaterThanOrEqual(30 * MIN);
  });

  it("is reviewed by the Medical Examiner, then released to the funeral director", () => {
    runUntil(state, () => d.meReviewed !== null);
    expect(d.coroner).toBe(false);
    expect(d.releaseAt! - d.meReviewed!).toBeLessThanOrEqual(36 * HOUR);
    runUntil(state, () => !state.patients[p.id], 40 * HOUR);
    expect(mortuarySpaces(state).taken).toBe(0);
  });
});

describe("an expected death in an open bay", () => {
  it("brings a complaint about privacy", () => {
    const state = settled(staffedDeathsWard());
    const p = inpatient(state, bedIn(state, "ward"));
    p.endOfLife = true;
    p.stayUntil = state.tick + MIN;
    runUntil(state, () => p.stage === "deceased");
    expect(state.today.stats.complaints).toBe(1);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/open bay rather than a side room/);
  });
});

describe("an unexpected death", () => {
  it("has a doctor tell the family in the Relatives' Room", () => {
    const state = settled(staffedDeathsWard());
    const p = inpatient(state, bedIn(state, "ward"));
    die(state, p, false, true);
    const news = () => Object.values(state.jobs).find((j) => j.kind === "break_news");
    expect(news()).toBeDefined();
    runUntil(state, () => news()?.state === "working");
    const sofa = state.objects[news()!.objectId!]!;
    expect(sofa.defId).toBe("sofa");
    expect(holder(state, sofa.id, "staff")).toBe(news()!.staffId);
    runUntil(state, () => p.death!.familyTold !== null);
    expect(state.today.stats.complaints).toBe(0);
    expect(holder(state, sofa.id, "staff")).toBeUndefined();
  });

  it("without a Relatives' Room, the news is given in a corridor, and the family complain", () => {
    const state = settled(staffedDeathsWard(1, undefined, { relativesRoom: false }));
    const p = inpatient(state, bedIn(state, "ward"));
    die(state, p, false, true);
    runUntil(state, () => p.death!.familyTold !== null);
    expect(state.today.stats.complaints).toBe(1);
  });

  it("lowers the morale of the staff involved, which slowly recovers", () => {
    const state = settled(staffedDeathsWard());
    const team = Object.values(state.staff).filter((s) => s.role === "nurse");
    debrief(state, team, true);
    for (const s of team) {
      expect(s.morale).toBeLessThan(MORALE_START);
      expect(state.jobs[s.jobId!]?.kind).toBe("debrief");
    }
    runUntil(
      state,
      () => team.every((s) => s.jobId === null || state.jobs[s.jobId]?.kind !== "debrief"),
      HOUR,
    );
    const low = team[0]!.morale;
    for (let i = 0; i < 4 * HOUR; i++) tick(state);
    expect(team[0]!.morale).toBeGreaterThan(low);
  });
});

describe("when there's nowhere to go", () => {
  it("keeps the deceased in the bay without a mortuary, and records an incident", () => {
    const state = settled(staffedDeathsWard(1, undefined, { mortuary: false }));
    const bed = bedIn(state, "ward");
    const p = inpatient(state, bed);
    die(state, p, false, true);
    runUntil(state, () => p.death!.lastOffices !== null);
    for (let i = 0; i < HOUR; i++) tick(state);
    expect(p.stage).toBe("deceased");
    expect(holder(state, bed.id, 0)).toBe(p.id);
    expect(state.incidents.map((i) => i.summary)).toContain(
      "No mortuary space: a deceased patient kept in the bay",
    );
    const info = describePatient(state, p);
    expect(info.kind === "patient" && info.afterDeath).toContainEqual({
      label: "Taken to the mortuary",
      done: false,
      progress: "blocked",
    });
    expect(info.kind === "patient" && info.deathStatus).toEqual({
      step: "to_mortuary",
      progress: "blocked",
      reason: expect.stringMatching(/^No working Mortuary\. Contingency store in \dh \d+m$/),
    });
    // Hours later the contingency arrangement takes them, freeing the bed.
    runUntil(state, () => !state.patients[p.id], 8 * HOUR);
    expect(holder(state, bed.id, 0)).toBeUndefined();
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/contingency arrangements/);
  });

  it("can't release anyone without a Medical Examiner", () => {
    const state = settled(
      staffedDeathsWard(1, { nurse: 2, junior_doctor: 1, porter: 1, cleaner: 1 }),
    );
    const p = inpatient(state, bedIn(state, "ward"));
    die(state, p, false, true);
    runUntil(state, () => p.stage === "in_mortuary");
    for (let i = 0; i < 12 * HOUR; i++) tick(state);
    expect(p.death!.meReviewed).toBeNull();
    expect(state.patients[p.id]).toBeDefined();
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/no Medical Examiner/);
  });
});

describe("where things stand after a death", () => {
  it("says who is doing each step, and what's in the way", () => {
    const state = settled(staffedDeathsWard());
    const p = inpatient(state, bedIn(state, "ward"));
    die(state, p, false, false);
    expect(deathStatus(state, p)).toMatchObject({ step: "verify", progress: "waiting" });
    runUntil(state, () => deathStatus(state, p).progress === "underway");
    expect(deathStatus(state, p).reason).toMatch(/^Junior Doctor .+ (is on the way|is verifying)/);
    runUntil(state, () => p.stage === "to_mortuary");
    expect(deathStatus(state, p)).toMatchObject({
      step: "to_mortuary",
      progress: "underway",
      reason: expect.stringMatching(/^Porter .+ is taking them to the mortuary$/),
    });
    runUntil(state, () => p.death!.meReviewed !== null);
    expect(deathStatus(state, p)).toMatchObject({
      step: "release",
      reason: expect.stringMatching(/funeral director collects about Day \d+ \d\d:\d\d$/),
    });
  });

  it("is blocked without a porter", () => {
    const state = settled(staffedDeathsWard(1, { nurse: 2, junior_doctor: 1, cleaner: 1 }));
    const p = inpatient(state, bedIn(state, "ward"));
    die(state, p, true, true);
    runUntil(state, () => p.death!.lastOffices !== null);
    expect(deathStatus(state, p)).toMatchObject({
      step: "to_mortuary",
      progress: "blocked",
      reason: "No Porters on staff",
    });
  });

  it("is blocked when a trolley can't get to the mortuary", () => {
    const state = settled(staffedDeathsWard(1, undefined, { mortuaryDoor: "door_single" }));
    const p = inpatient(state, bedIn(state, "ward"));
    die(state, p, true, true);
    runUntil(state, () => p.death!.lastOffices !== null);
    for (let i = 0; i < 2 * MIN; i++) tick(state);
    expect(deathStatus(state, p)).toMatchObject({ step: "to_mortuary", progress: "blocked" });
    expect(deathStatus(state, p).reason).toMatch(/^No bed-width route/);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(/no bed-width route/);
  });
});
