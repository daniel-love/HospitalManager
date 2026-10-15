/**
 * Grants and investment (GAME_DESIGN §8.1): challenges with money attached.
 * Every few weeks one is offered, at random among those that fit the
 * hospital (its funding model, what it's built, and what it still needs to
 * improve), for two weeks. Taken on, the money arrives at once; meet its
 * condition by the deadline and it's kept (and reputation rises a little),
 * miss it and it's clawed back (and reputation falls). A few can run at once.
 */
import { GRANT_OFFERS, GRANTS, type GrantCondition, type GrantDef } from "@data/finance";
import { RTT_TARGET_DAYS } from "@data/outpatients";
import type { Grant } from "../agents";
import { emit } from "../events";
import { nextInt, pick } from "../rng";
import type { SimState } from "../state";
import { TICKS_PER_DAY } from "../time";

export const grantById = new Map(GRANTS.map((g) => [g.id, g]));

const valid = (state: SimState, type: string) =>
  state.rooms.filter((r) => r.valid && r.typeId === type).length;

/** Inpatient beds on working wards and side rooms. */
function beds(state: SimState): number {
  let n = 0;
  for (const r of state.rooms) {
    if (!r.valid || (r.typeId !== "ward" && r.typeId !== "side_room")) continue;
    for (const id of r.objectIds) {
      const d = state.objects[id]?.defId;
      if (d === "hospital_bed" || d === "profiling_bed") n++;
    }
  }
  return n;
}

const lastDays = (state: SimState, days: number) => state.history.slice(-days);

/** How far the hospital is towards a condition now: 0 to 1 (1 met), and a line saying so. */
export function progress(state: SimState, g: Grant): { share: number; text: string } {
  const c = grantById.get(g.defId)!.condition;
  const week = lastDays(state, 7);
  const sum = (f: (d: (typeof week)[number]) => number) => week.reduce((n, d) => n + f(d), 0);
  const ratio = (have: number, want: number) => (want <= 0 ? 1 : Math.min(1, have / want));
  switch (c.kind) {
    case "rooms": {
      const have = valid(state, c.room);
      return { share: ratio(have, g.target!), text: `${have} of ${g.target}` };
    }
    case "beds": {
      const have = beds(state);
      return { share: ratio(have, g.target!), text: `${have} of ${g.target} beds` };
    }
    case "ct": {
      const ok = valid(state, "ct_room") > 0 && staffed(state, "radiographer");
      return {
        share: ok ? 1 : 0,
        text: ok ? "CT working" : "No working CT Room with a radiographer",
      };
    }
    case "operations": {
      const have = sum((d) => d.stats.electiveOps);
      return { share: ratio(have, c.perWeek), text: `${have} of ${c.perWeek} this week` };
    }
    case "appointments": {
      const have = sum((d) => d.stats.firstAppointments + d.stats.followUps);
      return { share: ratio(have, c.perWeek), text: `${have} of ${c.perWeek} this week` };
    }
    case "fourHour": {
      const dep = sum((d) => d.stats.departures);
      const share = dep > 0 ? sum((d) => d.stats.within4h) / dep : 0;
      return {
        share: share >= c.atLeast ? 1 : ratio(share, c.atLeast),
        text: `${Math.round(share * 100)}% this week (need ${Math.round(c.atLeast * 100)}%)`,
      };
    }
    case "noTrolleyWaits": {
      const fortnight = lastDays(state, 14);
      const waits = fortnight.reduce((n, d) => n + d.stats.bedWaitsOver12h, 0);
      const full = fortnight.length >= 14;
      return {
        share: waits === 0 && full ? 1 : 0,
        text: waits > 0 ? `${waits} in the last fortnight` : "None so far",
      };
    }
    case "rtt": {
      let pathways = 0;
      let within = 0;
      for (const r of Object.values(state.referrals)) {
        if (r.clockStart === null || r.payer !== "nhs") continue;
        pathways++;
        if (state.tick - r.clockStart < RTT_TARGET_DAYS * TICKS_PER_DAY) within++;
      }
      const share = pathways > 0 ? within / pathways : 0;
      return {
        share: share >= c.atLeast ? 1 : ratio(share, c.atLeast),
        text: `${Math.round(share * 100)}% (need ${Math.round(c.atLeast * 100)}%)`,
      };
    }
    case "morale": {
      const staff = Object.values(state.staff).filter((s) => s.contract === "resident");
      const avg = staff.length > 0 ? staff.reduce((n, s) => n + s.morale, 0) / staff.length : 0;
      return {
        share: avg >= c.atLeast ? 1 : ratio(avg, c.atLeast),
        text: `Average ${Math.round(avg)} (need ${c.atLeast})`,
      };
    }
    case "privateIncome": {
      const have = sum((d) => d.ledger.private);
      return {
        share: ratio(have, c.perWeek),
        text: `£${Math.round(have / 1000)}k of £${Math.round(c.perWeek / 1000)}k this week`,
      };
    }
  }
}

function staffed(state: SimState, role: string): boolean {
  return Object.values(state.staff).some((s) => s.role === role && s.contract === "resident");
}

/** Whether a grant fits the hospital now: its model, something to build on, room to improve. */
function fits(state: SimState, def: GrantDef): boolean {
  if (!def.funding.includes(state.funding)) return false;
  const g = state.grants;
  if (g.active.some((a) => a.defId === def.id)) return false;
  const c: GrantCondition = def.condition;
  const week = lastDays(state, 7);
  switch (c.kind) {
    case "rooms":
      return c.room === "side_room" || valid(state, c.room) > 0;
    case "beds":
      return valid(state, "ward") > 0;
    case "ct":
      return valid(state, "ct_room") === 0 && valid(state, "xray_room") > 0;
    case "operations":
      return valid(state, "theatre") > 0 && progressOf(state, def) < 1;
    case "appointments":
      return valid(state, "outpatient_clinic") > 0 && progressOf(state, def) < 1;
    case "fourHour":
      return week.some((d) => d.stats.departures > 0) && progressOf(state, def) < 1;
    case "noTrolleyWaits":
      return lastDays(state, 14).some((d) => d.stats.bedWaitsOver12h > 0);
    case "rtt":
      return (
        Object.values(state.referrals).some((r) => r.payer === "nhs" && r.clockStart !== null) &&
        progressOf(state, def) < 1
      );
    case "morale":
      return Object.keys(state.staff).length >= 10 && progressOf(state, def) < 1;
    case "privateIncome":
      return progressOf(state, def) < 1;
  }
}

function progressOf(state: SimState, def: GrantDef): number {
  return progress(state, {
    defId: def.id,
    offered: state.tick,
    until: state.tick,
    target: target(state, def),
  }).share;
}

/** For rooms and beds: how many the hospital will need, counted now. */
function target(state: SimState, def: GrantDef): number | null {
  const c = def.condition;
  if (c.kind === "rooms") return valid(state, c.room) + c.add;
  if (c.kind === "beds") return beds(state) + c.add;
  return null;
}

/** At midnight: offers come and lapse, and grants taken on are met or missed. */
export function updateGrants(state: SimState): void {
  const g = state.grants;
  if (g.offer && state.tick >= g.offer.until) g.offer = null;
  for (const a of [...g.active]) {
    if (progress(state, a).share >= 1) finishGrant(state, a, true);
    else if (state.tick >= a.until) finishGrant(state, a, false);
  }
  if (g.offer || state.tick < g.nextOffer) return;
  const [lo, hi] = GRANT_OFFERS.everyDays;
  // Funders come sooner to a well-rated hospital, later to a poorly rated one.
  const rated = state.cqc.overall;
  const pace = rated ? GRANT_OFFERS.ratingPace[rated] : 1;
  g.nextOffer = state.tick + Math.round(nextInt(state.rng, lo, hi) * pace) * TICKS_PER_DAY;
  if (g.active.length >= GRANT_OFFERS.maxActive) return;
  // Nobody funds a hospital rated Inadequate, or in special measures.
  if (rated === "inadequate" || state.cqc.specialMeasures) return;
  const options = GRANTS.filter((d) => fits(state, d));
  if (options.length === 0) return;
  const def = pick(state.rng, options);
  g.offer = {
    defId: def.id,
    offered: state.tick,
    until: state.tick + GRANT_OFFERS.openDays * TICKS_PER_DAY,
    target: target(state, def),
  };
  emit(
    state,
    `${def.funder} offers ${pounds(def.amount)}: ${def.name}. ${def.description} See Finance → Grants (open for ${GRANT_OFFERS.openDays} days).`,
    "info",
    undefined,
    undefined,
    "grants",
  );
}

/** Takes on the grant on offer: the money arrives now. */
export function acceptGrant(state: SimState): string | null {
  const g = state.grants;
  const offer = g.offer;
  if (!offer) return "Nothing's on offer";
  if (g.active.length >= GRANT_OFFERS.maxActive) {
    return `At most ${GRANT_OFFERS.maxActive} grants at once`;
  }
  const def = grantById.get(offer.defId)!;
  g.offer = null;
  g.active.push({
    ...offer,
    offered: state.tick,
    until: state.tick + def.weeks * 7 * TICKS_PER_DAY,
  });
  state.money += def.amount;
  state.month.flows.grants += def.amount;
  return null;
}

/** Turns down the grant on offer. */
export function declineGrant(state: SimState): void {
  state.grants.offer = null;
}

function finishGrant(state: SimState, a: Grant, met: boolean): void {
  const g = state.grants;
  const def = grantById.get(a.defId)!;
  g.active = g.active.filter((x) => x !== a);
  g.done.push({ defId: a.defId, tick: state.tick, met });
  if (g.done.length > 20) g.done.shift();
  if (met) {
    state.reputation = Math.min(100, state.reputation + GRANT_OFFERS.reputationMet);
    emit(
      state,
      `${def.name}: condition met. The ${pounds(def.amount)} is the hospital's to keep.`,
      "info",
      undefined,
      undefined,
      "grants",
    );
    return;
  }
  state.money -= def.amount;
  state.month.flows.clawedBack += def.amount;
  state.reputation = Math.max(0, state.reputation - GRANT_OFFERS.reputationMissed);
  emit(
    state,
    `${def.name}: the deadline passed without the condition met, so ${def.funder} has taken back ${pounds(def.amount)}.`,
    "bad",
    undefined,
    undefined,
    "grants",
  );
}

const pounds = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);
