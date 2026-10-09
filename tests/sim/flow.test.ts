/**
 * Headless simulation of the small A&E (ROADMAP M2 "done when"): patients
 * flow end to end, money changes, and an understaffed or under-seated A&E
 * visibly struggles. Invariants are checked throughout.
 */
import { describe, expect, it } from "vitest";
import { conditionById } from "@data/catalogue";
import { applyCommand } from "@sim/commands";
import { net, type Patient } from "@sim/agents";
import { createSimState, type SimState } from "@sim/state";
import { TOILET_USES_BEFORE_CLEAN } from "@data/patients";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";
import { SMALL_AE_TEAM, staffedSmallAE } from "../fixtures/smallAE";
import { run } from "./simHelpers";

const HOUR = TICKS_PER_MINUTE * 60;

describe("a staffed small A&E over 24 hours", () => {
  const state = staffedSmallAE(3);
  const startMoney = state.money;
  const departed = run(state, TICKS_PER_DAY);
  const day1 = state.history[0]!;

  it("files a daily report at midnight", () => {
    expect(state.history).toHaveLength(1);
    expect(day1.day).toBe(1);
  });

  it("sees patients through every step to discharge", () => {
    expect(day1.stats.arrivals).toBeGreaterThan(25);
    const discharged = departed.filter((p) => p.outcome === "discharged");
    expect(discharged.length).toBeGreaterThan(20);
    for (const p of discharged) {
      expect(p.category).toBe(conditionById.get(p.conditionId)!.acuity);
      expect(p.times.booked).not.toBeNull();
      expect(p.times.triaged).not.toBeNull();
      expect(p.times.seen).not.toBeNull();
      expect(p.step).toBe(conditionById.get(p.conditionId)!.pathway.length);
    }
  });

  it("earns tariff income and pays salaries and upkeep", () => {
    const { tariff, salaries, upkeep } = state.history[0]!.ledger;
    expect(tariff).toBeGreaterThan(0);
    expect(salaries).toBeGreaterThan(0);
    expect(upkeep).toBeGreaterThan(0);
    expect(state.money).not.toBe(startMoney);
    // The day's ledger accounts for every pound (plus today's few hours so far).
    const moved = net(state.history[0]!.ledger) + net(state.today.ledger);
    expect(state.money - startMoney).toBeCloseTo(moved, 6);
  });

  it("keeps most patients rather than losing them", () => {
    expect(day1.stats.lwbs).toBeLessThan(day1.stats.discharged / 2);
  });

  it("is deterministic", () => {
    const again = staffedSmallAE(3);
    run(again, TICKS_PER_DAY);
    expect(again.history).toEqual(state.history);
    expect(again.rng).toEqual(state.rng);
  });
});

describe("draining the department", () => {
  it("lets everyone out once arrivals stop, with nothing left reserved", () => {
    const state = staffedSmallAE(5);
    run(state, 12 * HOUR);
    expect(Object.keys(state.patients).length).toBeGreaterThan(0);
    state.settings.patientVolume = 0;
    run(state, TICKS_PER_DAY);
    expect(Object.values(state.patients)).toEqual([]);
    expect(Object.values(state.jobs)).toEqual([]);
    // Only the receptionist's chair behind the desk is still claimed.
    expect(Object.keys(state.reserved)).toHaveLength(1);
    // Cubicles are all clean; toilets may carry a few uses short of needing a clean.
    for (const [id, dirt] of Object.entries(state.dirt)) {
      expect(state.objects[Number(id)]!.defId).toBe("toilet");
      expect(dirt).toBeLessThan(TOILET_USES_BEFORE_CLEAN);
    }
  });
});

describe("an A&E that struggles", () => {
  const day = (team: Parameters<typeof staffedSmallAE>[1], seed = 11) => {
    const state = staffedSmallAE(seed, team);
    run(state, TICKS_PER_DAY);
    return { state, stats: state.history[0]!.stats };
  };
  const full = day(SMALL_AE_TEAM);

  it("treats no one without a doctor, and patients give up", () => {
    const { state, stats } = day({ ...SMALL_AE_TEAM, junior_doctor: 0 });
    expect(stats.discharged).toBe(0);
    expect(stats.lwbs).toBeGreaterThan(5);
    expect(state.history[0]!.ledger.tariff).toBe(0);
  });

  it("explains itself in the notifications", () => {
    const state = staffedSmallAE(11, { ...SMALL_AE_TEAM, junior_doctor: 0 });
    run(state, 8 * HOUR);
    expect(state.events.map((e) => e.text).join("\n")).toMatch(
      /doctor assessment, but you have no Junior Doctors/,
    );
  });

  it("takes far longer to triage with one nurse", () => {
    const { stats } = day({ ...SMALL_AE_TEAM, nurse: 1 });
    const avg = (s: typeof stats) => s.triageWaitMins / s.triaged;
    expect(avg(stats)).toBeGreaterThan(avg(full.stats) * 1.5);
  });

  it("leaves patients standing when the waiting area has too few seats", () => {
    const standingTicks = (state: SimState) => {
      let n = 0;
      run(state, TICKS_PER_DAY, (s) => {
        for (const p of Object.values(s.patients)) {
          if (p.stage.startsWith("waiting") && !p.seat && !p.toilet) n++;
        }
      });
      return n;
    };
    // A quieter day, so that with seats nearly everyone can sit.
    const seated = staffedSmallAE(11);
    // Selling a bench drops the waiting area below its 6 seats, so it stops working.
    const cramped = staffedSmallAE(11);
    seated.settings.patientVolume = cramped.settings.patientVolume = 0.4;
    const bench = Object.values(cramped.objects).find((o) => o.defId === "waiting_bench")!;
    expect(applyCommand(cramped, { type: "remove_object", floor: 0, id: bench.id }).ok).toBe(true);
    expect(standingTicks(cramped)).toBeGreaterThan(standingTicks(seated) * 10);
  });

  it("stops cubicles being reused when there's no cleaner", () => {
    const { stats } = day({ ...SMALL_AE_TEAM, cleaner: 0 });
    // Each cubicle treats one patient, then sits dirty.
    expect(stats.discharged).toBeLessThanOrEqual(2);
  });
});

describe("disruption", () => {
  it("puts a dismissed clinician's job back on the board", () => {
    const state = staffedSmallAE(3);
    let checked = false;
    run(state, 12 * HOUR, (s) => {
      if (checked) return;
      const job = Object.values(s.jobs).find((j) => j.kind === "treat" && j.state === "working");
      if (!job) return;
      expect(applyStaffCommand(s, { type: "dismiss_staff", id: job.staffId! }).ok).toBe(true);
      expect(s.jobs[job.id]).toMatchObject({ state: "open", staffId: null, progress: 0 });
      expect(s.jobs[job.id]!.objectId).not.toBeNull();
      checked = true;
    });
    expect(checked).toBe(true);
  });

  it("sends a patient back to wait when their cubicle's couch is sold", () => {
    const state = staffedSmallAE(3);
    let patient: Patient | undefined;
    run(state, 12 * HOUR, (s) => {
      if (patient) return;
      patient = Object.values(s.patients).find((p) => p.stage === "in_cubicle");
      if (!patient) return;
      const bed = patient.bed!;
      expect(applyCommand(s, { type: "remove_object", floor: 0, id: bed }).ok).toBe(true);
    });
    expect(patient).toBeDefined();
    const p = state.patients[patient!.id];
    // Either still waiting for a cubicle, or since treated and gone.
    if (p) expect(p.bed === null || p.bed !== patient!.bed).toBe(true);
  });

  it("copes with hiring before anything is built", () => {
    const state = createSimState({ seed: 1, width: 30, height: 30 });
    applyStaffCommand(state, { type: "hire_staff", role: "receptionist" });
    applyStaffCommand(state, { type: "hire_staff", role: "nurse" });
    expect(() => run(state, HOUR)).not.toThrow();
    expect(Object.keys(state.patients)).toHaveLength(0);
  });
});
