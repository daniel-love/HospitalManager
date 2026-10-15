/**
 * Recruitment (GAME_DESIGN §10): applicants for each kind of post come in
 * over time, more of them and better with a good reputation and CSI
 * rating. systems/recruitment.ts runs it.
 */
import type { StaffRoleId } from "./schema";

/**
 * Applicants a week at a reputation of 60 and a Good rating, by rota group
 * key: a role, a nurse band ("nurse:band6"), or (for consultants and
 * registrars) any specialty, shared out among them. Hard-to-fill posts
 * (consultants, senior nurses) come slowly, as in UK hospitals.
 */
export const APPLICANTS_PER_WEEK: Record<string, number> = {
  "nurse:band5": 4,
  "nurse:band6": 1.5,
  "nurse:band7": 0.6,
  nurse_practitioner: 0.6,
  junior_doctor: 2,
  registrar: 0.6,
  consultant: 0.3,
  radiographer: 1,
  biomedical_scientist: 1,
  theatre_practitioner: 1.2,
  porter: 3,
  cleaner: 3,
  receptionist: 3,
  discharge_coordinator: 0.6,
  clinical_engineer: 0.5,
};

/** Roles hired into a specialty: their rate is per specialty. */
export const SPECIALIST_ROLES: StaffRoleId[] = ["consultant", "registrar"];

export const RECRUITMENT = {
  /** Applicants stay this many days before taking another job. */
  staysDays: 21,
  /** A new hospital's opening campaign: this many weeks' worth to start with (at least one each). */
  openingWeeks: 6,
  /** More apply with a better reputation: × reputation / this, within these bounds. */
  neutralReputation: 60,
  factorRange: [0.3, 1.6] as [number, number],
  /** …and with a better CSI rating. */
  ratingFactor: { outstanding: 1.3, good: 1, requires_improvement: 0.8, inadequate: 0.5 },
  /** Applicants' skill (0–100): this range, shifted by reputation and rating. */
  skill: [40, 80] as [number, number],
  skillPerReputation: 0.25,
  ratingSkill: { outstanding: 5, good: 0, requires_improvement: -4, inadequate: -8 },
};
