/**
 * Patient flow balance: demand, how long the fixed steps take, needs, mood
 * and leaving without being seen. Times are in-game minutes.
 */

/**
 * Walk-in attendances at a major (type 1) A&E per 100,000 people in the
 * catchment, per day. England sees about 0.3 type 1 attendances a person a
 * year, roughly three-quarters of them walking in (GAME_DESIGN §2.4).
 */
export const WALK_INS_PER_100K = 60;

/** Ambulance conveyances to A&E per 100,000 people per day (England: about 0.08 a person a year). */
export const AMBULANCES_PER_100K = 22;

/** The population the hospital serves (sandbox setting): sets walk-in and ambulance demand. */
export const CATCHMENTS = [
  { id: "rural", name: "Rural", population: 40_000 },
  { id: "small_town", name: "Small town", population: 80_000 },
  { id: "town", name: "Town", population: 150_000 },
  { id: "city", name: "City", population: 300_000 },
] as const;
export const DEFAULT_CATCHMENT = 80_000;

/**
 * Ambulance control sends new conveyances to a neighbouring hospital once
 * this many crews are queueing outside with nowhere to park.
 */
export const DEFLECT_AT_QUEUE = 3;
/**
 * Walk-ins with a condition this hospital can't treat (say, chest pain with
 * no Majors Bay) mostly know to go to another A&E, but this share turn up
 * here anyway and have to be transferred out, as at an urgent treatment
 * centre. Ambulance control never brings them.
 */
export const UNTREATABLE_WALK_IN_SHARE = 0.25;

/**
 * Transfers to another hospital (GAME_DESIGN §5.1). A doctor assesses the
 * patient and arranges it with the receiving hospital; then they wait for an
 * inter-hospital ambulance, sooner for the sickest (triage category 1–2).
 * A&E pays for the ambulance.
 */
export const ARRANGE_TRANSFER_MINS: [number, number] = [15, 30];
export const TRANSFER_AMBULANCE_MINS: [number, number] = [60, 240];
export const URGENT_TRANSFER_AMBULANCE_MINS: [number, number] = [30, 90];
export const TRANSFER_COST = 400;
/**
 * A doctor decides to transfer a patient once their next step has been
 * waiting this long with nowhere in the hospital it can happen.
 */
export const TRANSFER_DECISION_MINS = 30;

/**
 * Share of walk-ins who come by bus; the rest walk, are dropped off or park,
 * and arrive along the pavement. Most UK A&E walk-ins come by car.
 */
export const WALK_IN_BY_BUS = 0.2;

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
/**
 * Mood regained in one go when care moves on: being triaged, first seen by a
 * clinician, each treatment step done, and a decision (admit or go home).
 * Being acknowledged and kept informed is what lifts patient experience.
 */
export const MOOD_LIFT_TRIAGED = 5;
export const MOOD_LIFT_SEEN = 10;
export const MOOD_LIFT_STEP = 4;
export const MOOD_LIFT_DECISION = 10;
/** Mood regained per hour while a clinician is with them. */
export const MOOD_RECOVERY_BEING_SEEN = 12;
/** Mood regained per hour settled in a ward bed. */
export const MOOD_RECOVERY_ON_WARD = 6;

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

/**
 * A specialty registrar or consultant's review of a patient referred from
 * A&E: history, examination, results, and the decision to admit.
 */
export const REFERRAL_MINS: [number, number] = [20, 40];
/** The doctor's review before a ward patient goes home. */
export const WARD_DISCHARGE_MINS: [number, number] = [10, 20];
/** Making a ward bed up for the next patient (more than wiping a cubicle). */
export const BED_CLEAN_MINS: [number, number] = [15, 25];
