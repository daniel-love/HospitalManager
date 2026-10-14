/**
 * Industrial action (GAME_DESIGN §9): a staff group strikes for a few days,
 * with two weeks' notice (systems/pressure.ts runs the calendar). In a
 * walkout, its members don't come in for their shifts and aren't paid for
 * them, except a share kept at work by derogations (life-preserving care).
 * Bank and agency staff can't be used to cover strikers. Consultants strike
 * with "Christmas Day cover": emergencies, but no clinics or planned lists.
 * In a resident doctors' strike, consultants act down to do their work, at
 * a premium, and on-call consultants come in for it.
 */
import { pressureEventById, STRIKES, type StrikeDef } from "@data/pressure";
import type { StaffRoleId } from "@data/schema";
import { onSite, type Job, type Staff } from "../agents";
import type { SimState } from "../state";
import { tickAt } from "../time";

/** Strikes under way now. */
export function strikesUnderWay(state: SimState): StrikeDef[] {
  const out: StrikeDef[] = [];
  for (const e of state.pressure.active) {
    const strike = pressureEventById.get(e.defId)!.strike;
    if (strike && state.tick >= e.start && state.tick < e.end) out.push(strike);
  }
  return out;
}

/** A role walked out today (so its gaps aren't filled by bank or agency staff). */
export function roleOnStrike(state: SimState, role: StaffRoleId): boolean {
  return strikesUnderWay(state).some((s) => s.mode === "walkout" && s.roles.includes(role));
}

/**
 * Kept at work by the derogations: a steady share of each group, the same
 * people each day (a stable hash of their id).
 */
function derogated(s: Staff, share: number): boolean {
  if (share <= 0) return false;
  return ((Math.imul(s.id, 2654435761) >>> 0) % 1000) / 1000 < share;
}

/** On strike: in a walkout covering their role, and not kept at work by derogations. */
export function isStriking(state: SimState, s: Staff): boolean {
  if (s.contract !== "resident" && s.contract !== "on_call") return false;
  return strikesUnderWay(state).some(
    (k) => k.mode === "walkout" && k.roles.includes(s.role) && !derogated(s, k.derogation),
  );
}

/**
 * Consultants on strike that day, with Christmas Day cover: no clinics or
 * planned lists. Known from the notice, so planned care is rebooked ahead.
 */
export function consultantsOnStrikeOn(state: SimState, day: number): boolean {
  const from = tickAt(day, 8);
  const to = tickAt(day, 18);
  return state.pressure.active.some((e) => {
    const k = pressureEventById.get(e.defId)!.strike;
    return (
      k?.mode === "planned_only" &&
      k.roles.includes("consultant") &&
      e.announced <= state.tick &&
      e.start < to &&
      e.end > from
    );
  });
}

/** Resident doctors on strike: consultants act down to cover their work. */
export function residentDoctorsOnStrike(state: SimState): boolean {
  return roleOnStrike(state, "junior_doctor");
}

/** A consultant covering a striking resident doctor's job. */
export function canActDown(state: SimState, s: Staff, job: Job): boolean {
  if (s.role !== "consultant" || s.contract === "privileges") return false;
  if (!job.roles.includes("junior_doctor") && !job.roles.includes("registrar")) return false;
  if (job.specialty !== null && s.specialty !== job.specialty) return false;
  return residentDoctorsOnStrike(state);
}

/** The rate-card premium for a consultant on site for the hour, covering a strike. */
export function actingDownPay(state: SimState, s: Staff): number {
  if (s.role !== "consultant" || s.contract === "privileges" || !onSite(s)) return 0;
  return residentDoctorsOnStrike(state) ? STRIKES.actingDownHourly : 0;
}

/** For the Events tab: how many are out, and how many still at work under derogations. */
export function strikeCounts(state: SimState, strike: StrikeDef): { out: number; working: number } {
  let out = 0;
  let working = 0;
  for (const s of Object.values(state.staff)) {
    if (!strike.roles.includes(s.role)) continue;
    if (s.contract !== "resident" && s.contract !== "on_call") continue;
    if (derogated(s, strike.derogation)) working++;
    else out++;
  }
  return { out, working };
}
