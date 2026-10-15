/**
 * Care Quality Commission inspections (GAME_DESIGN §10), as CQC rates NHS
 * and independent hospitals: five key questions, each Outstanding, Good,
 * Requires Improvement or Inadequate, aggregated to an overall rating by
 * CQC's rules. systems/inspections.ts runs them.
 */

/** Worst first, so a higher index is better. */
export const RATINGS = ["inadequate", "requires_improvement", "good", "outstanding"] as const;
export type CqcRating = (typeof RATINGS)[number];

export const RATING_NAMES: Record<CqcRating, string> = {
  outstanding: "Outstanding",
  good: "Good",
  requires_improvement: "Requires Improvement",
  inadequate: "Inadequate",
};

export const KEY_QUESTIONS = ["safe", "effective", "caring", "responsive", "well_led"] as const;
export type KeyQuestion = (typeof KEY_QUESTIONS)[number];

export const KEY_QUESTION_NAMES: Record<KeyQuestion, string> = {
  safe: "Safe",
  effective: "Effective",
  caring: "Caring",
  responsive: "Responsive",
  well_led: "Well-led",
};

/** What each asks, as CQC puts it. */
export const KEY_QUESTION_TEXT: Record<KeyQuestion, string> = {
  safe: "Are people protected from abuse and avoidable harm?",
  effective: "Does care achieve good outcomes, based on the best evidence?",
  caring: "Do staff treat people with compassion, kindness, dignity and respect?",
  responsive: "Are services organised so they meet people's needs, without long waits?",
  well_led: "Does leadership make sure the hospital delivers high-quality care, sustainably?",
};

export const CQC = {
  /** Days into the game of the first inspection (unannounced). */
  firstInspectionDays: [60, 120] as [number, number],
  /** Days until the next one, by the current rating: compressed from CQC's years. */
  nextAfterDays: {
    inadequate: 90,
    requires_improvement: 180,
    good: 365,
    outstanding: 540,
  } as Record<CqcRating, number>,
  /**
   * Concerns bring inspectors early: over the last 30 days, this many
   * unexpected deaths, complaints or safety incidents…
   */
  concerns: { unexpectedDeaths: 3, complaints: 6, incidents: 15 },
  /** …and they come within this many days (not again for 60 days). */
  responsiveDays: [7, 21] as [number, number],
  /** The inspection team: how many walk round, from when to when, and how long in each room. */
  team: 3,
  fromHour: 9,
  toHour: 17,
  roomsEach: 6,
  dwellMins: [20, 40] as [number, number],
  /** The report is published this many days after the visit. */
  reportDays: 7,
  /** A key question's score (0–100) for each rating. */
  thresholds: { outstanding: 80, good: 60, requires_improvement: 40 },
  /** How much of a key question's score comes from the data, against what they saw. */
  dataWeight: 0.65,
  /** Reputation moves this much when a rating is published. */
  reputation: { outstanding: 8, good: 3, requires_improvement: -5, inadequate: -12 } as Record<
    CqcRating,
    number
  >,
  /** Days of data inspectors look at. */
  dataDays: 90,
};

/** VIP and media visits (systems/inspections.ts): who might come, and how much it matters. */
export const VIP = {
  visitors: [
    "The Secretary of State for Health",
    "A member of the Royal Family",
    "A BBC News crew",
    "The local MP",
    "The regional director of NHS England",
  ],
  /** Rooms they see, and how long in each. */
  rooms: 3,
  dwellMins: [15, 25] as [number, number],
  /** Reputation for a visit with nothing amiss, and off for each thing they see that's wrong. */
  goodVisit: 5,
  perProblem: 2,
  worst: -8,
};
