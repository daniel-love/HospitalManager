/**
 * Discharge from the wards (GAME_DESIGN §9, bed blocking), balanced on
 * England's: about one bed in eight is held by someone medically fit to
 * leave, mostly waiting for social care (a package of care at home, or a
 * care home place). systems/discharge.ts runs it.
 */

/**
 * Share of each condition's admissions who'll need social care to go home:
 * mostly older people after a fall, an infection or a breathing illness.
 * Anything not listed: `otherCareNeed`.
 */
export const CARE_NEED: Record<string, number> = {
  elderly_fall: 0.4,
  sepsis: 0.25,
  shortness_of_breath: 0.2,
  serious_injury: 0.15,
  broken_ankle: 0.1,
  chest_pain: 0.05,
};

export const DISCHARGE = {
  otherCareNeed: 0.03,
  /**
   * Days social care takes to put care in place once asked: at least
   * `min`, then a long tail (an exponential with this mean), up to `max`.
   */
  careDelayDays: { min: 1, mean: 3.5, max: 21 },
  /** Minutes a discharge coordinator (or a nurse) takes to plan a discharge needing care. */
  planningMins: [30, 45] as [number, number],
  /**
   * Hours from the decision to discharge to leaving: medicines to take home
   * from pharmacy, transport, a lift from family.
   */
  goHomeHours: [2, 4] as [number, number],
  /** The discharge lounge is staffed from 08:00 to 20:00. */
  loungeOpens: 8,
  loungeCloses: 20,
};
