/**
 * Recruitment (GAME_DESIGN §10): with the setting on, hiring is from
 * applicants rather than instant. For every kind of post (a role, a nurse
 * band, a consultant or registrar in a specialty) applicants come in over
 * time and stay a few weeks before taking a job elsewhere. More apply, and
 * more skilled, with a good reputation and CSI rating; few with a poor one.
 * Hiring takes the most skilled applicant there is. A new hospital opens
 * with a recruitment campaign's worth to choose from. Bank and agency staff
 * aren't affected.
 */
import { content } from "@data/catalogue";
import { APPLICANTS_PER_WEEK, RECRUITMENT, SPECIALIST_ROLES } from "@data/recruitment";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import { NURSE_BANDS, SKILL, type NurseBand } from "@data/staff";
import { nextFloat, nextInt } from "../rng";
import type { Applicant, SimState } from "../state";
import { TICKS_PER_DAY, TICKS_PER_MINUTE } from "../time";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/** Every kind of post applicants come for, as a key ("nurse:band6", "consultant:cardiology"). */
export function postKeys(): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(APPLICANTS_PER_WEEK)) {
    if (SPECIALIST_ROLES.includes(key as StaffRoleId)) {
      for (const sp of content.specialties) keys.push(`${key}:${sp.id}`);
    } else keys.push(key);
  }
  return keys;
}

/** The key for a post: a role, with a nurse's band or a doctor's specialty. */
export function postKey(
  role: StaffRoleId,
  band: NurseBand | null,
  specialty: SpecialtyId | null,
): string {
  if (role === "nurse") return `nurse:band${band ?? 5}`;
  if (SPECIALIST_ROLES.includes(role) && specialty) return `${role}:${specialty}`;
  return role;
}

const rateOf = (key: string) =>
  APPLICANTS_PER_WEEK[key] ?? APPLICANTS_PER_WEEK[key.split(":")[0]!] ?? 0;

/** How many more (or fewer) apply than at a neutral reputation and a Good rating. */
export function appealFactor(state: SimState): number {
  const [lo, hi] = RECRUITMENT.factorRange;
  const rep = Math.max(lo, Math.min(hi, state.reputation / RECRUITMENT.neutralReputation));
  const rating = state.csi.overall ? RECRUITMENT.ratingFactor[state.csi.overall] : 1;
  return rep * rating;
}

/** A new applicant for a post, with a skill shifted by reputation and rating. */
function newApplicant(state: SimState, key: string): Applicant {
  const band = key.startsWith("nurse:band") ? (Number(key.slice(10)) as NurseBand) : null;
  const [lo, hi] = band ? NURSE_BANDS.find((b) => b.band === band)!.skill : RECRUITMENT.skill;
  const shift =
    (state.reputation - RECRUITMENT.neutralReputation) * RECRUITMENT.skillPerReputation +
    (state.csi.overall ? RECRUITMENT.ratingSkill[state.csi.overall] : 0);
  const skill = Math.max(10, Math.min(SKILL.max, nextInt(state.rng, lo, hi) + Math.round(shift)));
  return {
    id: state.nextApplicantId++,
    key,
    skill,
    until: state.tick + RECRUITMENT.staysDays * TICKS_PER_DAY,
  };
}

/** A new hospital's recruitment campaign: a few weeks' worth of applicants for every post. */
export function openingCampaign(state: SimState): void {
  for (const key of postKeys()) {
    const n = Math.max(1, Math.round(rateOf(key) * RECRUITMENT.openingWeeks));
    for (let i = 0; i < n; i++) state.applicants.push(newApplicant(state, key));
  }
}

/** Each hour: applicants come in, and those who've waited long enough take jobs elsewhere. */
export function updateRecruitment(state: SimState): void {
  if (!state.settings.recruitment || state.tick % TICKS_PER_HOUR !== 0) return;
  state.applicants = state.applicants.filter((a) => a.until > state.tick);
  const factor = appealFactor(state);
  for (const key of postKeys()) {
    if (nextFloat(state.rng) < (rateOf(key) * factor) / (7 * 24)) {
      state.applicants.push(newApplicant(state, key));
    }
  }
}

/** The most skilled applicant for a post, if any. */
export function bestApplicant(state: SimState, key: string): Applicant | undefined {
  let best: Applicant | undefined;
  for (const a of state.applicants) if (a.key === key && (!best || a.skill > best.skill)) best = a;
  return best;
}

/** Hired: they're no longer applying. */
export function takeApplicant(state: SimState, a: Applicant): void {
  state.applicants = state.applicants.filter((x) => x !== a);
}

/** Days until the next applicant is likely for a post, on average. */
export function daysToNext(state: SimState, key: string): number | null {
  const perWeek = rateOf(key) * appealFactor(state);
  return perWeek <= 0 ? null : Math.max(1, Math.round(7 / perWeek));
}
