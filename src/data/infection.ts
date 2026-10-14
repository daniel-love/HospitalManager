/**
 * Norovirus outbreaks (GAME_DESIGN §9). The winter vomiting bug is the
 * commonest cause of ward closures in English hospitals: it comes in with
 * patients and visitors while it's going round the community, spreads
 * fast in shared bays, and puts staff off sick. systems/outbreaks.ts runs
 * it. Rates are per hour.
 */
export const NOROVIRUS = {
  /** Hours from catching it to symptoms… */
  incubationHours: [12, 48] as [number, number],
  /** …and how long symptoms last. */
  symptomaticHours: [24, 72] as [number, number],
  /**
   * After symptoms stop they shed it a while longer, less infectiously, and
   * aren't discharged (nor a bay reopened) until this long symptom-free.
   */
  clearHours: 48,
  tailInfectivity: 0.3,
  /** Chance an hour each symptomatic patient infects each other patient in the same room. */
  roomSpread: 0.006,
  /** Chance an hour, per symptomatic patient, that it reaches a patient in another ward room (on staff hands, shared equipment). */
  wardSpread: 0.003,
  /** Chance an hour each member of staff working in a room with a case catches it. */
  staffCatch: 0.006,
  /** Staff are off for their symptoms and 48 hours after. */
  staffOffHours: [72, 96] as [number, number],
  /** A case alone in a side room spreads this much as much (isolation). */
  isolation: 0.15,
  /** Enhanced infection control (a policy): spread this much as much… */
  enhancedControl: 0.5,
  /** …at this much a day per occupied inpatient bed (cleaning, PPE, audits). */
  enhancedCostPerBedDay: 8,
  /**
   * While it's going round the community (the norovirus season, at full
   * intensity): chance a new admission is already incubating it, and that a
   * visit brings it in, by visiting policy.
   */
  admissionSeed: 0.02,
  visitSeed: { open: 0.004, set: 0.003, restricted: 0.0015, none: 0 },
  /** Out of season, now and then anyway. */
  sporadicSeed: 0.002,
  /** Symptomatic patients' mood falls this much faster an hour. */
  moodPerHour: 4,
  /** The infection control team closes a room with this many symptomatic cases at once… */
  closeAtCases: 2,
  /** …and reopens it, after a deep clean, this long after its last case is clear. */
  reopenAfterHours: 48,
};
