/**
 * Reputation (GAME_DESIGN §10): what patients and GPs think of the
 * hospital, 0–100. Each day gets a patient-experience score from how it
 * went, and reputation is a running average of those over about a month
 * (REPUTATION.smoothingDays), so one bad night dents it and a bad month
 * sinks it. Private demand follows it (systems/referrals.ts); M6 adds
 * ratings and inspections on top.
 *
 * A day's score averages what the hospital did that day:
 * - A&E: the share leaving within 4 hours, and the share not leaving unseen;
 * - planned care: appointments and operations that went ahead rather than
 *   being cancelled by the hospital;
 * - waiting lists: NHS patients within 18 weeks;
 * less penalties for unexpected deaths, safety incidents and complaints. A
 * day with nothing to judge leaves reputation where it is.
 */
import { REPUTATION } from "@data/economy";
import { RTT_TARGET_DAYS } from "@data/outpatients";
import type { FlowStats } from "../agents";
import type { SimState } from "../state";
import { TICKS_PER_DAY } from "../time";

/** A day's patient-experience score, 0–100, or null if there was nothing to judge. */
export function dayScore(state: SimState, s: FlowStats): number | null {
  const parts: { score: number; weight: number }[] = [];
  if (s.departures > 0) {
    const within = s.within4h / s.departures;
    const seen = 1 - s.lwbs / Math.max(1, s.departures);
    parts.push({ score: 100 * (0.7 * within + 0.3 * seen), weight: 2 });
  }
  const planned = s.firstAppointments + s.followUps + s.electiveOps;
  const cancelled = s.clinicCancellations + s.cancelledOnDay;
  if (planned + cancelled > 0) {
    parts.push({ score: (100 * planned) / (planned + cancelled), weight: 1 });
  }
  let pathways = 0;
  let within = 0;
  for (const r of Object.values(state.referrals)) {
    if (r.clockStart === null || r.payer !== "nhs") continue;
    pathways++;
    if (state.tick - r.clockStart < RTT_TARGET_DAYS * TICKS_PER_DAY) within++;
  }
  if (pathways > 0) parts.push({ score: (100 * within) / pathways, weight: 1 });
  if (parts.length === 0) return null;
  const weights = parts.reduce((n, p) => n + p.weight, 0);
  const score = parts.reduce((n, p) => n + p.score * p.weight, 0) / weights;
  const penalty = Math.min(
    REPUTATION.maxPenalty,
    s.unexpectedDeaths * REPUTATION.unexpectedDeath +
      s.incidents * REPUTATION.incident +
      s.complaints * REPUTATION.complaint,
  );
  return Math.max(0, score - penalty);
}

/** Points off the day's score for departments that aren't fully open. */
export function statusPenalty(state: SimState): number {
  const d = state.departments;
  const p = REPUTATION.status;
  return (
    (d.ae === "open" ? 0 : p.ae[d.ae]) +
    (d.outpatients === "open" ? 0 : p.outpatients[d.outpatients]) +
    (d.theatres === "open" ? 0 : p.theatres[d.theatres])
  );
}

/**
 * At midnight: the day's score moves reputation along its running average.
 * Departments not fully open count against it even on a day with nothing
 * else to judge.
 */
export function updateReputation(state: SimState, s: FlowStats): void {
  const penalty = statusPenalty(state);
  const day = dayScore(state, s);
  if (day === null && penalty === 0) return;
  const score = Math.max(0, (day ?? state.reputation) - penalty);
  state.reputation += (score - state.reputation) / REPUTATION.smoothingDays;
  state.reputation = Math.max(0, Math.min(100, state.reputation));
}

/** How private demand scales with reputation: ×1 at REPUTATION.neutral. */
export function reputationFactor(state: SimState): number {
  return Math.max(0.2, state.reputation / REPUTATION.neutral);
}
