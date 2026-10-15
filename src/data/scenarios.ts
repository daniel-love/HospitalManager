/**
 * Scenarios (GAME_DESIGN §9, §2.3): a starting point, a funding model and
 * budget, scripted events, objectives to win, ways to lose, and locks on
 * rooms or equipment until something's achieved. systems/scenarios.ts runs
 * them. Days are game days (1 = Monday 1 April, Year 1).
 */
import type { CqcRating } from "./cqc";
import type { EventFrequency, PressureEventId } from "./pressure";

export type ScenarioId = "ae_before_winter" | "major_incident" | "private_that_pays";

/** What has to be done. Each has a deadline (or window) and is met, pending or failed. */
export type ObjectiveDef =
  | {
      id: string;
      kind: "ae_open";
      /** Patients leaving A&E over the last 7 days, and the rooms that must be working. */
      departures7d: number;
      rooms: string[];
      by: number;
    }
  | {
      id: string;
      kind: "four_hour";
      /** The share leaving A&E within 4 hours over these days, inclusive. */
      atLeast: number;
      from: number;
      to: number;
    }
  | { id: string; kind: "monthly_surplus"; atLeast: number; by: number }
  | { id: string; kind: "reputation"; atLeast: number; by: number }
  | { id: string; kind: "no_unexpected_deaths"; from: number; to: number }
  | {
      id: string;
      /** No major incident casualty (major trauma or serious injury) dies, up to this day. */
      kind: "no_casualty_deaths";
      to: number;
    }
  | {
      id: string;
      kind: "trauma_transfers";
      /** Every major incident casualty with major trauma on their way to the trauma centre within this many hours. */
      withinHours: number;
      to: number;
    };

/** An event the scenario sets off: forecast on one day, starting on another (at an hour). */
export interface ScriptedEvent {
  event: PressureEventId;
  announceDay: number;
  startDay: number;
  startHour: number;
}

/** Rooms or equipment locked until a condition is met. */
export interface LockDef {
  id: string;
  /** Room type ids and equipment ids. */
  items: string[];
  /** Why, and how to unlock, for the build menu. */
  reason: string;
  /** Unlocked when an objective is met, or with a CQC rating at least this good. */
  unlock: { objective: string } | { cqcAtLeast: CqcRating };
}

export interface ScenarioDef {
  id: ScenarioId;
  name: string;
  /** One line, for the list. */
  summary: string;
  /** The briefing, a paragraph each. */
  briefing: string[];
  funding: "nhs" | "private" | "hybrid";
  money: number;
  catchment: number;
  /** The day it begins. */
  startDay: number;
  /** A pre-built hospital to start from (scenarios/maps), or a blank site. */
  start: "blank" | "district_hospital";
  /** Random events on top of the script. */
  eventFrequency: EventFrequency;
  script: ScriptedEvent[];
  objectives: (ObjectiveDef & { text: string })[];
  locks: LockDef[];
  /** The day it's over: won if every objective is met by then. */
  endDay: number;
}

/** Day numbers for dates in Year 1 (1 April is day 1). */
const D = {
  aug1: 123,
  aug15: 137,
  oct1: 184,
  nov24: 238,
  dec1: 245,
  dec18: 262,
  dec22: 266,
  jan15: 290,
  jan18: 293,
  feb28: 334,
  mar1: 335,
};

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "ae_before_winter",
    name: "Open an A&E before winter",
    summary:
      "A new town needs an emergency department. You have from August to open one, then winter to prove it can cope.",
    briefing: [
      "The local A&E closed last year and patients from this town now travel 30 miles. The integrated care board has given you a site and £3.5M to open an emergency department before winter.",
      "Open it by 1 October: Minors, Majors, Resus and an Ambulance Bay, with at least 100 patients through it in a week. The CT Room is held back until then.",
      "Then get through winter. From 1 December to the end of February, at least 78% of patients must leave A&E within 4 hours. Flu is expected from December, social care will struggle over Christmas, and the Health Secretary plans a visit in January.",
    ],
    funding: "nhs",
    money: 3_500_000,
    catchment: 80_000,
    startDay: D.aug1,
    start: "blank",
    eventFrequency: "rare",
    script: [
      { event: "heatwave", announceDay: D.aug15 - 2, startDay: D.aug15, startHour: 8 },
      { event: "winter_surge", announceDay: D.nov24, startDay: D.dec1, startHour: 8 },
      { event: "social_care_crisis", announceDay: D.dec18, startDay: D.dec22, startHour: 8 },
      { event: "vip_visit", announceDay: D.jan15, startDay: D.jan18, startHour: 10 },
    ],
    objectives: [
      {
        id: "open",
        kind: "ae_open",
        departures7d: 100,
        rooms: ["minors_cubicle", "majors_bay", "resus_bay", "ambulance_bay"],
        by: D.oct1,
        text: "Open A&E by 1 October: Minors, Majors, Resus and an Ambulance Bay working, and 100 patients through it in a week",
      },
      {
        id: "winter",
        kind: "four_hour",
        atLeast: 0.78,
        from: D.dec1,
        to: D.feb28,
        text: "From 1 December to 28 February, 78% leaving A&E within 4 hours",
      },
    ],
    locks: [
      {
        id: "ct",
        items: ["ct_room", "ct_scanner"],
        reason: "The CT Room is funded once A&E is open",
        unlock: { objective: "open" },
      },
    ],
    endDay: D.mar1,
  },
  {
    id: "major_incident",
    name: "Survive a major incident",
    summary:
      "A district hospital already stretched by a doctors' strike, and the ambulance service is about to call.",
    briefing: [
      "You run a small district general hospital: A&E with Resus, diagnostics, a medical ward, outpatients and a surgical block. Resident doctors have given notice of a strike from next Monday, and consultants will have to cover.",
      "Intelligence suggests trouble: be ready for a major incident during the strike. When it comes, decide whether to declare one (Hospital → Events).",
      "To win: no critically or seriously injured casualty dies, every critically injured one is on their way to the major trauma centre within 4 hours of arriving, and A&E gets back to 60% within 4 hours over the following week. Resus space, CT and porters will matter: you have a week to prepare.",
    ],
    funding: "nhs",
    money: 1_500_000,
    catchment: 40_000,
    startDay: 1,
    start: "district_hospital",
    eventFrequency: "off",
    script: [
      { event: "strike_resident_doctors", announceDay: 1, startDay: 8, startHour: 7 },
      { event: "major_incident", announceDay: 9, startDay: 9, startHour: 14 },
    ],
    objectives: [
      {
        id: "no_deaths",
        kind: "no_casualty_deaths",
        to: 12,
        text: "No critically or seriously injured casualty dies",
      },
      {
        id: "trauma",
        kind: "trauma_transfers",
        withinHours: 4,
        to: 12,
        text: "Every critically injured casualty on the way to the major trauma centre within 4 hours",
      },
      {
        id: "recover",
        kind: "four_hour",
        atLeast: 0.6,
        from: 13,
        to: 19,
        text: "The week after, 60% leaving A&E within 4 hours",
      },
    ],
    locks: [],
    endDay: 20,
  },
  {
    id: "private_that_pays",
    name: "A Private Hospital that pays",
    summary:
      "Investors have bought a site for a private hospital. Make it pay, and make its name, within 18 months.",
    briefing: [
      "A healthcare group has bought a site and given you £3.5M to build a private hospital: clinics, day surgery and operations, no A&E. Consultants work under practising privileges, bringing their own patients.",
      "Within 18 months, by the end of September next year, file a month with a surplus of £75,000 or more, and build a reputation of 75.",
      "The CT Room is held back until a CQC inspection rates you Good. Go into administration and it's over.",
    ],
    funding: "private",
    money: 3_500_000,
    catchment: 80_000,
    startDay: 1,
    start: "blank",
    eventFrequency: "realistic",
    script: [],
    objectives: [
      {
        id: "surplus",
        kind: "monthly_surplus",
        atLeast: 75_000,
        by: 548,
        text: "A month with a surplus of £75,000 or more, by 30 September next year",
      },
      {
        id: "reputation",
        kind: "reputation",
        atLeast: 75,
        by: 548,
        text: "A reputation of 75, by 30 September next year",
      },
    ],
    locks: [
      {
        id: "ct",
        items: ["ct_room", "ct_scanner"],
        reason: "Investors fund a CT scanner once CQC rates you Good",
        unlock: { cqcAtLeast: "good" },
      },
    ],
    endDay: 549,
  },
];

export const scenarioById = new Map(SCENARIOS.map((s) => [s.id, s]));

/** Ways a sandbox game (with fail states on) or a scenario can be lost. */
export const FAIL = {
  /** An NHS trust this many days in oversight segment 4 (financial special measures). */
  segment4Days: 90,
  /** Two Inadequate CQC ratings in a row. */
  inadequateInARow: 2,
};
