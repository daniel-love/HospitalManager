/**
 * Patient flow balance: demand, how long the fixed steps take, needs, mood
 * and leaving without being seen. Times are in-game minutes.
 */

/**
 * Walk-in A&E attendances per day at the default "realism" setting: about a
 * third of a typical district general hospital's 200+ attendances, of which
 * roughly 70% walk in (GAME_DESIGN §2.4).
 */
export const WALK_INS_PER_DAY = 50;
/**
 * Share of walk-ins who come by bus; the rest walk, are dropped off or park,
 * and arrive along the pavement. Most UK A&E walk-ins come by car.
 */
export const WALK_IN_BY_BUS = 0.2;

/**
 * Ambulance arrivals per day at the default "realism" setting: about a third
 * of a typical district general hospital's ~65 conveyances a day.
 */
export const AMBULANCES_PER_DAY = 22;

/**
 * Relative ambulance arrivals per hour, midnight first: flatter than walk-ins,
 * peaking late morning to early afternoon.
 */
export const AMBULANCES_BY_HOUR = [
  2.8, 2.4, 2.1, 1.9, 1.8, 1.9, 2.3, 3.2, 4.3, 5.2, 5.6, 5.7, 5.6, 5.4, 5.2, 5.0, 4.9, 4.8, 4.6,
  4.4, 4.1, 3.8, 3.4, 3.1,
];

/**
 * Ambulance handover: the national standard is 15 minutes from arrival to the
 * crew handing over to A&E staff. Over 30 is a breach; over 60 is severe.
 */
export const HANDOVER_TARGET_MINS = 15;
export const HANDOVER_MINS: [number, number] = [8, 15];
/** After handover, the crew cleans and restocks before the ambulance leaves its bay. */
/**
 * Ambulance driving speed on site, in tiles per tick: about 15 mph, slowed by
 * the same factor as walking (see PATIENT_SPEED).
 */
export const AMBULANCE_SPEED = 2;
export const AMBULANCE_TURNAROUND_MINS: [number, number] = [5, 15];

/**
 * Relative walk-in arrivals per hour of the day, midnight first. Quiet
 * overnight, rising from 8am, busiest late morning to early evening (NHS
 * A&E attendance profile).
 */
export const ARRIVALS_BY_HOUR = [
  2.2, 1.7, 1.4, 1.1, 1.0, 1.0, 1.3, 2.2, 3.8, 5.3, 6.0, 6.1, 5.9, 5.7, 5.5, 5.4, 5.4, 5.6, 5.6,
  5.3, 4.8, 4.2, 3.4, 2.7,
];

/**
 * Manchester Triage: the longest a patient in each category should wait from
 * arrival to being seen by a clinician, and its colour. Index = category.
 */
export const TRIAGE_CATEGORIES = [
  null,
  { name: "Immediate", targetMins: 0, colour: 0xd8343a },
  { name: "Very urgent", targetMins: 10, colour: 0xf08a24 },
  { name: "Urgent", targetMins: 60, colour: 0xf2d13a },
  { name: "Standard", targetMins: 120, colour: 0x4cbb5a },
  { name: "Non-urgent", targetMins: 240, colour: 0x4a8fe0 },
] as const;

/** Initial assessment (triage) should start within this many minutes of arrival. */
export const TRIAGE_TARGET_MINS = 15;
/** The 4-hour standard: arrival to leaving A&E. */
export const FOUR_HOUR_MINS = 240;

export const BOOKING_MINS: [number, number] = [2, 4];
export const TRIAGE_MINS: [number, number] = [8, 12];
export const TOILET_MINS: [number, number] = [3, 6];
/** Wiping down a cubicle between patients. */
export const CUBICLE_CLEAN_MINS: [number, number] = [5, 10];
export const TOILET_CLEAN_MINS: [number, number] = [8, 12];
/** Uses before a toilet is posted for cleaning. */
export const TOILET_USES_BEFORE_CLEAN = 8;

/**
 * Walking speeds in tiles (metres) per tick. Real walking is ~1.2 m/s (7 tiles
 * a tick), but the clock runs 60× real time at 1×, so true speed would look
 * like teleporting. These are slowed for readability, to about 5 and 7 m per
 * in-game minute (5–7 tiles a real second at 1×); the extra time stands in for
 * the real overheads of a move (being called, gathering belongings, handover).
 */
export const PATIENT_SPEED = 0.5;
export const STAFF_SPEED = 0.7;

/** Starting mood (0–100) is random in this range: patience varies. */
export const START_MOOD: [number, number] = [60, 90];
/** Mood lost per hour while waiting to be seen. */
export const MOOD_DECAY_SEATED = 6;
export const MOOD_DECAY_STANDING = 12;
/** Extra mood loss per hour when they badly need the toilet and can't go. */
export const MOOD_DECAY_TOILET = 12;
/** Mood lost per hour waiting in a cubicle between steps (they're being seen). */
export const MOOD_DECAY_IN_CUBICLE = 3;

/** Below this mood, patients start to consider leaving. */
export const LWBS_MOOD = 25;
/** Per-minute chance of leaving at mood 0 (scaled down towards LWBS_MOOD). */
export const LWBS_MAX_CHANCE_PER_MIN = 0.02;
/** Sicker patients are less likely to give up. Index = triage category; 0 = not yet triaged. */
export const LWBS_ACUITY_FACTOR = [1, 0.1, 0.2, 0.5, 0.9, 1.1];

/** Bladder fills from 0 to 100 over roughly this many hours (randomised ±30%). */
export const BLADDER_HOURS = 3;
/** Patients head for the toilet above this level, and suffer above 90. */
export const TOILET_URGE = 70;

/** The doctor's review before a ward patient goes home. */
export const WARD_DISCHARGE_MINS: [number, number] = [10, 20];
/** Making a ward bed up for the next patient (more than wiping a cubicle). */
export const BED_CLEAN_MINS: [number, number] = [15, 25];
