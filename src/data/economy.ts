/** Money balance knobs. All amounts in £. */

/**
 * Sandbox starting cash: the capital to build a first hospital, until
 * funding models and loans arrive (M5 steps 4 and 5). Measured 2026-10-10
 * (`npm run balance`): with rotas, a lean but safe A&E with a small ward
 * runs at a loss (about £4k a day at an 80k catchment), as A&E does; a whole
 * small hospital (A&E, diagnostics, 14 beds, two clinic rooms, two theatres:
 * about £3.3M to build) about breaks even or better once its planned care
 * gets going. £3.5M builds that, or an A&E to grow from with a few months'
 * running costs in hand.
 */
export const STARTING_CASH = 3_500_000;

/**
 * NHS funding (GAME_DESIGN §2.2), modelled on the NHS payment scheme's
 * aligned payment and incentive: urgent and emergency care is mostly paid
 * by a fixed block contract, sized to the emergency care the hospital is
 * equipped to provide for its catchment, with each emergency patient
 * earning a share of the tariff on top (the marginal rate); planned care
 * (outpatients, elective operations) is paid in full per patient.
 */
export const NHS_FUNDING = {
  /** Share of the expected value of emergency care paid as the block. */
  blockShare: 0.7,
  /**
   * Sizing the contract to the rooms there are to treat patients in: a
   * patient keeps their room about this many times as long as they're
   * being treated in it, waiting between steps and for results (3 to 4
   * hours in a department for about an hour of hands-on care)…
   */
  roomOccupancyPerTreatment: 3,
  /** …and a room can be in use about this share of the day. */
  roomUtilisation: 0.85,
  /**
   * Commissioners won't keep paying for activity that isn't delivered: the
   * block is at most this multiple of the emergency care actually done
   * (at full tariff) over the last `activityDays` days…
   */
  activityTolerance: 1.2,
  activityDays: 28,
  /** …once there's this many days of it to go on. */
  activityGraceDays: 7,
};

/**
 * Running costs beyond pay and equipment upkeep, which make up about a
 * third of an NHS trust's spending.
 */
export const RUNNING_COSTS = {
  /**
   * Drugs and clinical supplies, as a share of each treated episode's full
   * tariff (about a fifth of NHS acute spending).
   */
  suppliesShare: 0.18,
  /** Outpatient appointments use far fewer. */
  outpatientSuppliesShare: 0.05,
  /**
   * Estates and utilities a year for each tile of floor built: maintenance,
   * energy, water and business rates at about £200 per m² (NHS ERIC
   * returns, leaving out the cleaning and portering you staff yourself),
   * with a tile about 1.33 m² (a 16 m² consulting room is 3 × 4 tiles).
   */
  estatesPerTileYear: 270,
};

/**
 * Fraction of the purchase price returned when something is removed
 * (equipment resale, salvaged building materials).
 */
export const RESALE_FRACTION = 0.5;

/** Equipment upkeep is quoted per month; charged hourly on this basis. */
export const DAYS_PER_MONTH = 365 / 12;
