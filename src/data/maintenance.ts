/**
 * Equipment wear, breakdowns and repairs, and standby power
 * (systems/maintenance.ts). An item's `reliability` is its chance a day of
 * not breaking down when maintained; wear changes that.
 */
export const MAINTENANCE = {
  /** Wear (0–100) gained a day just from age… */
  wearPerDay: 0.3,
  /** …and an hour while in use (someone on the bed, a scan running). */
  wearPerHourInUse: 0.08,
  /**
   * Breakdowns: the rated chance, times this at no wear, rising by `perWear`
   * for each point (so 1× at 25 wear, 2× at 75, 2.5× at 100).
   */
  wearFactorAtZero: 0.5,
  perWear: 0.02,
  /** Engineers do planned preventive maintenance on items this worn… */
  ppmFrom: 40,
  /** …which leaves them at no wear; a repair leaves them at this much. */
  wearAfterRepair: 20,
  /** Minutes to repair, by the item's price: small kit, mid-range, big imaging. */
  repairMins: {
    small: [20, 40] as [number, number],
    medium: [45, 90] as [number, number],
    large: [180, 360] as [number, number],
  },
  /** Price bands for the above, £. */
  mediumFrom: 2_000,
  largeFrom: 20_000,
  /** Maintenance takes this share of a repair's time. */
  ppmShare: 0.5,
  /** Spare parts for a repair, as a share of the item's price. */
  partsShare: 0.05,
};

/** Standby generators (systems/maintenance.ts). */
export const POWER = {
  /** Powered items one generator keeps running. */
  itemsPerGenerator: 40,
  /**
   * Rooms on the essential supply by default, in the order the generators
   * cover them; the player can add or remove rooms. The rest are on the
   * non-essential supply, covered only if there's capacity left.
   */
  essential: [
    "resus_bay",
    "theatre",
    "recovery",
    "majors_bay",
    "ward",
    "side_room",
    "lab",
    "ct_room",
    "xray_room",
    "mortuary",
    "minors_cubicle",
    "triage_room",
    "day_surgery_unit",
  ],
};
