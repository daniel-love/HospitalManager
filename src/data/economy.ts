/** Money balance knobs. All amounts in £. */

/**
 * Sandbox starting cash until funding models arrive in M5. Measured
 * 2026-10-09: a working A&E (reception, triage, 2 minors cubicles, 3 majors
 * bays, resus, an ambulance bay, X-ray and a lab) costs about £1.26M, most
 * of it foundations (£1,200/tile). CT (£650k) and a ward big enough for the
 * catchment (25–30 beds, about £350k) have to be paid for from the surplus.
 */
export const STARTING_CASH = 1_500_000;

/**
 * Fraction of the purchase price returned when something is removed
 * (equipment resale, salvaged building materials).
 */
export const RESALE_FRACTION = 0.5;

/** Equipment upkeep is quoted per month; charged hourly on this basis. */
export const DAYS_PER_MONTH = 365 / 12;
