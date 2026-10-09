/**
 * Monitoring, deterioration and cardiac arrest balance (GAME_DESIGN §5.6,
 * §7). Times are in-game minutes.
 */

/** How far a nurse at a station can watch a bed from, in tiles (metres). */
export const STATION_SIGHT_RANGE = 12;

/**
 * A central monitoring station only covers a monitored bed a nurse can walk
 * to quickly when its alarm sounds: within this many tiles (metres) of path.
 */
export const MONITOR_RESPONSE_DISTANCE = 25;

/** Minutes between observations on a ward (NEWS2 0–4: at least every 4–6 hours). */
export const WARD_OBS_EVERY_MINS = 240;

/** Minutes between observations, by the condition's monitoring need. */
export const OBS_EVERY_MINS = { periodic: 60, continuous: 30 } as const;
/** A set of observations (BP, pulse, SpO₂, temperature, respiratory rate, alertness). */
export const OBS_MINS: [number, number] = [5, 8];

/**
 * Spotting a deteriorating patient buys time: the nurse starts oxygen and
 * fluids and escalates to a doctor. If the doctor's treatment (the
 * stabilising step) still hasn't happened this long after, they collapse.
 */
export const ESCALATION_GRACE_MINS = 60;

/** A resuscitation attempt (crash call): the team is tied up for this long. */
export const RESUS_MINS: [number, number] = [20, 40];
/**
 * If no A&E doctor reaches a cardiac arrest within this long, the hospital's
 * cardiac arrest team (from the wards) takes over.
 */
export const RESUS_WAIT_LIMIT_MINS = 15;

/**
 * NEWS2 (National Early Warning Score) shown at each set of observations:
 * a stable patient scores about BASE; a deteriorating one climbs towards
 * PEAK as they near collapse. 5+ needs an urgent review, 7+ an emergency one.
 */
export const NEWS_BASE = 1;
export const NEWS_PEAK = 11;
export const NEWS_URGENT = 5;

/** Incident records kept (oldest dropped first). */
export const MAX_INCIDENTS = 100;
