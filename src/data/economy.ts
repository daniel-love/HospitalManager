/** Money balance knobs. All amounts in £. */

/**
 * Sandbox starting cash until funding models arrive in M5. A fully equipped
 * starter A&E (reception, waiting, triage, minors, 3 majors, resus, staff
 * room, toilets) costs about £650k, leaving room for staffing costs.
 */
export const STARTING_CASH = 1_500_000;

/**
 * Fraction of the purchase price returned when something is removed
 * (equipment resale, salvaged building materials).
 */
export const RESALE_FRACTION = 0.5;

/** Equipment upkeep is quoted per month; charged hourly on this basis. */
export const DAYS_PER_MONTH = 365 / 12;
