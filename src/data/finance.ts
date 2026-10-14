/**
 * Borrowing, ratings and grants (GAME_DESIGN §8.1). All amounts in £.
 *
 * NHS and Hybrid trusts borrow from the Department of Health and Social
 * Care at the National Loans Fund rate: capital loans for building, and
 * revenue support loans when cash runs out, which come with oversight. A
 * Private Hospital borrows from a bank, at a rate set by its credit rating.
 */

export const LOANS = {
  /** DHSC lending: the National Loans Fund rate, about 4.5% (2025). */
  dhscRate: 0.045,
  capital: {
    min: 100_000,
    /** Most capital loans outstanding at once. */
    maxOutstanding: 6_000_000,
    termYears: [5, 25] as const,
  },
  revenueSupport: {
    termYears: 3,
    /** An automatic loan brings cash back up to this. */
    floor: 250_000,
  },
  bank: {
    /** Bank of England base rate plus the lender's margin, before the credit spread. */
    base: 0.05,
    min: 100_000,
    termYears: [1, 10] as const,
    /** Most a bank lends: this many months of income, or `floor` for a new hospital. */
    incomeMonths: 6,
    floor: 1_500_000,
  },
};

/** Private credit ratings, best first, and the spread each adds to the bank rate. */
export const CREDIT_RATINGS = [
  { id: "AAA", spread: 0.008 },
  { id: "AA", spread: 0.012 },
  { id: "A", spread: 0.018 },
  { id: "BBB", spread: 0.028 },
  { id: "BB", spread: 0.045 },
  { id: "B", spread: 0.07 },
  { id: "CCC", spread: 0.11 },
] as const;
/** A new Private Hospital's rating (an index into CREDIT_RATINGS). */
export const START_CREDIT = 3;
/** Missed repayments outstanding at once that put a Private Hospital into administration. */
export const ADMINISTRATION_MISSES = 3;

/**
 * NHS oversight segments (the NHS Oversight Framework), 1 best to 4, reviewed
 * each month from the finances: segment 3 trusts can't take new capital
 * loans; segment 4 is the Recovery Support Programme, with financial
 * special measures (no agency staff, building spend capped).
 */
export const OVERSIGHT = {
  start: 2,
  /** Cash in hand, in days of running costs, for segments 1 and 2. */
  cashDays: [30, 15] as const,
  /** A deficit over this share of income (with too little cash) is segment 3, then 4. */
  deficitShare: [0.02, 0.05] as const,
  /** Financial special measures: most that can be spent on building in a month. */
  specialMeasuresCapitalCap: 100_000,
};

/**
 * What a grant asks for. Targets for rooms and beds are on top of what the
 * hospital had when the grant was offered; weekly figures are over the last
 * seven days, and shares over the last seven days' departures or the lists.
 */
export type GrantCondition =
  /** More working rooms of a type. */
  | { kind: "rooms"; room: string; add: number }
  /** More inpatient beds on wards and in side rooms. */
  | { kind: "beds"; add: number }
  /** A working CT Room with a radiographer on staff. */
  | { kind: "ct" }
  /** Planned operations in the last week. */
  | { kind: "operations"; perWeek: number }
  /** Outpatient appointments attended in the last week. */
  | { kind: "appointments"; perWeek: number }
  /** The 4-hour standard over the last week. */
  | { kind: "fourHour"; atLeast: number }
  /** No 12-hour trolley waits for a ward bed in the last two weeks. */
  | { kind: "noTrolleyWaits" }
  /** NHS patients waiting under 18 weeks. */
  | { kind: "rtt"; atLeast: number }
  /** Average staff morale. */
  | { kind: "morale"; atLeast: number }
  /** Private income in the last week. */
  | { kind: "privateIncome"; perWeek: number };

export interface GrantDef {
  id: string;
  name: string;
  /** Who's offering it. */
  funder: string;
  funding: ("nhs" | "private" | "hybrid")[];
  amount: number;
  /** Weeks to meet the condition. */
  weeks: number;
  condition: GrantCondition;
  description: string;
}

/**
 * Grants and investment on offer from time to time, at random among those
 * that fit the hospital (systems/grants.ts decides which do). Met by the
 * deadline, the money is kept; missed, it's clawed back.
 */
export const GRANTS: GrantDef[] = [
  {
    id: "cdc",
    name: "Community Diagnostic Centre",
    funder: "NHS England",
    funding: ["nhs", "hybrid"],
    amount: 600_000,
    weeks: 12,
    condition: { kind: "ct" },
    description:
      "Capital to bring scanning closer to patients: towards a CT scanner and its shielded room.",
  },
  {
    id: "elective_hub",
    name: "Elective surgical hub",
    funder: "NHS England",
    funding: ["nhs", "hybrid"],
    amount: 800_000,
    weeks: 16,
    condition: { kind: "operations", perWeek: 15 },
    description:
      "Capital for protected planned surgery, kept apart from emergency pressures, to bring waiting lists down.",
  },
  {
    id: "uec_capacity",
    name: "Urgent and emergency care capacity",
    funder: "DHSC",
    funding: ["nhs", "hybrid"],
    amount: 500_000,
    weeks: 10,
    condition: { kind: "rooms", room: "majors_bay", add: 2 },
    description: "Winter capital for more A&E capacity: at least two more Majors Bays.",
  },
  {
    id: "winter_beds",
    name: "Winter beds",
    funder: "DHSC",
    funding: ["nhs", "hybrid"],
    amount: 400_000,
    weeks: 10,
    condition: { kind: "beds", add: 6 },
    description: "Capital for six more inpatient beds before winter, to ease exit block from A&E.",
  },
  {
    id: "four_hour",
    name: "A&E improvement funding",
    funder: "NHS England",
    funding: ["nhs", "hybrid"],
    amount: 350_000,
    weeks: 8,
    condition: { kind: "fourHour", atLeast: 0.78 },
    description:
      "Funding tied to getting 78% of A&E patients seen and admitted or discharged within 4 hours.",
  },
  {
    id: "sdec",
    name: "Same-day emergency care",
    funder: "NHS England",
    funding: ["nhs", "hybrid"],
    amount: 300_000,
    weeks: 8,
    condition: { kind: "noTrolleyWaits" },
    description:
      "Funding to stop long waits for a bed: no 12-hour trolley waits for a fortnight by the deadline.",
  },
  {
    id: "elective_recovery",
    name: "Elective recovery fund",
    funder: "NHS England",
    funding: ["nhs", "hybrid"],
    amount: 300_000,
    weeks: 16,
    condition: { kind: "rtt", atLeast: 0.75 },
    description: "Funding to bring waits down: 75% of NHS patients waiting under 18 weeks.",
  },
  {
    id: "outpatients",
    name: "Outpatient transformation",
    funder: "NHS England",
    funding: ["nhs", "hybrid", "private"],
    amount: 250_000,
    weeks: 12,
    condition: { kind: "appointments", perWeek: 60 },
    description: "Funding for more outpatient capacity: 60 appointments a week.",
  },
  {
    id: "retention",
    name: "Staff retention fund",
    funder: "NHS England",
    funding: ["nhs", "hybrid"],
    amount: 150_000,
    weeks: 8,
    condition: { kind: "morale", atLeast: 70 },
    description: "Funding tied to keeping staff: average morale of 70 or more.",
  },
  {
    id: "investor_growth",
    name: "Growth capital",
    funder: "Investors",
    funding: ["private"],
    amount: 1_000_000,
    weeks: 16,
    condition: { kind: "privateIncome", perWeek: 60_000 },
    description:
      "An investor's injection, on condition private income reaches £60,000 a week; otherwise they want it back.",
  },
  {
    id: "investor_theatres",
    name: "Surgical expansion",
    funder: "Investors",
    funding: ["private"],
    amount: 750_000,
    weeks: 16,
    condition: { kind: "operations", perWeek: 12 },
    description: "Investment in surgery, on condition the hospital does 12 operations a week.",
  },
  {
    id: "investor_beds",
    name: "Inpatient rooms",
    funder: "Investors",
    funding: ["private"],
    amount: 400_000,
    weeks: 10,
    condition: { kind: "rooms", room: "side_room", add: 3 },
    description: "Investment in three more private rooms for inpatients.",
  },
];

export const GRANT_OFFERS = {
  /** Days between offers, at random. */
  everyDays: [21, 42] as const,
  /** Days an offer stays open. */
  openDays: 14,
  /** Most grants taken on at once. */
  maxActive: 2,
  /** Reputation for meeting a grant's condition, and lost for missing it. */
  reputationMet: 2,
  reputationMissed: 3,
};
