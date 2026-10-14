/**
 * Visiting (GAME_DESIGN §8.4): relatives and friends come to see ward
 * patients during visiting hours, a hospital policy. Each day most
 * inpatients get a visitor, who walks in from the entrance, sits with them
 * a while, and goes home by the time visiting ends. Being visited keeps an
 * inpatient's spirits up: their mood settles higher, and lifts while
 * someone's with them (systems/patients.ts), which shows in reputation
 * (systems/reputation.ts). Open visiting does that best; no visiting, as in
 * an outbreak, leaves patients lonelier.
 */
import { FIRST_NAMES, SURNAMES } from "@data/names";
import type { Patient, Visitor } from "../agents";
import { bedside, fallbackEntrance, siteEntrance } from "../places";
import { chance, nextInt, pick } from "../rng";
import type { SimState, Visiting } from "../state";
import { clockFromTick, tickAt, TICKS_PER_DAY, TICKS_PER_MINUTE } from "../time";
import { headTo } from "./movement";

/** Visiting windows for each policy, in minutes after midnight, and how long visits last. */
export const VISITING: Record<
  Visiting,
  { windows: [number, number][]; mins: [number, number]; label: string }
> = {
  open: { windows: [[8 * 60, 20 * 60]], mins: [45, 120], label: "Open, 08:00 to 20:00" },
  set: {
    windows: [
      [14 * 60, 16 * 60],
      [18 * 60, 20 * 60],
    ],
    mins: [30, 90],
    label: "Set hours, 14:00 to 16:00 and 18:00 to 20:00",
  },
  restricted: {
    windows: [[18 * 60, 19 * 60]],
    mins: [30, 50],
    label: "Restricted, 18:00 to 19:00",
  },
  none: { windows: [], mins: [0, 0], label: "No visiting" },
};

/** Share of inpatients who get a visitor each day. */
export const VISIT_SHARE = 0.8;

/** Whether a patient is on a ward and could be visited now. */
const visitable = (p: Patient) => p.stage === "on_ward" && !p.death && p.bed !== null;

/** The visiting window under way now, or null. */
function windowNow(state: SimState): [number, number] | null {
  const c = clockFromTick(state.tick);
  const m = c.hour * 60 + c.minute;
  return VISITING[state.policies.visiting].windows.find(([a, b]) => m >= a && m < b) ?? null;
}

/** Whether someone is with this patient now. */
export function hasVisitor(state: SimState, patientId: number): boolean {
  return Object.values(state.visitors).some(
    (v) => v.patientId === patientId && v.stage === "visiting",
  );
}

export function updateVisitors(state: SimState): void {
  for (const v of Object.values(state.visitors)) moveVisitor(state, v);
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const window = windowNow(state);
  if (!window) return;
  const c = clockFromTick(state.tick);
  const windowMins = VISITING[state.policies.visiting].windows.reduce((n, [a, b]) => n + b - a, 0);
  const today = tickAt(c.day, 0);
  const coming = new Set(Object.values(state.visitors).map((v) => v.patientId));
  for (const p of Object.values(state.patients)) {
    if (!visitable(p) || coming.has(p.id)) continue;
    if (p.lastVisit !== null && p.lastVisit >= today) continue; // Visited already today.
    // A steady chance each minute that adds up to VISIT_SHARE over the day's visiting.
    if (!chance(state.rng, -Math.log(1 - VISIT_SHARE) / windowMins)) continue;
    const end = today + window[1] * TICKS_PER_MINUTE;
    const [lo, hi] = VISITING[state.policies.visiting].mins;
    const stay = nextInt(state.rng, lo, hi) * TICKS_PER_MINUTE;
    const at = siteEntrance(state) ?? fallbackEntrance(state);
    const v: Visitor = {
      id: state.nextAgentId++,
      name: `${pick(state.rng, FIRST_NAMES)} ${pick(state.rng, SURNAMES)}`,
      x: at.x,
      y: at.y,
      prevX: at.x,
      prevY: at.y,
      path: [],
      dest: null,
      pathVersion: state.layoutVersion,
      patientId: p.id,
      stage: "arriving",
      until: Math.min(end, state.tick + stay + 20 * TICKS_PER_MINUTE),
    };
    state.visitors[v.id] = v;
    p.lastVisit = state.tick;
  }
}

function moveVisitor(state: SimState, v: Visitor): void {
  const p = state.patients[v.patientId];
  const gone = !p || !visitable(p);
  if (v.stage !== "leaving" && (gone || state.tick >= v.until || !windowNow(state))) {
    v.stage = "leaving";
  }
  if (v.stage === "leaving") {
    const exit = siteEntrance(state) ?? fallbackEntrance(state);
    const arrival = headTo(state, v, exit);
    if (arrival === "arrived" || arrival === "no_route") delete state.visitors[v.id];
    return;
  }
  const bed = state.objects[p!.bed!];
  if (!bed) return;
  const arrival = headTo(state, v, bedside(state, bed));
  if (arrival === "arrived") v.stage = "visiting";
  else if (arrival === "no_route") v.stage = "leaving";
}

/** Recently visited (within a day): an inpatient settles better. */
export function visitedLately(state: SimState, p: Patient): boolean {
  return p.lastVisit !== null && state.tick - p.lastVisit < TICKS_PER_DAY;
}
