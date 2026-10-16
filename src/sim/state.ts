/**
 * SimState is the whole simulation as plain, serialisable data: no class
 * instances, no Pixi objects, no functions. It doubles as the save schema
 * (see save/codec.ts), except for fields marked "derived", which are rebuilt
 * after loading.
 */
import { REPUTATION, STARTING_CASH } from "@data/economy";
import { GRANT_OFFERS, OVERSIGHT, START_CREDIT } from "@data/finance";
import type { EventFrequency, PressureEventId } from "@data/pressure";
import { CSI, type CsiRating, type KeyQuestion } from "@data/csi";
import type { ScenarioId } from "@data/scenarios";
import type { SpecialtyId } from "@data/schema";
import { DEFAULT_CATCHMENT } from "@data/patients";
import {
  type Ambulance,
  type Collection,
  type Operation,
  type Outpatient,
  type Referral,
  emptyFlows,
  emptyLedger,
  emptyServices,
  type ServiceLedgers,
  emptyStats,
  type DayReport,
  type FlowStats,
  type Incident,
  type Job,
  type Grant,
  type Ledger,
  type Loan,
  type MonthReport,
  type Patient,
  type SimEvent,
  type Staff,
  type TourAgent,
  type Visitor,
} from "./agents";
import type { PlanEntry } from "./plan";
import { createRng, type RngState } from "./rng";
import { dateOf, TICKS_PER_DAY } from "./time";
import { createFloorGrid, type FloorGrid } from "./world/grid";
import type { Rect } from "./world/rect";
import { layOutSite, type Site } from "./world/site";

export const SIM_STATE_VERSION = 52;

/** Quarter turns clockwise. */
export type Rotation = 0 | 1 | 2 | 3;

/** A placed piece of equipment or a door. Covers every tile of its footprint. */
export interface PlacedObject {
  id: number;
  defId: string;
  floor: number;
  /** Top-left tile of the rotated footprint. */
  x: number;
  y: number;
  rotation: Rotation;
}

export interface RoomCheck {
  label: string;
  ok: boolean;
  /** Extra detail, e.g. "4 of 6". */
  detail?: string;
  /** Advice only: the room still works if it isn't met. */
  advisory?: boolean;
}

/** A detected room: a connected area of one zone type, bounded by walls and doors. */
/** Who a Waiting Area is for: A&E patients, or outpatients booked into a clinic. */
export type WaitingFor = "ae" | "outpatients";
export const WAITING_FOR: readonly WaitingFor[] = ["ae", "outpatients"];

export interface Room {
  /** Matches FloorGrid.roomId. Reassigned whenever rooms are re-detected. */
  id: number;
  floor: number;
  typeId: string;
  /** Tile indices into the floor grid. */
  tiles: number[];
  bounds: Rect;
  /** Objects wholly inside the room. */
  objectIds: number[];
  capabilities: string[];
  checks: RoomCheck[];
  valid: boolean;
  /** Wards and clinic rooms: the specialty it's for (see SimState.roomSpecialties), or null for any. */
  specialty: SpecialtyId | null;
  /** Operating theatres: kept for emergencies (see SimState.emergencyTheatres). */
  emergency: boolean;
  /** Hybrid trusts: part of the Private Patient Unit (see SimState.privateRooms). */
  private: boolean;
  /** Wards and side rooms: closed to admissions in an outbreak (see SimState.closedRooms). */
  closed: boolean;
  /** On the essential supply: the standby generators cover it first (see SimState.essentialRooms). */
  essential: boolean;
  /** Waiting areas: who may wait here (see SimState.waitingAreas), or null for anyone. */
  waitingFor: WaitingFor | null;
  /**
   * Advisory: equipment some conditions need here, beyond being valid
   * (e.g. an ECG for chest pain). Doesn't affect `valid`.
   */
  forConditions: RoomCheck[];
}

/** A lift car: where it is, what it's doing, and who's in it. */
export interface LiftCar {
  floor: number;
  /** idle: waiting for a call; doors: open, people getting on and off; moving: to `target`. */
  phase: "idle" | "doors" | "moving";
  target: number;
  /** Tick the doors close or it arrives. */
  until: number;
  /** Agents in the car, by id. */
  riders: number[];
}

export interface SimState {
  version: number;
  /** The hospital's name, chosen (or made up) when the game starts and renamable in Settings. */
  name: string;
  seed: number;
  rng: RngState;
  /** Ticks elapsed since the game started. */
  tick: number;
  /** Cash in £. Can't go below zero through building. */
  money: number;
  /** One grid per floor; index 0 is the ground floor. */
  floors: FloorGrid[];
  /** The public road and pavements (world/site.ts); null on a blank map. */
  site: Site | null;
  /** Keyed by object id. */
  objects: Record<number, PlacedObject>;
  nextObjectId: number;
  /** Build plan (blueprint) not yet built or paid for. See plan.ts. */
  plan: PlanEntry[];
  /** Bumped by every layout change, so agents know to re-plan their routes. */
  layoutVersion: number;

  patients: Record<number, Patient>;
  staff: Record<number, Staff>;
  /** Shared id sequence for patients and staff. */
  nextAgentId: number;
  jobs: Record<number, Job>;
  nextJobId: number;
  /** Ambulances parked or waiting outside, keyed by id. */
  ambulances: Record<number, Ambulance>;
  nextAmbulanceId: number;
  /** Funeral directors collecting from the mortuary, keyed by id. */
  collections: Record<number, Collection>;
  nextCollectionId: number;
  /**
   * Outpatient waiting lists (systems/referrals.ts): GP referrals waiting
   * for a first appointment, follow-ups, and patients waiting for surgery.
   */
  referrals: Record<number, Referral>;
  nextReferralId: number;
  /**
   * Specialties whose clinics have opened and been given the waiting list
   * they inherit (systems/referrals.ts seedWaitingList).
   */
  inheritedLists: SpecialtyId[];
  /** People in for an outpatient appointment today, keyed by id (agent ids). */
  outpatients: Record<number, Outpatient>;
  /** Relatives and friends visiting ward patients, keyed by id (agent ids). */
  visitors: Record<number, Visitor>;
  /** Operations under way, keyed by id (systems/theatres.ts). */
  operations: Record<number, Operation>;
  nextOperationId: number;
  /**
   * Who has claimed what: "objectId:slot" → agent id. Slots are seats on a
   * bench, 0 for a couch or toilet, "staff" for the staff side of a desk.
   */
  reserved: Record<string, number>;
  /** Uses since last cleaned, by object id (couches and toilets). */
  dirt: Record<number, number>;
  /**
   * Wards and clinic rooms given to a specialty, keyed "floor:tile" by one of their
   * tiles. Room ids change whenever rooms are re-detected, so the setting
   * is pinned to a tile and found again from it (detectRooms).
   */
  roomSpecialties: Record<string, SpecialtyId>;
  /** Operating theatres kept for emergencies, pinned to a tile like roomSpecialties. */
  emergencyTheatres: Record<string, true>;
  /** Hybrid trusts: rooms in the Private Patient Unit, pinned to a tile like roomSpecialties. */
  privateRooms: Record<string, true>;
  /**
   * Inpatient rooms closed to admissions in an outbreak, keyed like
   * privateRooms: when, and by the infection control team or the player
   * (systems/outbreaks.ts).
   */
  closedRooms: Record<string, { since: number; by: "ipc" | "player" }>;
  /** Lift cars, by their portal's key (systems/portals.ts). */
  lifts: Record<string, LiftCar>;
  /**
   * Rooms put on or taken off the essential supply, against their type's
   * default (data/maintenance.ts POWER), keyed like privateRooms.
   */
  essentialRooms: Record<string, boolean>;
  /** Waiting Areas kept for one group of patients, pinned to a tile like roomSpecialties. */
  waitingAreas: Record<string, WaitingFor>;
  /**
   * Equipment that can break down: how worn (0–100) and, if it's broken,
   * since when, by object id (systems/maintenance.ts). Items not listed are
   * new and working.
   */
  maintenance: Record<number, { wear: number; broken: number | null }>;
  /** Each department's status (GAME_DESIGN §8.3): open, or less than fully open. */
  departments: Departments;
  /** How the hospital is funded (GAME_DESIGN §2.2), chosen when the game starts. */
  funding: Funding;
  /** 0–100: what patients and GPs think of the hospital (systems/reputation.ts). */
  reputation: number;
  /**
   * Cover levels (systems/rota.ts): how many of each rota group the player
   * wants on each day and night shift, keyed by group ("nurse",
   * "registrar:cardiology"). Groups with none set share shifts out evenly.
   */
  cover: Record<string, Cover>;
  /** Hospital policies (GAME_DESIGN §8.4). */
  policies: Policies;

  /** Money and patient flow so far today, and reports for past days (newest last). */
  today: { ledger: Ledger; stats: FlowStats; services: ServiceLedgers };
  history: DayReport[];
  /**
   * The monthly financial statement: this month so far (filed days only),
   * and past months (newest last). See systems/finance.ts closeMonth.
   */
  month: MonthReport;
  months: MonthReport[];
  /** Loans outstanding (systems/loans.ts). */
  loans: Loan[];
  nextLoanId: number;
  /** How lenders and regulators see the hospital's finances (systems/loans.ts). */
  rating: Rating;
  /** A grant on offer, those taken on, and those finished (systems/grants.ts). */
  grants: {
    offer: Grant | null;
    active: Grant[];
    /** When the next offer comes. */
    nextOffer: number;
    /** Finished grants, newest last: met (kept) or missed (clawed back). */
    done: { defId: string; tick: number; met: boolean }[];
  };
  /** A scenario's objectives, or a sandbox game's fail states (systems/scenarios.ts). */
  goals: Goals;
  /** CSI inspections and ratings, and VIP visits (systems/inspections.ts). */
  csi: Csi;
  /** Inspectors and VIPs touring the hospital, keyed by id (agent ids). */
  tours: Record<number, TourAgent>;
  /** Applicants for posts, with recruitment on (systems/recruitment.ts). */
  applicants: Applicant[];
  nextApplicantId: number;
  /** Pressure events: forecast or under way, and past ones, newest last (systems/pressure.ts). */
  pressure: {
    active: PressureEvent[];
    past: { defId: PressureEventId; start: number; end: number }[];
    nextId: number;
    /** The financial year (0 = Year 1) staff were last vaccinated against flu, or null. */
    vaccinated: number | null;
    /** A major incident on standby or under way, or null. */
    majorIncident: MajorIncident | null;
  };
  settings: SimSettings;
  /** Tick each kind of warning was last raised, so they aren't repeated constantly. */
  alerts: Record<string, number>;
  /** Patient safety incidents, oldest first (capped; see MAX_INCIDENTS). */
  incidents: Incident[];
  nextIncidentId: number;

  /** Not saved: messages for the notifications feed, drained by the game each frame. */
  events: SimEvent[];
  /** Derived (not saved): rebuilt by detectRooms() after every layout change. */
  rooms: Room[];
  /** Derived (not saved): room id holding each object wholly inside a room. */
  objectRoom: Record<number, number>;
}

/** Sandbox difficulty knobs (GAME_DESIGN §2.4). */
export interface SimSettings {
  /** People the hospital serves (see data/patients.ts CATCHMENTS): sets demand. */
  catchment: number;
  /** Multiplies arrival rates on top of the catchment's: 1 = real-world per-person rates. */
  patientVolume: number;
  /**
   * Staff work shifts and rotas (systems/rota.ts). Off, everyone hired works
   * around the clock: saves from before rotas, and test fixtures.
   */
  rotas: boolean;
  /** How often pressure events come (data/pressure.ts EVENT_FREQUENCY). Off for test fixtures. */
  eventFrequency: EventFrequency;
  /** Hiring is from applicants (systems/recruitment.ts) rather than instant. Off for test fixtures. */
  recruitment: boolean;
  /** A sandbox game can be lost: bankruptcy, or Inadequate twice running (systems/scenarios.ts). */
  failStates: boolean;
}

/** Someone applying for a post (systems/recruitment.ts). */
export interface Applicant {
  id: number;
  /** The post: a role, "nurse:band6", or "consultant:cardiology". */
  key: string;
  skill: number;
  /** They take a job elsewhere at this tick. */
  until: number;
}

/** Something an inspector or VIP saw, good or bad, under one of CSI's key questions. */
export interface CsiFinding {
  question: KeyQuestion;
  good: boolean;
  text: string;
}

/** A published (or waiting to be published) inspection report. */
export interface CsiReport {
  visited: number;
  published: number;
  overall: CsiRating;
  questions: Record<KeyQuestion, { rating: CsiRating; score: number; evidence: string[] }>;
  findings: CsiFinding[];
}

/** Inspections and ratings (systems/inspections.ts). */
export interface Csi {
  /** The published ratings, or null before the first inspection. */
  overall: CsiRating | null;
  questions: Record<KeyQuestion, CsiRating> | null;
  /** When the next inspection is due (unannounced, from then on a weekday morning). */
  next: number;
  /** An inspection under way: when it started, and what they've seen. */
  visit: { started: number; findings: CsiFinding[] } | null;
  /** The report of the last visit, until it's published. */
  pending: CsiReport | null;
  /** Published reports, newest last. */
  reports: CsiReport[];
  /** Placed in special measures by an Inadequate rating, until re-rated better. */
  specialMeasures: boolean;
  /** When concerns last brought an inspection forward. */
  concernsAt: number | null;
  /** A VIP visit under way: who, and what they've seen. */
  vip: { eventId: number; who: string; findings: CsiFinding[] } | null;
}

/**
 * A scenario's progress, or (with no scenario) a sandbox game's fail states
 * (systems/scenarios.ts).
 */
export interface Goals {
  scenario: ScenarioId | null;
  /** Each objective: met, pending or failed, and a running tally (n of d). */
  objectives: Record<string, { status: "pending" | "met" | "failed"; n: number; d: number }>;
  /** Locks lifted. */
  unlocked: string[];
  /** Won or lost, and why; null while it's still going. */
  outcome: { won: boolean; text: string; tick: number } | null;
  /** Since when a PHS trust has been in oversight segment 4. */
  segment4Since: number | null;
  inadequateRun: number;
}

/** A major incident under way (systems/majorIncident.ts). */
export interface MajorIncident {
  /** The pressure event it belongs to. */
  eventId: number;
  /** What happened, e.g. "a train derailment". */
  cause: string;
  expected: number;
  arrived: number;
  /** Casualties still to come, soonest first. */
  casualties: { at: number; conditionId: string; channel: "walk_in" | "ambulance" }[];
  /** When the hospital declared its own major incident, or null. */
  declared: number | null;
  /** What declaring changed, to put back on standing down. */
  previous: {
    outpatients: Departments["outpatients"];
    theatres: Departments["theatres"];
    escalation: boolean;
  } | null;
  /** Off-duty staff asked to come in; those on their way, and those who've arrived. */
  asked: number;
  coming: { staffId: number; at: number }[];
  calledIn: number[];
  /** When the last casualty came, or null. */
  last: number | null;
}

/** A pressure event forecast or under way (systems/pressure.ts). */
export interface PressureEvent {
  id: number;
  defId: PressureEventId;
  /** When it was forecast, when it starts and when it ends. */
  announced: number;
  start: number;
  end: number;
}

/**
 * How rota gaps are filled at the start of a shift: not at all, from the
 * staff bank, or from the bank and then an agency (systems/workforce.ts).
 */
export type GapFill = "none" | "bank" | "bank_agency";

export interface Policies {
  gapFill: GapFill;
  /** Private care: the self-pay price level, as a multiple of the standard price (PRIVATE.priceLevels). */
  priceLevel: number;
  /** Private Hospitals: specialties taking PHS-funded referrals (patient choice), at tariff. */
  phsReferrals: Partial<Record<SpecialtyId, true>>;
  /** Escalation beds open: admitted patients with no ward bed go to escalation trolleys. */
  escalation: boolean;
  /** Ward patients fit to go home that day are reviewed in the morning. */
  dischargeBeforeNoon: boolean;
  /** When relatives may visit ward patients (systems/visitors.ts). */
  visiting: Visiting;
  /** Vaccinate staff against flu each autumn (data/pressure.ts FLU_VACCINATION). */
  fluVaccination: boolean;
  /** Enhanced infection control: halves norovirus spread, at a daily cost (data/infection.ts). */
  infectionControl: boolean;
  /** Who closes rooms in an outbreak: the infection control team, or the player. */
  outbreakClosures: "ipc" | "manual";
}

/**
 * Visiting hours: open (08:00–20:00), set hours (afternoon and evening),
 * restricted (one hour in the evening), or none (as in an outbreak).
 */
export type Visiting = "open" | "set" | "restricted" | "none";

/**
 * Department statuses (GAME_DESIGN §8.3), a crisis lever. A&E on divert
 * takes no ambulances (walk-ins still come); closed, it takes nobody.
 * Outpatients taking urgent referrals only turns routine GP referrals away;
 * closed, its clinics don't run. Theatres for emergencies only stand their
 * planned lists down; closed, they don't operate at all.
 */
export interface Departments {
  ae: "open" | "divert" | "closed";
  outpatients: "open" | "urgent" | "closed";
  theatres: "open" | "emergency" | "closed";
}

/**
 * A PHS trust's oversight segment (1 best to 4, financial special measures),
 * and a Private Hospital's credit rating (an index into CREDIT_RATINGS, 0
 * best) and administration. Each is reviewed monthly.
 */
export interface Rating {
  segment: number;
  credit: number;
  /** A Private Hospital in administration: when it went in. Null otherwise. */
  administration: number | null;
  /** A Private Hospital with cash below zero: since when. Null otherwise. */
  overdrawnSince: number | null;
}

/**
 * PHS Trust: PHS funding only. Private Hospital: private patients (and PHS
 * referrals it chooses to take), consultants with practising privileges, no
 * emergency department. Hybrid: a PHS trust with a Private Patient Unit.
 */
export type Funding = "phs" | "private" | "hybrid";

/** People wanted on each day shift and each night shift. */
export interface Cover {
  day: number;
  night: number;
}

export interface NewGameOptions {
  seed: number;
  /** The hospital's name (default "My hospital"). */
  name?: string;
  width?: number;
  height?: number;
  money?: number;
  /** Lay out the public road (world/site.ts). Off for blank test maps. */
  site?: boolean;
  /** Staff work shifts. Off for test maps, where everyone works around the clock. */
  rotas?: boolean;
  funding?: Funding;
  /** Pressure events. Off for test maps. */
  eventFrequency?: EventFrequency;
  /** Hiring from applicants. Off for test maps. */
  recruitment?: boolean;
  failStates?: boolean;
  /** The day the game begins (1 = 1 April, Year 1): a scenario may start later in the year. */
  startDay?: number;
  catchment?: number;
  patientVolume?: number;
}

export const DEFAULT_MAP_SIZE = 200;

/** A month with nothing in it yet, opening with `cash`. */
export function emptyMonth(monthIndex: number, cash: number): MonthReport {
  return {
    monthIndex,
    days: 0,
    ledger: emptyLedger(),
    stats: emptyStats(),
    openingCash: cash,
    closingCash: cash,
    flows: emptyFlows(),
    services: emptyServices(),
    end: { reputation: REPUTATION.start, rttWaiting: 0, rttWithin18w: 0, headcount: 0 },
  };
}

export function createSimState(opts: NewGameOptions): SimState {
  // A game can begin later in the year: tick 0 is still the first day's 08:00.
  const start = ((opts.startDay ?? 1) - 1) * TICKS_PER_DAY;
  const width = opts.width ?? DEFAULT_MAP_SIZE;
  const height = opts.height ?? DEFAULT_MAP_SIZE;
  const ground = createFloorGrid(width, height);
  return {
    version: SIM_STATE_VERSION,
    seed: opts.seed >>> 0,
    rng: createRng(opts.seed),
    tick: start,
    money: opts.money ?? STARTING_CASH,
    floors: [ground],
    site: opts.site ? layOutSite(ground) : null,
    objects: {},
    nextObjectId: 1,
    plan: [],
    layoutVersion: 0,
    patients: {},
    staff: {},
    nextAgentId: 1,
    jobs: {},
    nextJobId: 1,
    ambulances: {},
    nextAmbulanceId: 1,
    collections: {},
    referrals: {},
    nextReferralId: 1,
    inheritedLists: [],
    outpatients: {},
    visitors: {},
    operations: {},
    nextOperationId: 1,
    nextCollectionId: 1,
    reserved: {},
    dirt: {},
    roomSpecialties: {},
    emergencyTheatres: {},
    privateRooms: {},
    closedRooms: {},
    lifts: {},
    essentialRooms: {},
    waitingAreas: {},
    maintenance: {},
    departments: { ae: "open", outpatients: "open", theatres: "open" },
    name: opts.name ?? "My hospital",
    funding: opts.funding ?? "phs",
    reputation: REPUTATION.start,
    cover: {},
    policies: {
      gapFill: "bank",
      priceLevel: 1,
      phsReferrals: {},
      escalation: false,
      dischargeBeforeNoon: false,
      visiting: "set",
      fluVaccination: false,
      infectionControl: false,
      outbreakClosures: "ipc",
    },
    today: { ledger: emptyLedger(), stats: emptyStats(), services: emptyServices() },
    history: [],
    month: emptyMonth(dateOf(opts.startDay ?? 1).monthIndex, opts.money ?? STARTING_CASH),
    months: [],
    loans: [],
    nextLoanId: 1,
    rating: {
      segment: OVERSIGHT.start,
      credit: START_CREDIT,
      administration: null,
      overdrawnSince: null,
    },
    grants: {
      offer: null,
      active: [],
      nextOffer: start + GRANT_OFFERS.everyDays[0] * TICKS_PER_DAY,
      done: [],
    },
    pressure: { active: [], past: [], nextId: 1, vaccinated: null, majorIncident: null },
    csi: {
      overall: null,
      questions: null,
      // The first inspection comes in the first few months (systems/inspections.ts).
      next: start + CSI.firstInspectionDays[0] * TICKS_PER_DAY,
      visit: null,
      pending: null,
      reports: [],
      specialMeasures: false,
      concernsAt: null,
      vip: null,
    },
    tours: {},
    applicants: [],
    nextApplicantId: 1,
    settings: {
      catchment: opts.catchment ?? DEFAULT_CATCHMENT,
      patientVolume: opts.patientVolume ?? 1,
      rotas: opts.rotas ?? false,
      eventFrequency: opts.eventFrequency ?? "off",
      recruitment: opts.recruitment ?? false,
      failStates: opts.failStates ?? false,
    },
    goals: {
      scenario: null,
      objectives: {},
      unlocked: [],
      outcome: null,
      segment4Since: null,
      inadequateRun: 0,
    },
    alerts: {},
    incidents: [],
    nextIncidentId: 1,
    events: [],
    rooms: [],
    objectRoom: {},
  };
}
