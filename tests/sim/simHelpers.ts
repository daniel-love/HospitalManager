/**
 * Shared helpers for headless simulation tests: invariants that must always
 * hold, and a runner that checks them as it goes.
 */
import { expect } from "vitest";
import type { Patient } from "@sim/agents";
import { slotKey } from "@sim/places";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";

/** Everything that must always hold, as a list of problems (empty = fine). */
export function invariantProblems(state: SimState): string[] {
  const problems: string[] = [];
  const grid = state.floors[0]!;
  const agents = { ...state.patients, ...state.staff };
  for (const [key, id] of Object.entries(state.reserved)) {
    if (!agents[id]) problems.push(`reservation ${key} held by missing agent ${id}`);
  }
  for (const p of Object.values(state.patients)) {
    if (p.x < 0 || p.y < 0 || p.x > grid.width - 1 || p.y > grid.height - 1) {
      problems.push(`patient ${p.id} off the map`);
    }
    if (p.seat && state.reserved[slotKey(p.seat.objectId, p.seat.slot)] !== p.id) {
      problems.push(`patient ${p.id} sits in a seat it doesn't hold`);
    }
    if (p.bed !== null && state.reserved[slotKey(p.bed, 0)] !== p.id) {
      problems.push(`patient ${p.id} has a couch it doesn't hold`);
    }
    if (!Number.isFinite(p.mood) || p.mood < 0 || p.mood > 100) {
      problems.push(`patient ${p.id} mood ${p.mood}`);
    }
    if (p.stage === "collapsed") {
      const lead = Object.values(state.jobs).some(
        (j) => j.patientId === p.id && j.kind === "resus" && j.step === 0,
      );
      if (!lead) problems.push(`patient ${p.id} collapsed with no crash call`);
    }
    const t = p.times;
    const order = [t.arrived, t.booked, t.triaged, t.seen, t.left].filter((x) => x !== null);
    if (order.some((x, i) => i > 0 && x < order[i - 1]!)) {
      problems.push(`patient ${p.id} timeline out of order`);
    }
  }
  for (const job of Object.values(state.jobs)) {
    if (job.patientId !== null && !state.patients[job.patientId]) {
      problems.push(`job ${job.id} for missing patient`);
    }
    if (job.staffId !== null) {
      const s = state.staff[job.staffId];
      if (!s) problems.push(`job ${job.id} held by missing staff`);
      else if (s.jobId !== job.id) problems.push(`job ${job.id} / staff ${s.id} disagree`);
    }
    if ((job.state === "open") !== (job.staffId === null)) {
      problems.push(`job ${job.id} is ${job.state} with staff ${job.staffId}`);
    }
  }
  for (const s of Object.values(state.staff)) {
    if (s.jobId !== null && state.jobs[s.jobId]?.staffId !== s.id) {
      problems.push(`staff ${s.id} thinks it has job ${s.jobId}`);
    }
    if (s.desk !== null && state.reserved[slotKey(s.desk, "staff")] !== s.id) {
      problems.push(`staff ${s.id} at desk/station ${s.desk} it doesn't hold`);
    }
  }
  const parked = new Set<string>();
  for (const a of Object.values(state.ambulances)) {
    if (!a.space) continue;
    const key = `${a.space.x},${a.space.y}`;
    if (parked.has(key)) problems.push(`two ambulances parked at ${key}`);
    parked.add(key);
  }
  if (!Number.isFinite(state.money)) problems.push("money is not a number");
  return problems;
}

/** Runs `ticks`, checking invariants every 50 ticks; returns patients who left. */
export function run(state: SimState, ticks: number, onTick?: (s: SimState) => void): Patient[] {
  const left = new Map<number, Patient>();
  for (let i = 0; i < ticks; i++) {
    tick(state);
    onTick?.(state);
    for (const p of Object.values(state.patients)) {
      if (p.stage === "leaving" && !left.has(p.id)) left.set(p.id, structuredClone(p));
    }
    if (i % 50 === 0) expect(invariantProblems(state)).toEqual([]);
  }
  return [...left.values()];
}
