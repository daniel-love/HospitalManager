/**
 * Death in hospital (GAME_DESIGN §5.6): the realistic UK process, never
 * graphic. Times are in-game minutes unless noted.
 */

/**
 * Chance a resuscitation attempt restarts the heart (return of spontaneous
 * circulation), if the doctor-led team starts at once. In-hospital arrests:
 * about half get ROSC, a fifth to a quarter survive to go home. Every minute
 * before the team leader arrives lowers it.
 */
export const ROSC_CHANCE = 0.45;
export const ROSC_LOSS_PER_MIN = 0.02;
export const ROSC_MIN_CHANCE = 0.05;
/** When the hospital's arrest team has to take over (no A&E doctor came). */
export const ROSC_CHANCE_ARREST_TEAM = 0.1;

/** Verifying a death (a doctor or trained nurse; the time is recorded). */
export const VERIFY_MINS: [number, number] = [10, 15];
/** A senior clinician breaking the news to the family. */
export const BREAK_NEWS_MINS: [number, number] = [30, 60];
/** Last offices: two nurses preparing the body, with the bay closed. */
export const LAST_OFFICES_MINS: [number, number] = [45, 75];
/** The bay's deep clean before it's used again. */
export const DEEP_CLEAN_MINS: [number, number] = [30, 45];
/** The team's hot debrief after a resuscitation attempt. */
export const DEBRIEF_MINS: [number, number] = [5, 10];
/** The Medical Examiner's review of the notes and the death certificate. */
export const ME_REVIEW_MINS: [number, number] = [30, 45];
/**
 * Medical Examiners are consultants who do it as a part-time duty, in
 * sessions in office hours, Monday to Friday (hours, 24-hour clock). Out of
 * hours, deaths wait for the next session, as they do in real hospitals.
 */
export const ME_SESSION = { startHour: 9, endHour: 17 };

/**
 * With no mortuary space, the hospital's contingency arrangement (an external
 * body store, via the funeral director) takes them after this many hours.
 */
export const CONTINGENCY_HOURS = 6;

/** Deceased patients each mortuary fridge unit holds. */
export const BODIES_PER_FRIDGE = 3;
/** After the review, the funeral director collects within this many hours. */
export const RELEASE_HOURS: [number, number] = [12, 36];
/** Share of unexpected deaths referred to the coroner, and how long that holds the body (days). */
export const CORONER_REFERRAL_CHANCE = 0.6;
export const CORONER_DAYS: [number, number] = [2, 5];

/** Morale lost by each member of staff involved (0–100 scale), and the baseline it recovers to. */
export const MORALE_START = 75;
export const MORALE_HIT_UNEXPECTED = 12;
export const MORALE_HIT_EXPECTED = 4;
/** Every staff nurse feels an unexpected death in the department a little. */
export const MORALE_HIT_TEAM = 2;
export const MORALE_RECOVERY_PER_HOUR = 0.5;
