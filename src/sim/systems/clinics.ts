/**
 * Outpatient clinics (GAME_DESIGN §5.1). Each resident consultant or
 * registrar of a specialty with clinics has a number of weekly clinic
 * sessions in their job plan; this works out which half-days they fall on.
 */
import { SESSION_ORDER, type SessionHalf } from "@data/outpatients";
import type { Staff } from "../agents";
import type { SimState } from "../state";
import { WEEKDAY_NAMES } from "../time";
import { runsClinics } from "./staffing";

export interface SessionSlot {
  /** 0 Monday … 4 Friday. */
  weekday: number;
  half: SessionHalf;
}

/**
 * The half-days a clinician's clinics fall on each week. Their colleagues of
 * the same specialty hired before them fill the earlier half-days, so a
 * team's clinics spread across the week rather than all wanting the same
 * rooms at once.
 */
export function jobPlan(state: SimState, s: Staff): SessionSlot[] {
  if (!runsClinics(s) || s.clinicSessions === 0) return [];
  let before = 0;
  for (const o of Object.values(state.staff)) {
    if (o.id < s.id && o.specialty === s.specialty && runsClinics(o)) before += o.clinicSessions;
  }
  const out: SessionSlot[] = [];
  for (let i = 0; i < s.clinicSessions; i++) {
    out.push(SESSION_ORDER[(before + i) % SESSION_ORDER.length]!);
  }
  return out.sort((a, b) => a.weekday - b.weekday || (a.half === "am" ? -1 : 1));
}

/** "Mon morning, Wed afternoon". */
export function describeJobPlan(slots: readonly SessionSlot[]): string {
  return slots
    .map((s) => `${WEEKDAY_NAMES[s.weekday]} ${s.half === "am" ? "morning" : "afternoon"}`)
    .join(", ");
}
