/**
 * Escalation and hospital policies (ROADMAP M5 step 6): escalation
 * trolleys and the OPEL level, discharge before noon, and visiting hours.
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import { applyCommand } from "@sim/commands";
import { reserve, siteEntrance, fallbackEntrance } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { claimWardBed } from "@sim/systems/admissions";
import { newPatient } from "@sim/systems/arrivals";
import { isEscalationBed, opel, patientsInEscalation } from "@sim/systems/escalation";
import { postJob } from "@sim/systems/jobBoard";
import { updateReputation } from "@sim/systems/reputation";
import { emptyStats, type Patient } from "@sim/agents";
import { tickAt, TICKS_PER_MINUTE } from "@sim/time";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;
import { buildMajorsAE } from "../fixtures/majorsAE";

/** The majors A&E with its six-bed ward and an escalation trolley in the ward. */
function wardWithTrolley(): SimState {
  const state = buildMajorsAE(1, { ward: "door_double" });
  state.settings.patientVolume = 0;
  const r = applyCommand(state, {
    type: "place_object",
    floor: 0,
    defId: "escalation_trolley",
    x: 3,
    y: 22,
    rotation: 0,
  });
  expect(r.ok).toBe(true);
  return state;
}

const wardBeds = (state: SimState) =>
  Object.values(state.objects).filter((o) => o.defId === "hospital_bed");

/** An admitted patient waiting in A&E for a bed, and the porter's transfer job. */
function waitingForBed(state: SimState): { p: Patient; job: ReturnType<typeof postJob> } {
  const at = siteEntrance(state) ?? fallbackEntrance(state);
  const p = newPatient(state, { x: 12, y: 20 }, conditionById.get("chest_pain")!, "awaiting_bed");
  void at;
  state.patients[p.id] = p;
  const job = postJob(state, {
    kind: "transfer",
    roles: ["porter"],
    patientId: p.id,
    roomType: "ward",
    capabilities: ["inpatient_bed"],
    dueTick: state.tick,
    durationTicks: 1,
  });
  return { p, job };
}

describe("escalation trolleys", () => {
  it("are never an ordinary bed", () => {
    expect(isEscalationBed("escalation_trolley")).toBe(true);
    expect(isEscalationBed("hospital_bed")).toBe(false);
  });

  it("take an admitted patient only with every ward bed full and escalation open", () => {
    const state = wardWithTrolley();
    for (const b of wardBeds(state)) reserve(state, b.id, 0, 99_999);
    const { job } = waitingForBed(state);
    expect(claimWardBed(state, job)).toBeNull();
    state.policies.escalation = true;
    expect(claimWardBed(state, job)).not.toBeNull();
    expect(isEscalationBed(state.objects[job.objectId!]!.defId)).toBe(true);
  });

  it("prefer a real ward bed when there's one", () => {
    const state = wardWithTrolley();
    state.policies.escalation = true;
    const { job } = waitingForBed(state);
    claimWardBed(state, job);
    expect(state.objects[job.objectId!]!.defId).toBe("hospital_bed");
  });

  it("cost reputation for each patient on one at midnight", () => {
    const score = (onTrolley: boolean) => {
      const state = wardWithTrolley();
      const trolley = Object.values(state.objects).find((o) => isEscalationBed(o.defId))!;
      const bed = wardBeds(state)[0]!;
      const { p } = waitingForBed(state);
      p.stage = "on_ward";
      p.bed = onTrolley ? trolley.id : bed.id;
      expect(patientsInEscalation(state)).toBe(onTrolley ? 1 : 0);
      updateReputation(state, emptyStats());
      return state.reputation;
    };
    expect(score(true)).toBeLessThan(score(false));
  });

  it("show in the OPEL level with ward beds full and patients waiting", () => {
    const state = wardWithTrolley();
    expect(opel(state).level).toBe(1);
    for (const b of wardBeds(state)) reserve(state, b.id, 0, 99_999);
    for (let i = 0; i < 5; i++) waitingForBed(state);
    const o = opel(state);
    expect(o.level).toBeGreaterThanOrEqual(3);
    expect(o.drivers.length).toBeGreaterThan(0);
  });
});

/** A patient settled in a ward bed, fit to go home at `until`. */
function onWard(state: SimState, until: number): Patient {
  const bed = wardBeds(state)[0]!;
  const p = newPatient(state, { x: bed.x, y: bed.y }, conditionById.get("chest_pain")!, "on_ward");
  state.patients[p.id] = p;
  reserve(state, bed.id, 0, p.id);
  p.bed = bed.id;
  p.stayUntil = until;
  return p;
}

const discharges = (state: SimState, p: Patient) =>
  Object.values(state.jobs).filter((j) => j.patientId === p.id && j.kind === "ward_discharge");

describe("discharge before noon", () => {
  it("reviews patients fit to go later today in the morning", () => {
    for (const on of [false, true]) {
      const state = wardWithTrolley();
      state.policies.dischargeBeforeNoon = on;
      while (state.tick < tickAt(2, 8, 30)) tick(state);
      const p = onWard(state, tickAt(2, 17, 0));
      for (let i = 0; i < TICKS_PER_HOUR; i++) tick(state);
      expect(discharges(state, p).length > 0 || p.stage !== "on_ward").toBe(on);
    }
  });
});

describe("visiting hours", () => {
  it("bring visitors to ward patients, which lifts their mood", () => {
    const state = wardWithTrolley();
    state.policies.visiting = "open";
    const p = onWard(state, tickAt(9, 0));
    p.mood = 50;
    let visited = false;
    while (state.tick < tickAt(1, 20, 0) && !visited) {
      tick(state);
      visited = Object.values(state.visitors).some((v) => v.stage === "visiting");
    }
    expect(visited).toBe(true);
    expect(p.lastVisit).not.toBeNull();
    for (let i = 0; i < TICKS_PER_HOUR; i++) tick(state);
    expect(p.mood).toBeGreaterThan(50);
  });

  it("bring nobody with no visiting", () => {
    const state = wardWithTrolley();
    state.policies.visiting = "none";
    onWard(state, tickAt(9, 0));
    while (state.tick < tickAt(1, 20, 0)) tick(state);
    expect(Object.keys(state.visitors).length).toBe(0);
  });
});
