/**
 * Outpatient clinics (GAME_DESIGN §5.1, ROADMAP M4 step 6). Each specialty's
 * own numbers (referral rates, slot lengths, tariffs) are in specialties.ts.
 */

/** Clinic session times, in minutes after midnight, Monday to Friday. */
export const CLINIC_SESSIONS = {
  am: { start: 9 * 60, end: 13 * 60 },
  pm: { start: 13 * 60 + 30, end: 17 * 60 + 30 },
} as const;
export type SessionHalf = keyof typeof CLINIC_SESSIONS;

/**
 * Most clinic sessions a week in a job plan. A full-time NHS consultant's
 * job plan is ten sessions, some of them ward rounds, theatre lists, on-call
 * and admin, so six clinics is a heavy outpatient week.
 */
export const MAX_CLINIC_SESSIONS = 6;
/** Most theatre lists a week in a job plan. */
export const MAX_THEATRE_SESSIONS = 4;
/** Most clinics and lists together: a ten-session job plan keeps some for other work. */
export const MAX_FIXED_SESSIONS = 8;

/**
 * The half-days a job plan's clinics fall on, in the order they're added,
 * spread across the week. Each clinician starts further along the list than
 * the colleagues of their specialty hired before them, so a team's clinics
 * don't all clash for the same rooms.
 */
export const SESSION_ORDER: readonly { weekday: number; half: SessionHalf }[] = [
  { weekday: 0, half: "am" },
  { weekday: 2, half: "am" },
  { weekday: 1, half: "pm" },
  { weekday: 3, half: "pm" },
  { weekday: 4, half: "am" },
  { weekday: 0, half: "pm" },
  { weekday: 2, half: "pm" },
  { weekday: 1, half: "am" },
  { weekday: 3, half: "am" },
  { weekday: 4, half: "pm" },
];

/** The 18-week referral-to-treatment standard, in days. */
export const RTT_TARGET_DAYS = 18 * 7;
/** Urgent (suspected cancer) referrals should be seen within this many days. */
export const URGENT_TARGET_DAYS = 14;
